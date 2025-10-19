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
          result[entryKey] = Object.prototype.hasOwnProperty.call(store, entryKey)
            ? store[entryKey]
            : defaultValue;
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

export function installChromeStub(persistent = {}, session = {}) {
  const persistentStore = { ...persistent };
  const sessionStore = { ...session };

  const storage = {
    sync: createStorageArea(persistentStore),
    session: createStorageArea(sessionStore),
  };

  const runtime = {
    lastError: null,
    onMessage: { addListener: () => {} },
  };

  const chromeStub = {
    storage,
    runtime,
  };

  globalThis.chrome = chromeStub;

  return {
    chrome: chromeStub,
    persistentStore,
    sessionStore,
    uninstall() {
      delete globalThis.chrome;
    },
  };
}

export async function importServiceWorker() {
  const moduleUrl = new URL('../../background/service_worker.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}
