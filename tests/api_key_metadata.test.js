import { test } from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const storageArea = {
    get(_keys, callback) {
      callback({});
    },
    set(_items, callback) {
      if (callback) {
        callback();
      }
    },
    remove(_keys, callback) {
      if (callback) {
        callback();
      }
    },
  };

  globalThis.chrome = {
    storage: { sync: storageArea },
    runtime: { lastError: null, onMessage: { addListener: () => {} } },
  };

  return () => {
    delete globalThis.chrome;
  };
}

function installChromeStubWithDisabledSync(persistentStore) {
  let syncSetCalls = 0;
  let localSetCalls = 0;

  const normaliseKeys = keys => {
    if (Array.isArray(keys)) {
      return keys;
    }
    if (keys && typeof keys === 'object') {
      return Object.keys(keys);
    }
    if (typeof keys === 'string') {
      return [keys];
    }
    return [];
  };

  const readFromStore = keys => {
    const result = {};
    const resolvedKeys = normaliseKeys(keys);
    if (resolvedKeys.length === 0) {
      for (const [key, value] of persistentStore.entries()) {
        result[key] = value;
      }
      return result;
    }
    for (const key of resolvedKeys) {
      if (persistentStore.has(key)) {
        result[key] = persistentStore.get(key);
      }
    }
    return result;
  };

  const syncArea = {
    get(keys, callback) {
      if (globalThis.chrome?.runtime) {
        globalThis.chrome.runtime.lastError = { message: 'Sync storage is disabled.' };
      }
      callback(readFromStore(keys));
    },
    set(items, callback) {
      syncSetCalls += 1;
      if (globalThis.chrome?.runtime) {
        globalThis.chrome.runtime.lastError = { message: 'Sync storage is disabled.' };
      }
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      if (globalThis.chrome?.runtime) {
        globalThis.chrome.runtime.lastError = { message: 'Sync storage is disabled.' };
      }
      if (callback) {
        callback();
      }
    },
  };

  const localArea = {
    get(keys, callback) {
      callback(readFromStore(keys));
    },
    set(items, callback) {
      localSetCalls += 1;
      Object.entries(items).forEach(([key, value]) => {
        persistentStore.set(key, value);
      });
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      const resolvedKeys = normaliseKeys(keys);
      resolvedKeys.forEach(key => persistentStore.delete(key));
      if (callback) {
        callback();
      }
    },
  };

  globalThis.chrome = {
    storage: { sync: syncArea, local: localArea },
    runtime: { lastError: null, onMessage: { addListener: () => {} } },
  };

  return {
    uninstall() {
      delete globalThis.chrome;
    },
    stats: {
      syncSetCalls: () => syncSetCalls,
      localSetCalls: () => localSetCalls,
    },
  };
}

function installBrowserStubWithPromiseStorage() {
  const persistentStore = new Map();
  const sessionStore = new Map();

  const readFromStore = (store, keys) => {
    const result = {};
    if (typeof keys === 'undefined') {
      for (const [key, value] of store.entries()) {
        result[key] = value;
      }
      return result;
    }
    const resolvedKeys = Array.isArray(keys)
      ? keys
      : typeof keys === 'object' && keys !== null
      ? Object.keys(keys)
      : [keys];
    resolvedKeys.forEach(key => {
      if (store.has(key)) {
        result[key] = store.get(key);
      }
    });
    return result;
  };

  const createArea = backingStore => ({
    async get(keys) {
      return readFromStore(backingStore, keys);
    },
    async set(items) {
      Object.entries(items).forEach(([key, value]) => {
        backingStore.set(key, value);
      });
    },
    async remove(keys) {
      const resolvedKeys = Array.isArray(keys) ? keys : [keys];
      resolvedKeys.forEach(key => backingStore.delete(key));
    },
  });

  const browserStub = {
    storage: {
      sync: createArea(persistentStore),
      local: createArea(persistentStore),
      session: createArea(sessionStore),
    },
    runtime: {},
  };

  delete globalThis.chrome;
  globalThis.browser = browserStub;

  return {
    persistentStore,
    sessionStore,
    uninstall() {
      delete globalThis.browser;
    },
  };
}

