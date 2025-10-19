/**
 * Adapter encapsulating OpenAI API interactions for summarisation, speech
 * synthesis, and transcription.
 *
 * @module background/adapters/openai
 */

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';

function base64ToUint8Array(base64) {
  if (typeof Uint8Array.from === 'function' && typeof atob === 'function') {
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('Base64 conversion is not supported in this environment.');
}

/**
 * Provides helper methods for calling the OpenAI REST API.
 */
export class OpenAIAdapter {
  /**
   * @param {object} config - Provider configuration block.
   * @param {{fetchImpl?: Function}} [options={}] - Dependency overrides.
   */
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = (...args) => {
      if (options.fetchImpl) {
        return options.fetchImpl(...args);
      }
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('Fetch API is not available in this environment.');
      }
      return globalThis.fetch(...args);
    };
    this.chatUrl = config.apiUrl || 'https://api.openai.com/v1/chat/completions';
    this.transcriptionUrl = config.transcriptionUrl || 'https://api.openai.com/v1/audio/transcriptions';
    this.ttsUrl = config.ttsUrl || 'https://api.openai.com/v1/audio/speech';
  }

  /**
   * Declares the cost metadata used by the router when estimating spend.
   *
   * @returns {object} Cost metadata grouped by capability.
   */
  getCostMetadata() {
    return {
      summarise: {
        model: this.config.model || 'gpt-4o-mini',
      },
      transcribe: {
        label: 'stt',
        flatCost: 0.005,
        model: DEFAULT_TRANSCRIPTION_MODEL,
      },
      synthesise: {
        label: 'tts',
        flatCost: 0.01,
        model: DEFAULT_TTS_MODEL,
      },
    };
  }

  /**
   * Validates that an API key has been supplied before performing a request.
   *
   * @param {string} apiKey - OpenAI API key.
   */
  ensureKey(apiKey) {
    if (!apiKey) {
      throw new Error('Missing OpenAI API key.');
    }
  }

  /**
   * Constructs HTTP headers for OpenAI endpoints, merging configuration
   * overrides when present.
   *
   * @param {string} apiKey - OpenAI API key.
   * @param {object} [extra={}] - Additional headers to include.
   * @returns {object} Header map ready for fetch calls.
   */
  buildHeaders(apiKey, extra = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(this.config.headers || {}),
      ...extra,
    };
  }

  /**
   * Requests a textual summary from the OpenAI chat completions API.
   *
   * @param {{apiKey: string, text: string, language: string, model?: string}} params -
   *   Summarisation parameters.
   * @returns {Promise<{summary: string, model: string, promptTokens?: number, completionTokens?: number}>}
   *   Structured response payload.
   */
  async summarise({ apiKey, text, language, model }) {
    this.ensureKey(apiKey);
    const modelToUse = model || this.config.model || 'gpt-4o-mini';
    const prompt = `Provide a concise, listener-friendly summary of the following webpage content. Use ${language} language.\n\n${text}`;

    const response = await this.fetch(this.chatUrl, {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify({
        model: modelToUse,
        temperature: typeof this.config.temperature === 'number' ? this.config.temperature : 0.3,
        messages: [
          { role: 'system', content: 'You are a helpful assistant that creates short spoken summaries.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`OpenAI error (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    const summary = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content.trim()
      : '';

    return {
      summary,
      model: data.model || modelToUse,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    };
  }

  /**
   * Submits an audio payload for transcription using the OpenAI audio API.
   *
   * @param {{
   *   apiKey: string,
   *   base64: string,
   *   filename?: string,
   *   mimeType?: string,
   *   model?: string,
   * }} params - Transcription arguments.
   * @returns {Promise<{text: string}>} Transcription result.
   */
  async transcribe({ apiKey, base64, filename = 'speech.webm', mimeType = 'audio/webm', model = DEFAULT_TRANSCRIPTION_MODEL }) {
    this.ensureKey(apiKey);
    const formData = new FormData();
    const bytes = base64ToUint8Array(base64);
    const blob = new Blob([bytes], { type: mimeType });
    formData.append('file', blob, filename);
    formData.append('model', model);

    const response = await this.fetch(this.transcriptionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(this.config.headers || {}),
      },
      body: formData,
    });

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`Transcription failed (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    return {
      text: data.text,
    };
  }

  /**
   * Calls the OpenAI text-to-speech endpoint to generate an audio clip.
   *
   * @param {{
   *   apiKey: string,
   *   text: string,
   *   voice?: string,
   *   format?: string,
   *   model?: string,
   * }} params - Speech synthesis parameters.
   * @returns {Promise<{arrayBuffer: ArrayBuffer, mimeType: string}>} Synthesised audio payload.
   */
  async synthesise({ apiKey, text, voice = 'alloy', format = 'mp3', model = DEFAULT_TTS_MODEL }) {
    this.ensureKey(apiKey);
    const response = await this.fetch(this.ttsUrl, {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        voice,
        input: text,
        format,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`Speech synthesis failed (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }

    const mimeType = response.headers.get('content-type') || `audio/${format}`;
    const arrayBuffer = await response.arrayBuffer();
    return {
      arrayBuffer,
      mimeType,
    };
  }
}
