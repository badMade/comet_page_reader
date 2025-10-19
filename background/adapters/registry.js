/**
 * Registry for background adapters. Providers register their factory functions
 * so the router can instantiate adapters on demand.
 *
 * @module background/adapters/registry
 */

const factories = new Map();

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
  factories.set(providerKey.toLowerCase(), factory);
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
  return factories.get(providerKey.toLowerCase());
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
  return factory(config);
}

/**
 * Lists all registered adapter keys. Useful for diagnostics and tests.
 *
 * @returns {string[]} Provider identifiers.
 */
export function listRegisteredAdapters() {
  return Array.from(factories.keys());
}