test('API key metadata is stored and cleared alongside the key', async () => {
  const persistentStore = new Map();

  const overrides = {
    getValue: async key => persistentStore.get(key),
    setValue: async (key, value) => {
      persistentStore.set(key, value);
      return value;
    },
    removeValue: async key => {
      persistentStore.delete(key);
    },
  };

  const uninstall = installChromeStub();

  try {
    const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const {
      DEFAULT_PROVIDER,
      getProviderStorageKeys,
      fetchApiKeyDetails,
      saveApiKey,
    } = await import(moduleUrl.href);

    const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(DEFAULT_PROVIDER);
    const before = Date.now();
    await saveApiKey('test-key', overrides);
    const details = await fetchApiKeyDetails(overrides);
    assert.equal(details.apiKey, 'test-key');
    assert.equal(typeof details.lastUpdated, 'number');
    assert.ok(details.lastUpdated >= before);
    assert.equal(details.provider, DEFAULT_PROVIDER);

    const storedMeta = persistentStore.get(metadataKey);
    assert.ok(storedMeta);
    assert.equal(typeof storedMeta.lastUpdated, 'number');
    assert.equal(persistentStore.get(storageKey), 'test-key');

    await saveApiKey('   ', overrides);
    const cleared = await fetchApiKeyDetails(overrides);
    assert.equal(cleared.apiKey, null);
    assert.equal(cleared.lastUpdated, null);
    assert.equal(persistentStore.has(metadataKey), false);
    assert.equal(persistentStore.has(storageKey), false);
  } finally {
    uninstall();
  }
});

test('API key writes use local storage when sync storage fails', async () => {
  const persistentStore = new Map();
  const { uninstall, stats } = installChromeStubWithDisabledSync(persistentStore);

  try {
    const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const {
      DEFAULT_PROVIDER,
      getProviderStorageKeys,
      fetchApiKeyDetails,
      saveApiKey,
    } = await import(moduleUrl.href);

    const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(DEFAULT_PROVIDER);
    const before = Date.now();
    await saveApiKey('sync-disabled');
    const details = await fetchApiKeyDetails();
    assert.equal(details.apiKey, 'sync-disabled');
    assert.ok(details.lastUpdated >= before);
    assert.equal(details.provider, DEFAULT_PROVIDER);

    const storedKey = persistentStore.get(storageKey);
    assert.equal(storedKey, 'sync-disabled');
    const metadata = persistentStore.get(metadataKey);
    assert.ok(metadata);
    assert.equal(typeof metadata.lastUpdated, 'number');

    assert.equal(stats.syncSetCalls(), 0);
    assert.equal(stats.localSetCalls(), 2);
  } finally {
    uninstall();
  }
});

