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

/**
 * Registers a text-to-speech adapter so it can be looked up by other modules.
 *
 * @param {string} key - Logical adapter identifier (for example `openai`).
 * @param {{ synthesise: (options: object) => Promise<object> }} adapter - Adapter implementation exposing
 *   a `synthesise` method.
 * @returns {void}
 */
export function registerTtsAdapter(key, adapter) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    throw new Error('TTS adapter key must be a non-empty string.');
  }
  validateAdapter(adapter, normalisedKey);
  registry.set(normalisedKey, adapter);
  logger.debug('TTS adapter registered.', { key: normalisedKey });
}

/**
 * Resolves a previously registered text-to-speech adapter.
 *
 * @param {string} key - Adapter identifier supplied during registration.
 * @returns {{ synthesise: Function }|undefined} Adapter instance when found.
 */
export function getTtsAdapter(key) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    return undefined;
  }
  return registry.get(normalisedKey);
}

/**
 * Indicates whether an adapter exists for the supplied identifier.
 *
 * @param {string} key - Adapter identifier to verify.
 * @returns {boolean} True when an adapter has been registered.
 */
export function hasTtsAdapter(key) {
  const normalisedKey = normaliseKey(key);
  if (!normalisedKey) {
    return false;
  }
  return registry.has(normalisedKey);
}

/**
 * Removes all registered adapters. Primarily used by tests between cases.
 *
 * @returns {void}
 */
export function clearTtsAdapters() {
  registry.clear();
  logger.debug('TTS adapter registry cleared.');
}

/**
 * Convenience facade mirroring the individual registry helpers. Retained for
 * backwards compatibility with older imports.
 */
export const ttsAdapters = {
  register: registerTtsAdapter,
  get: getTtsAdapter,
  has: hasTtsAdapter,
  clear: clearTtsAdapters,
  keys() {
    return Array.from(registry.keys());
  },
};

