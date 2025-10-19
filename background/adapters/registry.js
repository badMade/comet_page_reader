const factories = new Map();

export function registerAdapter(providerKey, factory) {
  if (!providerKey || typeof providerKey !== 'string') {
    throw new Error('Provider key must be a non-empty string.');
  }
  if (typeof factory !== 'function') {
    throw new Error(`Adapter factory for ${providerKey} must be a function.`);
  }
  factories.set(providerKey.toLowerCase(), factory);
}

export function getAdapterFactory(providerKey) {
  if (!providerKey) {
    return undefined;
  }
  return factories.get(providerKey.toLowerCase());
}

export function createAdapter(providerKey, config) {
  const factory = getAdapterFactory(providerKey);
  if (!factory) {
    throw new Error(`No adapter registered for provider: ${providerKey}`);
  }
  return factory(config);
}

export function listRegisteredAdapters() {
  return Array.from(factories.keys());
}
