const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash-latest';
const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function ensureFetch(options) {
  if (options && typeof options.fetchImpl === 'function') {
    return options.fetchImpl;
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch API is not available in this environment.');
  }
  return (...args) => globalThis.fetch(...args);
}

function buildAiStudioEndpoint(baseUrl, model, apiKey) {
  const trimmedBase = (baseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
  const encodedModel = encodeURIComponent(model || DEFAULT_GEMINI_MODEL);
  const separator = trimmedBase.endsWith('/models') ? '' : '/models';
  const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
  return `${trimmedBase}${separator}/${encodedModel}:generateContent${query}`;
}

function buildVertexEndpoint({ baseUrl, project, location, model }) {
  const resolvedLocation = location || 'us-central1';
  const resolvedProject = project;
  if (!resolvedProject) {
    throw new Error('Gemini Vertex configuration missing project.');
  }
  const base = (baseUrl || '').replace('{project}', resolvedProject).replace('{location}', resolvedLocation);
  const trimmedBase = base.replace(/\/$/, '');
  const encodedModel = encodeURIComponent(model || DEFAULT_GEMINI_MODEL);
  const hasModels = trimmedBase.endsWith('/models');
  const modelsBase = hasModels ? trimmedBase : `${trimmedBase}/models`;
  return `${modelsBase}/${encodedModel}:generateContent`;
}

function extractSummary(data) {
  const candidate = Array.isArray(data?.candidates)
    ? data.candidates.find(item => Array.isArray(item?.content?.parts))
    : undefined;
  if (!candidate) {
    return '';
  }
  const parts = candidate.content.parts || [];
  const textParts = parts
    .map(part => (typeof part?.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean);
  return textParts.join('\n').trim();
}

function normaliseUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') {
    return {};
  }
  return {
    promptTokens: usageMetadata.promptTokenCount,
    completionTokens: usageMetadata.candidatesTokenCount ?? usageMetadata.totalTokenCount,
  };
}

export class GeminiAdapter {
  constructor(config, options = {}) {
    this.config = config || {};
    this.fetch = ensureFetch(options);
    this.headers = { 'Content-Type': 'application/json', ...(this.config.headers || {}) };
  }

  getCostMetadata() {
    const model = this.config.model || DEFAULT_GEMINI_MODEL;
    return {
      summarise: { model },
      transcribe: { label: 'stt', flatCost: 0, model: null },
      synthesise: { label: 'tts', flatCost: 0, model: null },
    };
  }

  async summarise({ apiKey, accessToken, project, location, endpoint, text, language, model }) {
    const modelToUse = model || this.config.model || DEFAULT_GEMINI_MODEL;
    const prompt = `Provide a concise, listener-friendly summary of the following webpage content. Use ${language} language.\n\n${text}`;
    let url;
    const headers = { ...this.headers };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      url = buildVertexEndpoint({
        baseUrl: endpoint || this.config.vertexEndpoint || this.config.apiUrl,
        project,
        location,
        model: modelToUse,
      });
    } else {
      if (!apiKey) {
        throw new Error('Missing Gemini API key.');
      }
      url = buildAiStudioEndpoint(this.config.apiUrl, modelToUse, apiKey);
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    };

    const generationConfig = {};
    if (typeof this.config.temperature === 'number' && Number.isFinite(this.config.temperature)) {
      generationConfig.temperature = this.config.temperature;
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let message;
      try {
        const errorBody = await response.text();
        message = errorBody || response.statusText;
      } catch (error) {
        message = response.statusText;
      }
      const error = new Error(`Gemini error (${response.status} ${response.statusText}): ${message}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const summary = extractSummary(data);
    const usage = normaliseUsage(data?.usageMetadata);

    return {
      summary,
      model: data?.model || modelToUse,
      promptTokens: typeof usage.promptTokens === 'number' ? usage.promptTokens : undefined,
      completionTokens: typeof usage.completionTokens === 'number' ? usage.completionTokens : undefined,
    };
  }

  async transcribe() {
    throw new Error('Gemini transcription is not supported.');
  }

  async synthesise() {
    throw new Error('Gemini speech synthesis is not supported.');
  }
}
