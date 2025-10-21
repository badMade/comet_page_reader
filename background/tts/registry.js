import createLogger from '../../utils/logger.js';

const logger = createLogger({ name: 'tts-registry' });

const registry = new Map();

function normaliseKey(key) {
  if (typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function validateAdapter(adapter, key) {
  if (!adapter || typeof adapter.synthesise !== 'function') {
    throw new Error(`TTS adapter for "${key}" must expose a synthesise function.`);
  }
}

export function registerTtsAdapter(key, adapter) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    throw new Error('TTS adapter key must be a non-empty string.');
  }
  validateAdapter(adapter, normalisedKey);
  registry.set(normalisedKey, adapter);
  logger.debug('TTS adapter registered.', { key: normalisedKey });
}

export function getTtsAdapter(key) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    return undefined;
  }
  return registry.get(normalisedKey);
}

export function hasTtsAdapter(key) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    return false;
  }
  return registry.has(normalisedKey);
}

export function clearTtsAdapters() {
  registry.clear();
  logger.debug('TTS adapter registry cleared.');
}

export const ttsAdapters = {
  register: registerTtsAdapter,
  get: getTtsAdapter,
  has: hasTtsAdapter,
  clear: clearTtsAdapters,
  keys() {
    return Array.from(registry.keys());
  },
};

