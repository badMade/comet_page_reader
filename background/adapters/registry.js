import createLogger from '../../utils/logger.js';

const logger = createLogger({ name: 'adapter-registry' });

const factories = new Map();

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

export function listRegisteredAdapters() {
  const registered = Array.from(factories.keys());
  logger.trace('Listing registered adapters.', { count: registered.length });
  return registered;
}
