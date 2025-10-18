import { test } from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const localStore = new Map();

  const invokeCallback = (callback, payload) => {
    if (typeof callback === 'function') {
      callback(payload);
    }
  };

  const failingSyncArea = {
    get(_keys, callback) {
      globalThis.chrome.runtime.lastError = { message: 'Sync is disabled.' };
      invokeCallback(callback, {});
      globalThis.chrome.runtime.lastError = null;
    },
    set(_items, callback) {
      globalThis.chrome.runtime.lastError = { message: 'Sync is disabled.' };
      invokeCallback(callback);
      globalThis.chrome.runtime.lastError = null;
    },
    remove(_keys, callback) {
      globalThis.chrome.runtime.lastError = { message: 'Sync is disabled.' };
      invokeCallback(callback);
      globalThis.chrome.runtime.lastError = null;
    },
  };

  const functionalLocalArea = {
    get(keys, callback) {
      const result = {};
      const applyKey = key => {
        if (localStore.has(key)) {
          result[key] = localStore.get(key);
        }
      };

      if (Array.isArray(keys)) {
        keys.forEach(applyKey);
      } else if (typeof keys === 'string') {
        applyKey(keys);
      } else if (keys && typeof keys === 'object') {
        Object.keys(keys).forEach(applyKey);
      }

      invokeCallback(callback, result);
    },
    set(items, callback) {
      Object.entries(items || {}).forEach(([key, value]) => {
        localStore.set(key, value);
      });
      invokeCallback(callback);
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(key => {
        localStore.delete(key);
      });
      invokeCallback(callback);
    },
  };

  globalThis.chrome = {
    storage: {
      sync: failingSyncArea,
      local: functionalLocalArea,
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: () => {} },
    },
  };

  return {
    uninstall() {
      delete globalThis.chrome;
    },
    localStore,
  };
}

test('falls back to local storage when sync is unavailable', { concurrency: false }, async () => {
  const { uninstall, localStore } = installChromeStub();

  try {
    const moduleUrl = new URL('../utils/storage.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const storage = await import(moduleUrl.href);

    const defaulted = await storage.getValue('missing', 'fallback');
    assert.equal(defaulted, 'fallback');

    await storage.setValue('apiKey', 'secret');
    assert.equal(localStore.get('apiKey'), 'secret');

    const retrieved = await storage.getValue('apiKey');
    assert.equal(retrieved, 'secret');

    await storage.removeValue('apiKey');
    assert.equal(localStore.has('apiKey'), false);
  } finally {
    uninstall();
  }
});
