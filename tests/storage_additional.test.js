import { test } from 'node:test';
import assert from 'node:assert/strict';

function createStorageArea(config = {}) {
  const { map = new Map(), get, set, remove } = config;

  const defaultGet = (keys, callback) => {
    const response = {};
    if (Array.isArray(keys)) {
      for (const key of keys) {
        response[key] = map.has(key) ? map.get(key) : undefined;
      }
    } else if (keys && typeof keys === 'object') {
      for (const key of Object.keys(keys)) {
        response[key] = map.has(key) ? map.get(key) : keys[key];
      }
    } else if (typeof keys === 'string') {
      response[keys] = map.has(keys) ? map.get(keys) : undefined;
    }
    callback(response);
  };

  const defaultSet = (items, callback) => {
    for (const [key, value] of Object.entries(items)) {
      map.set(key, value);
    }
    if (callback) {
      callback();
    }
  };

  const defaultRemove = (keys, callback) => {
    const toRemove = Array.isArray(keys) ? keys : [keys];
    for (const key of toRemove) {
      map.delete(key);
    }
    if (callback) {
      callback();
    }
  };

  return {
    area: {
      get: get
        ? (...args) => get(map, ...args)
        : defaultGet,
      set: set
        ? (...args) => set(map, ...args)
        : defaultSet,
      remove: remove
        ? (...args) => remove(map, ...args)
        : defaultRemove,
    },
    map,
  };
}

function installChromeStub(config = {}) {
  const { sync = {}, local = {}, session = {} } = config;
  const runtime = { lastError: null };

  const storage = {};

  if (sync !== null) {
    const { area, map } = createStorageArea(sync);
    storage.sync = area;
    storage.sync.__map = map;
  }

  if (local !== null) {
    const { area, map } = createStorageArea(local);
    storage.local = area;
    storage.local.__map = map;
  }

  if (session !== null) {
    const { area, map } = createStorageArea(session);
    storage.session = area;
    storage.session.__map = map;
  }

  globalThis.chrome = { storage, runtime };
  delete globalThis.browser;

  return {
    uninstall() {
      delete globalThis.chrome;
    },
    storage,
  };
}

async function importFreshStorage() {
  const moduleUrl = new URL('../utils/storage.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

test('setPersistentValue falls back to local storage when sync rejects with runtime error', async () => {
  const localMap = new Map();
  const stub = installChromeStub({
    sync: {
      set: (_map, _items) => {
        chrome.runtime.lastError = { message: 'Sync disabled' };
        return Promise.reject(new Error('sync disabled'));
      },
    },
    local: { map: localMap },
  });

  try {
    const { setPersistentValue } = await importFreshStorage();
    await setPersistentValue('foo', 'bar');

    assert.equal(localMap.get('foo'), 'bar');
    assert.equal(chrome.runtime.lastError, null);
  } finally {
    stub.uninstall();
  }
});

test('setPersistentValues rejects when entries are not objects', async () => {
  const stub = installChromeStub();

  try {
    const { setPersistentValues } = await importFreshStorage();
    await assert.rejects(() => setPersistentValues(null), {
      name: 'TypeError',
      message: 'Storage set entries must be an object.',
    });
  } finally {
    stub.uninstall();
  }
});

test('getSessionValue surfaces runtime errors from the browser API', async () => {
  const stub = installChromeStub({
    session: {
      get: (_map, _keys, callback) => {
        chrome.runtime.lastError = { message: 'Session failure' };
        callback({});
      },
    },
  });

  try {
    const { getSessionValue } = await importFreshStorage();
    await assert.rejects(() => getSessionValue('ephemeral'), {
      message: 'Session failure',
    });
    assert.equal(chrome.runtime.lastError, null);
  } finally {
    stub.uninstall();
  }
});

test('setSessionValue resolves immediately when session storage is unavailable', async () => {
  const stub = installChromeStub({ session: null });

  try {
    const { setSessionValue } = await importFreshStorage();
    const result = await setSessionValue('ephemeral', 42);
    assert.equal(result, 42);
  } finally {
    stub.uninstall();
  }
});

test('withLock throws after exhausting retries when the lock remains held', async () => {
  const stub = installChromeStub();

  try {
    const { setValue, withLock } = await importFreshStorage();
    const lockId = `held-lock-${Date.now()}`;
    await setValue(`lock:${lockId}`, { timestamp: Date.now() });

    await assert.rejects(() => withLock(lockId, async () => {}), {
      message: 'Failed to acquire storage lock.',
    });
  } finally {
    stub.uninstall();
  }
});
