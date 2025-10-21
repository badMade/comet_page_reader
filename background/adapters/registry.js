import createLogger from '../../utils/logger.js';
import { readApiKey } from '../../utils/apiKeyStore.js';
import { OpenAIAdapter } from './openai.js';
import { synthesise as synthesiseWithGoogle } from './googleTTS.js';
import { synthesise as synthesiseWithAmazonPolly } from './amazonPolly.js';
import { synthesise as synthesiseLocally } from './localTTS.js';

const logger = createLogger({ name: 'adapter-registry' });

const factories = new Map();

let openAiTtsAdapter = null;

function toBase64(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error('OpenAI TTS response did not include audio data.');
  }
  const bytes = new Uint8Array(arrayBuffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  throw new Error('Base64 encoding is not supported in this environment.');
}

function getOpenAiTtsAdapter() {
  if (!openAiTtsAdapter) {
    openAiTtsAdapter = new OpenAIAdapter({}, {
      logger: logger.child({ adapter: 'openai-tts-proxy' }),
    });
  }
  return openAiTtsAdapter;
}

async function synthesiseWithOpenAi({ text, voice, languageCode }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Text is required for speech synthesis.');
  }
  const apiKey = await readApiKey({ provider: 'openai' });
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured.');
  }
  const adapter = getOpenAiTtsAdapter();
  const response = await adapter.synthesise({
    apiKey,
    text,
    voice,
    format: 'mp3',
    languageCode,
  });
  const base64 = toBase64(response?.arrayBuffer);
  const mimeType = response?.mimeType || 'audio/mpeg';
  return { base64, mimeType };
}

/**
 * Registers an adapter factory for the specified provider key.
 *
 * @param {string} providerKey - Provider identifier.
 * @param {Function} factory - Factory returning an adapter instance.
 */
export function registerAdapter(providerKey, factory) {
  if (!providerKey || typeof providerKey !== 'string') {
    throw new Error('Provider key must be a non-empty string.');
  }
  if (typeof factory !== 'function') {
    throw new Error(`Adapter factory for ${providerKey} must be a function.`);
  }
  const normalisedKey = providerKey.toLowerCase();
  factories.set(normalisedKey, factory);
  logger.debug('Adapter registered.', { providerKey, normalisedKey });
}

/**
 * Retrieves a previously registered adapter factory.
 *
 * @param {string} providerKey - Provider identifier.
 * @returns {Function|undefined} Registered factory when available.
 */
export function getAdapterFactory(providerKey) {
  if (!providerKey) {
    return undefined;
  }
  const normalisedKey = providerKey.toLowerCase();
  const factory = factories.get(normalisedKey);
  if (!factory) {
    logger.warn('Adapter factory lookup failed.', { providerKey, normalisedKey });
    return undefined;
  }
  logger.trace('Adapter factory resolved.', { providerKey, normalisedKey });
  return factory;
}

/**
 * Instantiates an adapter for the given provider.
 *
 * @param {string} providerKey - Provider identifier.
 * @param {object} config - Provider configuration block forwarded to the factory.
 * @returns {object} Adapter instance.
 */
export function createAdapter(providerKey, config) {
  const factory = getAdapterFactory(providerKey);
  if (!factory) {
    throw new Error(`No adapter registered for provider: ${providerKey}`);
  }
  try {
    const instance = factory(config);
    logger.debug('Adapter instance created.', {
      providerKey,
      hasLogger: !!config?.logger,
    });
    return instance;
  } catch (error) {
    logger.error('Adapter instantiation failed.', { providerKey, error });
    throw error;
  }
}

/**
 * Lists all registered adapter keys. Useful for diagnostics and tests.
 *
 * @returns {string[]} Provider identifiers.
 */
export function listRegisteredAdapters() {
  const registered = Array.from(factories.keys());
  logger.trace('Listing registered adapters.', { count: registered.length });
  return registered;
}

const builtinTtsAdapters = {
  openai: { synthesise: synthesiseWithOpenAi },
  google: { synthesise: synthesiseWithGoogle },
  googletts: { synthesise: synthesiseWithGoogle },
  'google-tts': { synthesise: synthesiseWithGoogle },
  amazonpolly: { synthesise: synthesiseWithAmazonPolly },
  'amazon-polly': { synthesise: synthesiseWithAmazonPolly },
  polly: { synthesise: synthesiseWithAmazonPolly },
  local: { synthesise: synthesiseLocally },
  browser: { synthesise: synthesiseLocally },
};

Object.keys(builtinTtsAdapters).forEach(key => {
  const entry = builtinTtsAdapters[key];
  if (!entry || typeof entry.synthesise !== 'function') {
    throw new Error(`Invalid TTS adapter registration for key: ${key}`);
  }
});

export const ttsAdapters = Object.freeze({ ...builtinTtsAdapters });