test('saveApiKey falls back to local storage when sync set reports disabled sync', async () => {
  const localSetCalls = [];
  const disabledSyncMessage =
    'This operation is not allowed. Usually because the "Sync" feature is disabled.';

  const syncArea = {
    set(_items, callback) {
      if (typeof callback === 'function') {
        const wrappedCallback = () => {
          if (globalThis.chrome?.runtime) {
            globalThis.chrome.runtime.lastError = { message: disabledSyncMessage };
          }
          callback();
        };

        wrappedCallback();
      }
    },
    remove(_keys, callback) {
      if (typeof callback === 'function') {
        callback();
      }
    },
  };

  const localArea = {
    set(items, callback) {
      localSetCalls.push({ ...items });
      if (typeof callback === 'function') {
        callback();
      }
    },
    remove(_keys, callback) {
      if (typeof callback === 'function') {
        callback();
      }
    },
  };

  globalThis.chrome = {
    storage: { sync: syncArea, local: localArea },
    runtime: { lastError: null, onMessage: { addListener: () => {} } },
  };

  try {
    const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const { DEFAULT_PROVIDER, getProviderStorageKeys, saveApiKey } = await import(moduleUrl.href);

    const storedKey = await saveApiKey('sample-key');
    assert.equal(storedKey, 'sample-key');

    assert.equal(localSetCalls.length, 2);
    const { apiKey: storageKey, metadata: metadataKey } = getProviderStorageKeys(DEFAULT_PROVIDER);
    const keyWrite = localSetCalls.find(call => storageKey in call);
    assert.deepEqual(keyWrite, { [storageKey]: 'sample-key' });

    const metadataWrite = localSetCalls.find(call => metadataKey in call);
    assert.ok(metadataWrite);
    const metadata = metadataWrite[metadataKey];
    assert.equal(typeof metadata, 'object');
    assert.equal(typeof metadata.lastUpdated, 'number');
  } finally {
    delete globalThis.chrome;
  }
});

test('API keys are isolated per provider and can be cleared independently', async () => {
  const persistentStore = new Map();

  const overrides = {
    getValue: async key => persistentStore.get(key),
    setValue: async (key, value) => {
      persistentStore.set(key, value);
      return value;
    },
    removeValue: async key => {
      persistentStore.delete(key);
    },
  };

  const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  const {
    getProviderStorageKeys,
    fetchApiKeyDetails,
    saveApiKey,
    deleteApiKey,
  } = await import(moduleUrl.href);

  await saveApiKey('openai-key', { provider: 'openai', overrides });
  await saveApiKey('anthropic-key', { provider: 'anthropic', overrides });

  const openaiKeys = getProviderStorageKeys('openai');
  const anthropicKeys = getProviderStorageKeys('anthropic');

  assert.equal(persistentStore.get(openaiKeys.apiKey), 'openai-key');
  assert.equal(persistentStore.get(anthropicKeys.apiKey), 'anthropic-key');

  const openaiDetails = await fetchApiKeyDetails({ provider: 'openai', overrides });
  const anthropicDetails = await fetchApiKeyDetails({ provider: 'anthropic', overrides });

  assert.equal(openaiDetails.apiKey, 'openai-key');
  assert.equal(openaiDetails.provider, 'openai');
  assert.equal(typeof openaiDetails.lastUpdated, 'number');

  assert.equal(anthropicDetails.apiKey, 'anthropic-key');
  assert.equal(anthropicDetails.provider, 'anthropic');
  assert.equal(typeof anthropicDetails.lastUpdated, 'number');

  await deleteApiKey({ provider: 'anthropic', overrides });

  const anthropicAfterDelete = await fetchApiKeyDetails({ provider: 'anthropic', overrides });
  assert.equal(anthropicAfterDelete.apiKey, null);
  assert.equal(anthropicAfterDelete.lastUpdated, null);
  assert.equal(persistentStore.has(anthropicKeys.apiKey), false);
  assert.equal(persistentStore.has(anthropicKeys.metadata), false);

  const openaiAfterDelete = await fetchApiKeyDetails({ provider: 'openai', overrides });
  assert.equal(openaiAfterDelete.apiKey, 'openai-key');
  assert.equal(persistentStore.get(openaiKeys.apiKey), 'openai-key');
});

test('saveApiKey supports promise-based storage APIs', async () => {
  const { uninstall, persistentStore } = installBrowserStubWithPromiseStorage();

  try {
    const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const { saveApiKey, fetchApiKeyDetails, getProviderStorageKeys } = await import(moduleUrl.href);

    await saveApiKey('promise-key');
    const details = await fetchApiKeyDetails();
    const { apiKey: storageKey } = getProviderStorageKeys(details.provider);

    assert.equal(details.apiKey, 'promise-key');
    assert.equal(persistentStore.get(storageKey), 'promise-key');
  } finally {
    uninstall();
  }
});
