import createLogger from './logger.js';

const logger = createLogger({ name: 'storage-utils' });

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
    logger.trace('Resolved Chrome runtime API.');
    return chrome;
  }
  if (typeof browser !== 'undefined') {
    logger.trace('Resolved Firefox runtime API.');
    return browser;
  }
  logger.error('Runtime APIs are unavailable in this environment.');
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
  if (runtimeApi.storage && runtimeApi.storage.local) {
    logger.trace('Using local storage area.');
    return runtimeApi.storage.local;
  }
  if (runtimeApi.storage && runtimeApi.storage.sync) {
    logger.trace('Falling back to sync storage area.');
    return runtimeApi.storage.sync;
  }
  logger.error('Unable to resolve persistent storage area.');
  throw new Error('Storage APIs are unavailable.');
};

const getPersistentStorageArea = () => resolveStorageArea(getRuntime());

const resolveFallbackStorageArea = runtimeApi => {
  if (!runtimeApi.storage) {
    return null;
  }
  if (runtimeApi.storage.local && runtimeApi.storage.sync) {
    return runtimeApi.storage.sync;
  }
  if (runtimeApi.storage.sync) {
    return runtimeApi.storage.sync;
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
    logger.error('Attempted to call unavailable storage method.', { method });
    return Promise.reject(new Error(`Storage method "${method}" is unavailable.`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = value => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const rejectOnce = error => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    try {
      const runtimeApi = getRuntime();
      logger.trace('Invoking storage method.', {
        method,
        argumentCount: args.length,
        hasRuntime: Boolean(runtimeApi),
      });
      const callback = result => {
        if (settled) {
          return;
        }
        const err = runtimeApi.runtime && runtimeApi.runtime.lastError;
        clearRuntimeLastError(runtimeApi);
        if (err) {
          const storageError = new Error(err.message || 'Unknown storage error');
          storageError.isRuntimeError = true;
          logger.warn('Storage API reported runtime error.', { method, error: storageError });
          rejectOnce(storageError);
          return;
        }
        resolveOnce(result);
      };

      const maybePromise = area[method](...args, callback);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise
          .then(result => {
            clearRuntimeLastError(runtimeApi);
            logger.trace('Storage method resolved via promise.', { method });
            resolveOnce(result);
          })
          .catch(error => {
            const storageError = error instanceof Error ? error : new Error(String(error));
            if (!storageError.isRuntimeError) {
              storageError.isRuntimeError = true;
            }
            logger.warn('Storage promise rejected.', { method, error: storageError });
            rejectOnce(storageError);
          });
      }
    } catch (error) {
      logger.error('Storage method threw synchronously.', { method, error });
      rejectOnce(error);
    }
  });
};

const promisify = async (method, ...args) => {
  const primaryArea = getPersistentStorageArea();
  try {
    const result = await callStorageArea(primaryArea, method, args);
    logger.trace('Primary storage area responded.', { method });
    return result;
  } catch (error) {
    const fallbackStorageArea = getFallbackStorageArea();
    if (error && error.isRuntimeError && fallbackStorageArea) {
      clearRuntimeLastError();
      logger.warn('Falling back to secondary storage area.', { method });
      return callStorageArea(fallbackStorageArea, method, args);
    }
    logger.error('Persistent storage operation failed.', { method, error });
    throw error;
  }
};

const setValuesWithFallback = async entries => {
  if (!entries || typeof entries !== 'object') {
    throw new TypeError('Storage set entries must be an object.');
  }

  const primaryArea = getPersistentStorageArea();
  logger.debug('Persisting multiple storage values.', {
    keys: Object.keys(entries),
    entryCount: Object.keys(entries).length,
  });
  try {
    await callStorageArea(primaryArea, 'set', [entries]);
    logger.trace('Primary storage set succeeded.', { keys: Object.keys(entries) });
  } catch (error) {
    const fallbackStorageArea = getFallbackStorageArea();
    if (error && error.isRuntimeError && fallbackStorageArea) {
      clearRuntimeLastError();
      logger.warn('Primary storage set failed, using fallback.', { error, keys: Object.keys(entries) });
      await callStorageArea(fallbackStorageArea, 'set', [entries]);
      return;
    }
    logger.error('Failed to persist storage values.', { error, keys: Object.keys(entries) });
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
          const error = new Error(err.message || 'Unknown storage error');
          logger.warn('Session storage reported error.', { error });
          reject(error);
          return;
        }
        resolve(result);
      });
    } catch (error) {
      logger.error('Session storage call failed.', { error });
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
  logger.trace('Reading persistent storage key.', { key });
  const data = await promisify('get', key);
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    logger.debug('Persistent storage hit.', { key });
    return data[key];
  }
  logger.debug('Persistent storage miss.', { key });
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
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('Storage set entries must be an object.');
  }
  const keys = Object.keys(entries);
  logger.debug('Setting persistent storage values.', { keys });
  if (keys.length === 0) {
    return entries;
  }
  await setValuesWithFallback(entries);
  return entries;
}

export async function setPersistentValue(key, value) {
  logger.debug('Setting persistent storage value.', { key, hasValue: typeof value !== 'undefined' });
  await setValuesWithFallback({ [key]: value });
  return value;
}

export async function setValueWithFallback(key, value) {
  return setPersistentValue(key, value);
}

export async function setValue(key, value) {
  return setPersistentValue(key, value);
}

/**
 * Removes a value from the persistent storage area.
 *
 * @param {string} key - Storage key to remove.
 * @returns {Promise<void>} Resolves once the key is removed.
 */
export async function removeValue(key) {
  logger.debug('Removing persistent storage key.', { key });
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
    logger.trace('Attempting to acquire storage lock.', { key, attempt });
    const current = await getValue(lockKey);
    const timestamp = resolveTimestamp(current);

    if (timestamp !== null && Date.now() - timestamp > LOCK_STALE_THRESHOLD_MS) {
      logger.warn('Detected stale storage lock.', { key, timestamp });
      await removeValue(lockKey);
      continue;
    }

    if (timestamp === null && current) {
      logger.warn('Removing invalid storage lock payload.', { key });
      await removeValue(lockKey);
      continue;
    }

    if (!current) {
      logger.debug('Acquired storage lock.', { key });
      await setValue(lockKey, { timestamp: Date.now() });
      try {
        const result = await fn();
        logger.trace('Storage lock function completed.', { key });
        return result;
      } finally {
        logger.debug('Releasing storage lock.', { key });
        await removeValue(lockKey);
      }
    }

    attempt += 1;
    if (attempt < maxAttempts) {
      logger.trace('Retrying storage lock acquisition.', { key, attempt });
      await delay(50 * attempt);
    }
  }
  logger.error('Failed to acquire storage lock.', { key });
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
    logger.trace('Session storage unavailable when reading key.', { key });
    return defaultValue;
  }
  const data = await promisifySession(sessionStore.get, key);
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    logger.debug('Session storage hit.', { key });
    return data[key];
  }
  logger.debug('Session storage miss.', { key });
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
    logger.trace('Session storage unavailable when setting key.', { key });
    return value;
  }
  logger.debug('Setting session storage value.', { key, hasValue: typeof value !== 'undefined' });
  await promisifySession(sessionStore.set, { [key]: value });
  return value;
}

export { runtimeProxy as runtime };
