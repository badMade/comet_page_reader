/**
 * Shared placeholder adapter used for providers that currently require manual
 * integration. The helper raises descriptive errors while exposing cost
 * metadata consistent with the router.
 *
 * @module background/adapters/placeholder
 */

function normaliseModel(config, fallback) {
  return config?.model || fallback;
}

/**
 * Minimal adapter that throws descriptive errors for unimplemented providers.
 */
export class PlaceholderAdapter {
  /**
   * @param {string} providerKey - Identifier for the provider (e.g. `mistral`).
   * @param {object} config - Provider configuration block.
   */
  constructor(providerKey, config) {
    this.providerKey = providerKey;
    this.config = config;
    this.displayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
  }

  /**
   * Ensures an API key is present before constructing the placeholder error.
   *
   * @param {string} apiKey - Provider API key.
   */
  ensureKey(apiKey) {
    if (!apiKey) {
      throw new Error(`Missing ${this.displayName} API key.`);
    }
  }

  /**
   * Reports generic cost metadata used by the router to estimate spend.
   *
   * @returns {object} Cost metadata grouped by capability.
   */
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
    throw new Error(`${this.displayName} adapter placeholder. Expected synthesis request: ${JSON.stringify(payload)}`);
  }
}
