import createLogger from '../../utils/logger.js';

function normaliseModel(config, fallback) {
  return config?.model || fallback;
}

function normaliseVoiceList(config, providerKey) {
  const configured = Array.isArray(config?.voices)
    ? config.voices
    : config?.voiceOptions;
  const voices = Array.isArray(configured)
    ? configured
    : [`${providerKey}-voice`];
  const normalised = Array.from(new Set(voices
    .map(voice => (typeof voice === 'string' ? voice.trim() : ''))
    .filter(Boolean)));
  if (normalised.length === 0) {
    return [`${providerKey}-voice`];
  }
  return normalised;
}

function resolvePreferredVoice(voices, configPreferred) {
  if (configPreferred && voices.includes(configPreferred)) {
    return configPreferred;
  }
  return voices[0] || null;
}

/**
 * Minimal adapter that throws descriptive errors for unimplemented providers.
 */
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

  /**
   * Ensures an API key is present before constructing the placeholder error.
   *
   * @param {string} apiKey - Provider API key.
   */
  ensureKey(apiKey) {
    if (!apiKey) {
      this.logger.error('Missing API key when using placeholder adapter.', { providerKey: this.providerKey });
      throw new Error(`Missing ${this.displayName} API key.`);
    }
  }

  /**
   * Reports generic cost metadata used by the router to estimate spend.
   *
   * @returns {object} Cost metadata grouped by capability.
   */
  getCostMetadata() {
    const voices = normaliseVoiceList(this.config, this.providerKey);
    const preferredVoice = resolvePreferredVoice(voices, this.config?.preferredVoice);
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
        voices: {
          available: voices,
          preferred: preferredVoice,
        },
      },
    };
    this.logger.debug('Cost metadata requested from placeholder adapter.', {
      providerKey: this.providerKey,
      models: metadata,
    });
    return metadata;
  }

  /**
   * Provides the placeholder voice capabilities so the UI can display options.
   *
   * @returns {{availableVoices: string[], preferredVoice: string|null}}
   *   Voice capability descriptor.
   */
  getVoiceCapabilities() {
    const voices = normaliseVoiceList(this.config, this.providerKey);
    const preferredVoice = resolvePreferredVoice(voices, this.config?.preferredVoice);
    return {
      availableVoices: voices,
      preferredVoice,
    };
  }

  /**
   * Throws an error describing the expected summarisation payload for the
   * provider. Used while the integration is under development.
   *
   * @param {{apiKey: string, text: string, language: string}} params - Summary parameters.
   * @throws {Error} Always, with a payload description.
   */
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

  /**
   * Throws an error describing the expected transcription payload.
   *
   * @param {{apiKey: string, mimeType: string}} params - Transcription details.
   * @throws {Error} Always, with a payload description.
   */
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

  /**
   * Throws an error describing the expected speech synthesis payload.
   *
   * @param {{apiKey: string, format: string, voice: string}} params - Synthesis options.
   * @throws {Error} Always, with a payload description.
   */
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
