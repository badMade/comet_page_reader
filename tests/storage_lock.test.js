import { test } from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const store = new Map();

  const storageArea = {
    get(keys, callback) {
      const response = {};
      if (Array.isArray(keys)) {
        keys.forEach(key => {
          response[key] = store.has(key) ? store.get(key) : undefined;
        });
      } else if (keys && typeof keys === 'object') {
        Object.keys(keys).forEach(key => {
          response[key] = store.has(key) ? store.get(key) : keys[key];
        });
      } else if (typeof keys === 'string') {
        response[keys] = store.has(keys) ? store.get(keys) : undefined;
      }
      callback(response);
    },
    set(items, callback) {
      Object.entries(items).forEach(([key, value]) => {
        store.set(key, value);
      });
      if (callback) {
        callback();
      }
    },
    remove(keys, callback) {
      const toRemove = Array.isArray(keys) ? keys : [keys];
      toRemove.forEach(key => {
        store.delete(key);
      });
      if (callback) {
        callback();
      }
    },
  };

  globalThis.chrome = {
    storage: { sync: storageArea, session: storageArea },
    runtime: { lastError: null },
  };

  return () => {
    delete globalThis.chrome;
  };
}

test('withLock recovers from stale lock entries', async () => {
  const uninstall = installChromeStub();

  try {
    const moduleUrl = new URL('../utils/storage.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const { setValue, getValue, withLock } = await import(moduleUrl.href);

    const lockKey = 'stale-lock';
    await setValue(`lock:${lockKey}`, Date.now() - 86_400_000);

    let executed = false;
    await withLock(lockKey, async () => {
      executed = true;
    });

    assert.equal(executed, true);
    const remaining = await getValue(`lock:${lockKey}`);
    assert.equal(remaining, undefined);
  } finally {
    uninstall();
  }
});

test('withLock clears malformed locks and normalises stored payloads', async () => {
  const uninstall = installChromeStub();

  try {
    const moduleUrl = new URL('../utils/storage.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const { setValue, getValue, withLock } = await import(moduleUrl.href);

    const lockKey = 'corrupt-lock';
    await setValue(`lock:${lockKey}`, { unexpected: true });

    let observedPayload;
    await withLock(lockKey, async () => {
      observedPayload = await getValue(`lock:${lockKey}`);
    });

    assert.equal(typeof observedPayload, 'object');
    assert.ok(observedPayload);
    assert.equal(typeof observedPayload.timestamp, 'number');
    assert.ok(Number.isFinite(observedPayload.timestamp));
    const remaining = await getValue(`lock:${lockKey}`);
    assert.equal(remaining, undefined);
  } finally {
    uninstall();
  }
});
