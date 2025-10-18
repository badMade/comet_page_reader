import { test } from 'node:test';
import assert from 'node:assert/strict';

function createStorageArea(store) {
  return {
    get(key, callback) {
      if (typeof key === 'string') {
        if (store.has(key)) {
          callback({ [key]: store.get(key) });
        } else {
          callback({});
        }
        return;
      }
      if (Array.isArray(key)) {
        const result = {};
        for (const item of key) {
          if (store.has(item)) {
            result[item] = store.get(item);
          }
        }
        callback(result);
        return;
      }
      callback({});
    },
    set(items, callback) {
      for (const [itemKey, value] of Object.entries(items)) {
        store.set(itemKey, value);
      }
      if (typeof callback === 'function') {
        callback();
      }
    },
    remove(key, callback) {
      if (Array.isArray(key)) {
        key.forEach(item => store.delete(item));
      } else {
        store.delete(key);
      }
      if (typeof callback === 'function') {
        callback();
      }
    },
  };
}

test('ensureInitialised hydrates tracker limit from stored usage', async () => {
  const previousChrome = globalThis.chrome;
  const persistentStore = new Map();
  const sessionStore = new Map();

  persistentStore.set('comet:usage', {
    limitUsd: 42,
    totalCostUsd: 10,
    requests: [{ id: 'abc', costUsd: 10 }],
    lastReset: 123456,
  });

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      lastError: null,
    },
    storage: {
      sync: createStorageArea(persistentStore),
      session: createStorageArea(sessionStore),
    },
  };

  try {
    const module = await import('../background/service_worker.js');
    await module.ensureInitialised();
    const snapshot = module.getCostTrackerSnapshot();

    assert.equal(snapshot.limitUsd, 42);
    assert.equal(snapshot.totalCostUsd, 10);
    assert.deepEqual(snapshot.requests, [{ id: 'abc', costUsd: 10 }]);
    assert.equal(snapshot.lastReset, 123456);
  } finally {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  }
});
