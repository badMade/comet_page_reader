import createLogger from './logger.js';
import { getValue, setPersistentValue, removeValue } from './storage.js';

export const DEFAULT_PROVIDER = 'openai';
export const LEGACY_API_KEY_STORAGE_KEY = 'comet:openaiApiKey';
export const LEGACY_API_KEY_METADATA_STORAGE_KEY = 'comet:openaiApiKeyMeta';
export const API_KEY_STORAGE_PREFIX = 'comet:apiKey';
export const API_KEY_METADATA_STORAGE_PREFIX = 'comet:apiKeyMeta';

const logger = createLogger({ name: 'api-key-store' });

const defaultDeps = {
  getValue,
  setValue: setPersistentValue,
  removeValue,
};

function normaliseProvider(provider) {
  if (typeof provider !== 'string') {
    return DEFAULT_PROVIDER;
  }
  const trimmed = provider.trim().toLowerCase();
  return trimmed || DEFAULT_PROVIDER;
}

function extractOverrideDeps(options) {
  if (!options || typeof options !== 'object') {
    return {};
  }

  if (options.overrides && typeof options.overrides === 'object') {
    return options.overrides;
  }

  const candidate = {};
  ['getValue', 'setValue', 'removeValue'].forEach(key => {
    if (typeof options[key] === 'function') {
      candidate[key] = options[key];
    }
  });

  return Object.keys(candidate).length > 0 ? candidate : {};
}

function resolveOptions(options) {
  return {
    provider: normaliseProvider(options?.provider),
    overrides: extractOverrideDeps(options),
  };
}

function resolveDeps(overrides = {}) {
  return { ...defaultDeps, ...overrides };
}

export function getProviderStorageKeys(provider) {
  const resolvedProvider = normaliseProvider(provider);
  return {
    apiKey: `${API_KEY_STORAGE_PREFIX}:${resolvedProvider}`,
    metadata: `${API_KEY_METADATA_STORAGE_PREFIX}:${resolvedProvider}`,
  };
}

async function clearLegacyKeys(removeValueFn) {
  await Promise.all([
    removeValueFn(LEGACY_API_KEY_STORAGE_KEY),
    removeValueFn(LEGACY_API_KEY_METADATA_STORAGE_KEY),
  ]);
}

export async function saveApiKey(apiKey, options) {
  const { provider, overrides } = resolveOptions(options);
  const { setValue: setValueFn, removeValue: removeValueFn } = resolveDeps(overrides);
  const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(provider);
  const normalised = typeof apiKey === 'string' ? apiKey.trim() : apiKey;

  if (!normalised) {
    logger.info('Clearing API key for provider.', { provider });
    const removals = [removeValueFn(storageKey), removeValueFn(metadataKey)];
    if (provider === DEFAULT_PROVIDER) {
      removals.push(clearLegacyKeys(removeValueFn));
    }
    await Promise.all(removals);
    logger.debug('API key cleared.', { provider });
    return null;
  }

  logger.debug('Persisting API key.', {
    provider,
    length: typeof normalised === 'string' ? normalised.length : null,
  });
  const storedKey = await setValueFn(storageKey, normalised);
  await setValueFn(metadataKey, { lastUpdated: Date.now() });

  if (provider === DEFAULT_PROVIDER) {
    await clearLegacyKeys(removeValueFn);
  }

  logger.info('API key stored.', { provider });
  return storedKey;
}

function normaliseLastUpdated(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const { lastUpdated } = metadata;
  return typeof lastUpdated === 'number' ? lastUpdated : null;
}

async function readLegacyKey(getValueFn) {
  const [legacyKey, legacyMetadata] = await Promise.all([
    getValueFn(LEGACY_API_KEY_STORAGE_KEY),
    getValueFn(LEGACY_API_KEY_METADATA_STORAGE_KEY),
  ]);

  if (!legacyKey) {
    return { apiKey: null, lastUpdated: null };
  }

  return {
    apiKey: legacyKey,
    lastUpdated: normaliseLastUpdated(legacyMetadata),
  };
}

export async function fetchApiKeyDetails(options) {
  const { provider, overrides } = resolveOptions(options);
  const { getValue: getValueFn } = resolveDeps(overrides);
  const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(provider);

  logger.trace('Fetching API key details.', { provider });
  const [storedKey, metadata] = await Promise.all([
    getValueFn(storageKey),
    getValueFn(metadataKey),
  ]);

  let apiKey = storedKey || null;
  let lastUpdated = normaliseLastUpdated(metadata);

  if (!apiKey && provider === DEFAULT_PROVIDER) {
    logger.debug('Falling back to legacy API key.', { provider });
    const legacyDetails = await readLegacyKey(getValueFn);
    apiKey = legacyDetails.apiKey;
    lastUpdated = legacyDetails.lastUpdated;
  }

  logger.info('API key details resolved.', {
    provider,
    hasKey: Boolean(apiKey),
    lastUpdated,
  });
  return {
    provider,
    apiKey,
    lastUpdated,
  };
}

export async function readApiKey(options) {
  const { apiKey } = await fetchApiKeyDetails(options);
  return apiKey;
}

export async function deleteApiKey(options) {
  const { provider, overrides } = resolveOptions(options);
  const { removeValue: removeValueFn } = resolveDeps(overrides);
  const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(provider);

  logger.warn('Deleting API key.', { provider });
  const removals = [removeValueFn(storageKey), removeValueFn(metadataKey)];
  if (provider === DEFAULT_PROVIDER) {
    removals.push(clearLegacyKeys(removeValueFn));
  }
  await Promise.all(removals);
  logger.debug('API key deleted.', { provider });
}
