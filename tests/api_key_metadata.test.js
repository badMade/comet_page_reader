import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function loadApiKeyStoreModule() {
  const moduleUrl = new URL('../utils/apiKeyStore.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

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

function installFailingSyncChromeStub() {
  const syncInvocationCounts = { get: 0, set: 0, remove: 0 };
  const localStore = new Map();

  const runtime = {
    lastError: null,
    onMessage: { addListener: () => {} },
  };

  const triggerFailure = (callback, payload) => {
    runtime.lastError = { message: 'sync failure' };
    if (callback) {
      callback(payload);
    }
    runtime.lastError = null;
  };

  const syncArea = {
    get(keys, callback) {
      syncInvocationCounts.get += 1;
      triggerFailure(callback, {});
    },
    set(_items, callback) {
      syncInvocationCounts.set += 1;
      triggerFailure(callback);
    },
    remove(_keys, callback) {
      syncInvocationCounts.remove += 1;
      triggerFailure(callback);
    },
  };

  const resolveKeys = keys => {
    if (Array.isArray(keys)) {
      return keys;
    }
    if (typeof keys === 'string') {
      return [keys];
    }
    if (keys && typeof keys === 'object') {
      return Object.keys(keys);
    }
    return [];
  };

  const localArea = {
    get(keys, callback) {
      const result = {};
      for (const key of resolveKeys(keys)) {
        if (localStore.has(key)) {
          result[key] = localStore.get(key);
        }
      }
      callback(result);
    },
    set(items, callback) {
      Object.entries(items).forEach(([key, value]) => {
        localStore.set(key, value);
      });
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      for (const key of resolveKeys(keys)) {
        localStore.delete(key);
      }
      if (callback) {
        callback();
      }
    },
  };

  globalThis.chrome = {
    storage: { sync: syncArea, local: localArea },
    runtime,
  };

  return {
    uninstall() {
      delete globalThis.chrome;
    },
    syncInvocationCounts,
    localStore,
  };
}

describe('api key metadata storage', { concurrency: false }, () => {
  test('Chrome sync errors fall back to local storage', async () => {
    const { uninstall, syncInvocationCounts, localStore } = installFailingSyncChromeStub();

    try {
      const {
        API_KEY_METADATA_STORAGE_KEY,
        API_KEY_STORAGE_KEY,
        fetchApiKeyDetails,
        saveApiKey,
      } = await loadApiKeyStoreModule();

      const before = Date.now();
      await saveApiKey('fallback-key');
      const details = await fetchApiKeyDetails();

      assert.ok(syncInvocationCounts.set >= 1);
      assert.ok(syncInvocationCounts.get >= 1);

      assert.equal(localStore.get(API_KEY_STORAGE_KEY), 'fallback-key');
      const storedMeta = localStore.get(API_KEY_METADATA_STORAGE_KEY);
      assert.ok(storedMeta);
      assert.equal(typeof storedMeta.lastUpdated, 'number');
      assert.ok(storedMeta.lastUpdated >= before);

      assert.equal(details.apiKey, 'fallback-key');
      assert.equal(typeof details.lastUpdated, 'number');
      assert.ok(details.lastUpdated >= before);

      await saveApiKey('   ');
      assert.ok(syncInvocationCounts.remove >= 1);
      assert.equal(localStore.has(API_KEY_STORAGE_KEY), false);
      assert.equal(localStore.has(API_KEY_METADATA_STORAGE_KEY), false);
    } finally {
      uninstall();
    }
  });

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
      const {
        API_KEY_METADATA_STORAGE_KEY,
        API_KEY_STORAGE_KEY,
        fetchApiKeyDetails,
        saveApiKey,
      } = await loadApiKeyStoreModule();

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
});
