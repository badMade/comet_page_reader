/**
 * Storage abstraction helpers that normalise Chrome and Firefox runtime APIs
 * for use across the extension.
 *
 * @module utils/storage
 */

/**
 * Resolves the runtime-specific browser API object (Chrome/Firefox compatible).
 *
 * @returns {typeof chrome|typeof browser} Browser API namespace.
 * @throws {Error} When neither API is present.
 */
const getBrowserApi = () => {
  if (typeof chrome !== 'undefined') {
    return chrome;
  }
  if (typeof browser !== 'undefined') {
    return browser;
  }
  throw new Error('Runtime APIs are unavailable in this environment.');
};

const getRuntime = () => getBrowserApi();

const runtimeProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const runtimeApi = getRuntime();
      return runtimeApi[prop];
    },
    set(_target, prop, value) {
      const runtimeApi = getRuntime();
      runtimeApi[prop] = value;
      return true;
    },
    has(_target, prop) {
      const runtimeApi = getRuntime();
      return prop in runtimeApi;
    },
    ownKeys() {
      const runtimeApi = getRuntime();
      return Reflect.ownKeys(runtimeApi);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const runtimeApi = getRuntime();
      const descriptor = Object.getOwnPropertyDescriptor(runtimeApi, prop);
      if (descriptor) {
        descriptor.configurable = true;
      }
      return descriptor;
    },
  }
);

const LOCK_STALE_THRESHOLD_MS = 10_000;

const clearRuntimeLastError = runtimeApi => {
  let targetRuntime = runtimeApi;
  if (!targetRuntime) {
    try {
      targetRuntime = getRuntime();
    } catch (_error) {
      return;
    }
  }
  if (!targetRuntime.runtime) {
    return;
  }
  try {
    if (Object.prototype.hasOwnProperty.call(targetRuntime.runtime, 'lastError')) {
      targetRuntime.runtime.lastError = null;
    }
  } catch (_error) {
    // Swallow assignment failures when the runtime exposes a read-only property.
  }
};

/**
 * Determines the most suitable persistent storage area available to the
 * extension.
 *
 * @returns {chrome.storage.StorageArea} Storage area instance.
 * @throws {Error} When storage APIs are unavailable.
 */
const resolveStorageArea = runtimeApi => {
  if (runtimeApi.storage && runtimeApi.storage.sync) {
    return runtimeApi.storage.sync;
  }
  if (runtimeApi.storage && runtimeApi.storage.local) {
    return runtimeApi.storage.local;
  }
  throw new Error('Storage APIs are unavailable.');
};

const getPersistentStorageArea = () => resolveStorageArea(getRuntime());

const resolveFallbackStorageArea = runtimeApi => {
  if (!runtimeApi.storage) {
    return null;
  }
  if (runtimeApi.storage.sync && runtimeApi.storage.local) {
    return runtimeApi.storage.local;
  }
  return null;
};

const getFallbackStorageArea = () => resolveFallbackStorageArea(getRuntime());

const getSessionArea = () => {
  const runtimeApi = getRuntime();
  if (runtimeApi.storage && runtimeApi.storage.session) {
    return runtimeApi.storage.session;
  }
  return null;
};

/**
 * Promisified wrapper for Chrome-style callback APIs.
 *
 * @param {string} method - Storage API method name.
 * @param {...*} args - Arguments forwarded to the API.
 * @returns {Promise<*>} Resolved API result.
 */
