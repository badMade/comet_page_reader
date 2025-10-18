import { test } from 'node:test';
import assert from 'node:assert/strict';

const USAGE_STORAGE_KEY = 'comet:usage';

function createStorageArea(store) {
  return {
    get(key, callback) {
      if (typeof key === 'string') {
        callback({ [key]: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined });
        return;
      }

      if (Array.isArray(key)) {
        const result = key.reduce((acc, current) => {
          acc[current] = Object.prototype.hasOwnProperty.call(store, current) ? store[current] : undefined;
          return acc;
        }, {});
        callback(result);
        return;
      }

      if (typeof key === 'object' && key !== null) {
        const result = {};
        for (const [entryKey, defaultValue] of Object.entries(key)) {
          result[entryKey] = Object.prototype.hasOwnProperty.call(store, entryKey) ? store[entryKey] : defaultValue;
        }
        callback(result);
        return;
      }

      callback({});
    },
    set(items, callback) {
      Object.assign(store, items);
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      const removeKey = key => {
        delete store[key];
      };
      if (Array.isArray(keys)) {
        keys.forEach(removeKey);
      } else if (typeof keys === 'string') {
        removeKey(keys);
      }
      if (callback) {
        callback();
      }
    },
  };
}

function installChromeStub(persistent = {}, session = {}) {
  const storage = {
    sync: createStorageArea(persistent),
    session: createStorageArea(session),
  };

  globalThis.chrome = {
    storage,
    runtime: {
      lastError: null,
      onMessage: { addListener: () => {} },
    },
  };

  return () => {
    delete globalThis.chrome;
  };
}

async function importServiceWorker() {
  const moduleUrl = new URL('../background/service_worker.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

test('ensureInitialised hydrates stored limit for the cost tracker', async () => {
  const storedUsage = {
    totalCostUsd: 12.5,
    requests: [
      {
        model: 'gpt-4o-mini',
        promptTokens: 10,
        completionTokens: 20,
        costUsd: 0.01,
        timestamp: 1000,
      },
    ],
    lastReset: 12345,
    limitUsd: 42,
  };

  const uninstall = installChromeStub({ [USAGE_STORAGE_KEY]: storedUsage });

  try {
    const { ensureInitialised, handleUsageRequest } = await importServiceWorker();
    await ensureInitialised();
    const usage = await handleUsageRequest();

    assert.equal(usage.limitUsd, storedUsage.limitUsd);
    assert.equal(usage.totalCostUsd, storedUsage.totalCostUsd);
    assert.equal(usage.requests.length, storedUsage.requests.length);
    assert.equal(usage.lastReset, storedUsage.lastReset);
  } finally {
    uninstall();
  }
});
