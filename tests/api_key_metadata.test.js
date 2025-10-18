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
