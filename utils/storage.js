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

const runtime = getBrowserApi();

const LOCK_STALE_THRESHOLD_MS = 10_000;

/**
 * Determines the most suitable persistent storage area available to the
 * extension.
 *
 * @returns {chrome.storage.StorageArea} Storage area instance.
 * @throws {Error} When storage APIs are unavailable.
 */
const resolveStorageArea = () => {
  if (runtime.storage && runtime.storage.sync) {
    return runtime.storage.sync;
  }
  if (runtime.storage && runtime.storage.local) {
    return runtime.storage.local;
  }
  throw new Error('Storage APIs are unavailable.');
};

const storageArea = resolveStorageArea();

const sessionArea = runtime.storage && runtime.storage.session ? runtime.storage.session : null;

/**
 * Promisified wrapper for Chrome-style callback APIs.
 *
 * @param {Function} fn - Storage API function.
 * @param {...*} args - Arguments forwarded to the API.
 * @returns {Promise<*>} Resolved API result.
 */
const promisify = (fn, ...args) => {
  return new Promise((resolve, reject) => {
    try {
      fn.call(storageArea, ...args, result => {
        const err = runtime.runtime && runtime.runtime.lastError;
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
 * Promisified wrapper for session storage APIs.
 *
 * @param {Function} fn - Storage API function.
 * @param {...*} args - Arguments forwarded to the API.
 * @returns {Promise<*>} Resolved API result.
 */
const promisifySession = (fn, ...args) => {
  if (!sessionArea) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    try {
      fn.call(sessionArea, ...args, result => {
        const err = runtime.runtime && runtime.runtime.lastError;
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
  const data = await promisify(storageArea.get, key);
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
export async function setValue(key, value) {
  await promisify(storageArea.set, { [key]: value });
  return value;
}

/**
 * Removes a value from the persistent storage area.
 *
 * @param {string} key - Storage key to remove.
 * @returns {Promise<void>} Resolves once the key is removed.
 */
export async function removeValue(key) {
  await promisify(storageArea.remove, key);
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
  if (!sessionArea) {
    return defaultValue;
  }
  const data = await promisifySession(sessionArea.get, key);
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
  if (!sessionArea) {
    return value;
  }
  await promisifySession(sessionArea.set, { [key]: value });
  return value;
}

export { runtime };
