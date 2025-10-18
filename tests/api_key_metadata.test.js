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
      API_KEY_METADATA_STORAGE_KEY,
      API_KEY_STORAGE_KEY,
      fetchApiKeyDetails,
      saveApiKey,
    } = await import(moduleUrl.href);

    const before = Date.now();
    await saveApiKey('test-key', overrides);
    const details = await fetchApiKeyDetails(overrides);
    assert.equal(details.apiKey, 'test-key');
    assert.equal(typeof details.lastUpdated, 'number');
    assert.ok(details.lastUpdated >= before);

    const storedMeta = persistentStore.get(API_KEY_METADATA_STORAGE_KEY);
    assert.ok(storedMeta);
    assert.equal(typeof storedMeta.lastUpdated, 'number');
    assert.equal(persistentStore.get(API_KEY_STORAGE_KEY), 'test-key');

    await saveApiKey('   ', overrides);
    const cleared = await fetchApiKeyDetails(overrides);
    assert.equal(cleared.apiKey, null);
    assert.equal(cleared.lastUpdated, null);
    assert.equal(persistentStore.has(API_KEY_METADATA_STORAGE_KEY), false);
    assert.equal(persistentStore.has(API_KEY_STORAGE_KEY), false);
  } finally {
    uninstall();
  }
});

test('API key writes fall back to local storage when sync storage fails', async () => {
  const persistentStore = new Map();
  const { uninstall, stats } = installChromeStubWithDisabledSync(persistentStore);

  try {
    const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const {
      API_KEY_METADATA_STORAGE_KEY,
      API_KEY_STORAGE_KEY,
      fetchApiKeyDetails,
      saveApiKey,
    } = await import(moduleUrl.href);

    const before = Date.now();
    await saveApiKey('sync-disabled');
    const details = await fetchApiKeyDetails();
    assert.equal(details.apiKey, 'sync-disabled');
    assert.ok(details.lastUpdated >= before);

    const storedKey = persistentStore.get(API_KEY_STORAGE_KEY);
    assert.equal(storedKey, 'sync-disabled');
    const metadata = persistentStore.get(API_KEY_METADATA_STORAGE_KEY);
    assert.ok(metadata);
    assert.equal(typeof metadata.lastUpdated, 'number');

    assert.equal(stats.syncSetCalls(), 2);
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
  };

  const localArea = {
    set(items, callback) {
      localSetCalls.push({ ...items });
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
    const { saveApiKey, API_KEY_STORAGE_KEY, API_KEY_METADATA_STORAGE_KEY } = await import(
      moduleUrl.href
    );

    const storedKey = await saveApiKey('sample-key');
    assert.equal(storedKey, 'sample-key');

    assert.equal(localSetCalls.length, 2);
    const keyWrite = localSetCalls.find(call => API_KEY_STORAGE_KEY in call);
    assert.deepEqual(keyWrite, { [API_KEY_STORAGE_KEY]: 'sample-key' });

    const metadataWrite = localSetCalls.find(call => API_KEY_METADATA_STORAGE_KEY in call);
    assert.ok(metadataWrite);
    const metadata = metadataWrite[API_KEY_METADATA_STORAGE_KEY];
    assert.equal(typeof metadata, 'object');
    assert.equal(typeof metadata.lastUpdated, 'number');
  } finally {
    delete globalThis.chrome;
  }
});
