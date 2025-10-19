function normaliseModel(config, fallback) {
  return config?.model || fallback;
}

export class PlaceholderAdapter {
  constructor(providerKey, config) {
    this.providerKey = providerKey;
    this.config = config;
    this.displayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
  }

  ensureKey(apiKey) {
    if (!apiKey) {
      throw new Error(`Missing ${this.displayName} API key.`);
    }
  }

  getCostMetadata() {
    return {
      summarise: {
        model: normaliseModel(this.config, `${this.providerKey}-model`),
      },
      transcribe: {
        label: 'stt',
        flatCost: 0,
        model: `${this.providerKey}-stt`,
      },
      synthesise: {
        label: 'tts',
        flatCost: 0,
        model: `${this.providerKey}-tts`,
      },
    };
  }

  summarise({ apiKey, text, language }) {
    this.ensureKey(apiKey);
    const payload = {
      endpoint: this.config?.apiUrl || 'UNCONFIGURED',
      model: normaliseModel(this.config, `${this.providerKey}-chat`),
      temperature: typeof this.config?.temperature === 'number' ? this.config.temperature : undefined,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that creates short spoken summaries.' },
        { role: 'user', content: `Provide a concise summary in ${language}.` },
      ],
      textLength: text ? text.length : 0,
    };
    throw new Error(`${this.displayName} adapter placeholder. Expected request: ${JSON.stringify(payload)}`);
  }

  transcribe({ apiKey, mimeType }) {
    this.ensureKey(apiKey);
    const payload = {
      endpoint: this.config?.transcriptionUrl || 'UNCONFIGURED',
      model: `${this.providerKey}-transcribe`,
      mimeType,
    };
    throw new Error(`${this.displayName} adapter placeholder. Expected transcription request: ${JSON.stringify(payload)}`);
  }

  synthesise({ apiKey, format, voice }) {
    this.ensureKey(apiKey);
    const payload = {
      endpoint: this.config?.ttsUrl || 'UNCONFIGURED',
      model: `${this.providerKey}-tts`,
      format,
      voice,
    };
    throw new Error(`${this.displayName} adapter placeholder. Expected synthesis request: ${JSON.stringify(payload)}`);
  }
}
