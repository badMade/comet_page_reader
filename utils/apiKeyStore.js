import { getValue, setValue, removeValue } from './storage.js';

export const API_KEY_STORAGE_KEY = 'comet:openaiApiKey';
export const API_KEY_METADATA_STORAGE_KEY = 'comet:openaiApiKeyMeta';

const defaultDeps = {
  getValue,
  setValue,
  removeValue,
};

function resolveDeps(overrides = {}) {
  return { ...defaultDeps, ...overrides };
}

export async function saveApiKey(apiKey, overrides) {
  const { setValue: setValueFn, removeValue: removeValueFn } = resolveDeps(overrides);
  const normalised = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
  if (!normalised) {
    await Promise.all([
      removeValueFn(API_KEY_STORAGE_KEY),
      removeValueFn(API_KEY_METADATA_STORAGE_KEY),
    ]);
    return null;
  }

  const storedKey = await setValueFn(API_KEY_STORAGE_KEY, normalised);
  await setValueFn(API_KEY_METADATA_STORAGE_KEY, { lastUpdated: Date.now() });
  return storedKey;
}

export async function fetchApiKeyDetails(overrides) {
  const { getValue: getValueFn } = resolveDeps(overrides);
  const [apiKey, metadata] = await Promise.all([
    getValueFn(API_KEY_STORAGE_KEY),
    getValueFn(API_KEY_METADATA_STORAGE_KEY),
  ]);

  const lastUpdated =
    metadata && typeof metadata === 'object' && typeof metadata.lastUpdated === 'number'
      ? metadata.lastUpdated
      : null;

  return {
    apiKey: apiKey || null,
    lastUpdated,
  };
}

export async function readApiKey(overrides) {
  const { apiKey } = await fetchApiKeyDetails(overrides);
  return apiKey;
}
