import createLogger from '../../utils/logger.js';

function normaliseModel(config, fallback) {
  return config?.model || fallback;
}

export class PlaceholderAdapter {
  constructor(providerKey, config, options = {}) {
    this.providerKey = providerKey;
    this.config = config;
    this.displayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
    const baseLogger = options.logger;
    if (baseLogger && typeof baseLogger.child === 'function') {
      this.logger = baseLogger.child({ implementation: 'placeholder', adapter: providerKey });
    } else if (baseLogger && typeof baseLogger.info === 'function') {
      this.logger = baseLogger;
      this.logger.extend?.({ implementation: 'placeholder', adapter: providerKey });
    } else {
      this.logger = createLogger({
        name: `adapter-${providerKey}-placeholder`,
        context: { adapter: providerKey, implementation: 'placeholder' },
      });
    }
    this.logger.warn('Placeholder adapter initialised. Real implementation unavailable.', {
      providerKey,
      hasConfig: !!config,
    });
  }

  ensureKey(apiKey) {
    if (!apiKey) {
      this.logger.error('Missing API key when using placeholder adapter.', { providerKey: this.providerKey });
      throw new Error(`Missing ${this.displayName} API key.`);
    }
  }

  getCostMetadata() {
    const metadata = {
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
    this.logger.debug('Cost metadata requested from placeholder adapter.', {
      providerKey: this.providerKey,
      models: metadata,
    });
    return metadata;
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
    this.logger.error('Placeholder adapter invoked for summarise.', {
      providerKey: this.providerKey,
      language,
      textLength: payload.textLength,
    });
    throw new Error(`${this.displayName} adapter placeholder. Expected request: ${JSON.stringify(payload)}`);
  }

  transcribe({ apiKey, mimeType }) {
    this.ensureKey(apiKey);
    const payload = {
      endpoint: this.config?.transcriptionUrl || 'UNCONFIGURED',
      model: `${this.providerKey}-transcribe`,
      mimeType,
    };
    this.logger.error('Placeholder adapter invoked for transcription.', {
      providerKey: this.providerKey,
      mimeType,
    });
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
    this.logger.error('Placeholder adapter invoked for synthesis.', {
      providerKey: this.providerKey,
      format,
      voice,
    });
    throw new Error(`${this.displayName} adapter placeholder. Expected synthesis request: ${JSON.stringify(payload)}`);
  }
}