const callStorageArea = (area, method, args) => {
  if (!area || typeof area[method] !== 'function') {
    return Promise.reject(new Error(`Storage method "${method}" is unavailable.`));
  }

  return new Promise((resolve, reject) => {
    try {
      const runtimeApi = getRuntime();
      area[method](...args, result => {
        const err = runtimeApi.runtime && runtimeApi.runtime.lastError;
        clearRuntimeLastError(runtimeApi);
        if (err) {
          const storageError = new Error(err.message || 'Unknown storage error');
          storageError.isRuntimeError = true;
          reject(storageError);
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
};

const promisify = async (method, ...args) => {
  const primaryArea = getPersistentStorageArea();
  try {
    return await callStorageArea(primaryArea, method, args);
  } catch (error) {
    const fallbackStorageArea = getFallbackStorageArea();
    if (error && error.isRuntimeError && fallbackStorageArea) {
      clearRuntimeLastError();
      return callStorageArea(fallbackStorageArea, method, args);
    }
    throw error;
  }
};

const setValuesWithFallback = async entries => {
  if (!entries || typeof entries !== 'object') {
    throw new TypeError('Storage set entries must be an object.');
  }

  const primaryArea = getPersistentStorageArea();
  try {
    await callStorageArea(primaryArea, 'set', [entries]);
  } catch (error) {
    const fallbackStorageArea = getFallbackStorageArea();
    if (error && error.isRuntimeError && fallbackStorageArea) {
      clearRuntimeLastError();
      await callStorageArea(fallbackStorageArea, 'set', [entries]);
      return;
    }
    throw error;
  }
};

/**
 * Promisified wrapper for session storage APIs.
 *
 * @param {Function} fn - Storage API function.
 * @param {...*} args - Arguments forwarded to the API.
 * @returns {Promise<*>} Resolved API result.
 */
const promisifySession = (fn, ...args) => {
  const sessionArea = (() => {
    try {
      return getSessionArea();
    } catch (_error) {
      return null;
    }
  })();
  if (!sessionArea) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    try {
      fn.call(sessionArea, ...args, result => {
        const runtimeApi = (() => {
          try {
            return getRuntime();
          } catch (_error) {
            return null;
          }
        })();
        const err = runtimeApi && runtimeApi.runtime && runtimeApi.runtime.lastError;
        if (runtimeApi) {
          clearRuntimeLastError(runtimeApi);
        }
        if (err) {
          reject(new Error(err.message || 'Unknown storage error'));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Reads a value from the persistent storage area.
 *
 * @param {string} key - Storage key.
 * @param {*} [defaultValue] - Fallback value when the key is missing.
 * @returns {Promise<*>} Stored value or default.
 */
export async function getValue(key, defaultValue = undefined) {
  const data = await promisify('get', key);
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    return data[key];
  }
  return defaultValue;
}

/**
 * Persists a value using the persistent storage area.
 *
 * @param {string} key - Storage key.
 * @param {*} value - Value to store.
 * @returns {Promise<*>} Stored value.
 */
export async function setPersistentValues(entries) {
  await setValuesWithFallback(entries);
  return entries;
}

export async function setValueWithFallback(key, value) {
  await setValuesWithFallback({ [key]: value });
  return value;
}

export async function setValue(key, value) {
  return setValueWithFallback(key, value);
}

/**
 * Removes a value from the persistent storage area.
 *
 * @param {string} key - Storage key to remove.
 * @returns {Promise<void>} Resolves once the key is removed.
 */
export async function removeValue(key) {
  await promisify('remove', key);
}

/**
 * Provides a cooperative lock using storage keys to avoid concurrent writes.
 *
 * @param {string} key - Identifier used for the lock key.
 * @param {Function} fn - Async function executed while holding the lock.
 * @returns {Promise<*>} Result of the function.
 * @throws {Error} When the lock cannot be acquired within the retry budget.
 */
export async function withLock(key, fn) {
  const lockKey = `lock:${key}`;
  const maxAttempts = 5;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const resolveTimestamp = value => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (value && typeof value === 'object') {
      const timestamp = value.timestamp ?? value.time ?? value.ts;
      if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
    return null;
  };

  let attempt = 0;
  while (attempt < maxAttempts) {
    const current = await getValue(lockKey);
    const timestamp = resolveTimestamp(current);

    if (timestamp !== null && Date.now() - timestamp > LOCK_STALE_THRESHOLD_MS) {
      await removeValue(lockKey);
      continue;
    }

    if (timestamp === null && current) {
      await removeValue(lockKey);
      continue;
    }

    if (!current) {
      await setValue(lockKey, { timestamp: Date.now() });
      try {
        return await fn();
      } finally {
        await removeValue(lockKey);
      }
    }

    attempt += 1;
    if (attempt < maxAttempts) {
      await delay(50 * attempt);
    }
  }
  throw new Error('Failed to acquire storage lock.');
}

/**
 * Reads a value from the session storage area when available.
 *
 * @param {string} key - Storage key.
 * @param {*} [defaultValue] - Fallback value when missing.
 * @returns {Promise<*>} Stored value or default.
 */
export async function getSessionValue(key, defaultValue = undefined) {
  const sessionStore = (() => {
    try {
      return getSessionArea();
    } catch (_error) {
      return null;
    }
  })();
  if (!sessionStore) {
    return defaultValue;
  }
  const data = await promisifySession(sessionStore.get, key);
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    return data[key];
  }
  return defaultValue;
}

/**
 * Persists a value to the session storage area when available.
 *
 * @param {string} key - Storage key.
 * @param {*} value - Value to store.
 * @returns {Promise<*>} Stored value.
 */
export async function setSessionValue(key, value) {
  const sessionStore = (() => {
    try {
      return getSessionArea();
    } catch (_error) {
      return null;
    }
  })();
  if (!sessionStore) {
    return value;
  }
  await promisifySession(sessionStore.set, { [key]: value });
  return value;
}

export { runtimeProxy as runtime };
