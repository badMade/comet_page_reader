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

export async function getValue(key, defaultValue = undefined) {
  const data = await promisify(storageArea.get, key);
  if (data && Object.prototype.hasOwnProperty.call(data, key)) {
    return data[key];
  }
  return defaultValue;
}

export async function setValue(key, value) {
  await promisify(storageArea.set, { [key]: value });
  return value;
}

export async function removeValue(key) {
  await promisify(storageArea.remove, key);
}

export async function withLock(key, fn) {
  const lockKey = `lock:${key}`;
  const maxAttempts = 5;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await getValue(lockKey);
    if (!current) {
      await setValue(lockKey, Date.now());
      try {
        return await fn();
      } finally {
        await removeValue(lockKey);
      }
    }
    await delay(50 * (attempt + 1));
  }
  throw new Error('Failed to acquire storage lock.');
}

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

export async function setSessionValue(key, value) {
  if (!sessionArea) {
    return value;
  }
  await promisifySession(sessionArea.set, { [key]: value });
  return value;
}

export { runtime };
