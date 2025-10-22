const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_VERSION = '0.0.0';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readFromObject(object, keys) {
  if (!object || typeof object !== 'object') {
    return null;
  }
  for (const key of keys) {
    if (isNonEmptyString(object[key])) {
      return object[key].trim();
    }
  }
  return null;
}

function detectEnvironment() {
  const globalEnv = readFromObject(typeof globalThis !== 'undefined' ? globalThis : null, [
    'COMET_ENV',
    '__COMET_ENV__',
    'NODE_ENV',
  ]);
  if (globalEnv) {
    return globalEnv;
  }
  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaEnv = readFromObject(import.meta.env, ['MODE', 'NODE_ENV']);
    if (metaEnv) {
      return metaEnv;
    }
  }
  if (typeof process !== 'undefined' && process && process.env) {
    const processEnv = readFromObject(process.env, ['COMET_ENV', 'NODE_ENV']);
    if (processEnv) {
      return processEnv;
    }
  }
  return DEFAULT_ENVIRONMENT;
}

function detectManifestVersion() {
  const globalScope = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!globalScope) {
    return null;
  }
  try {
    const runtime = globalScope.chrome?.runtime ?? globalScope.browser?.runtime;
    if (runtime && typeof runtime.getManifest === 'function') {
      const manifest = runtime.getManifest();
      if (manifest && isNonEmptyString(manifest.version)) {
        return manifest.version.trim();
      }
    }
  } catch (error) {
    // Ignore manifest lookup failures.
  }
  return null;
}

function detectAppVersion() {
  const globalVersion = readFromObject(typeof globalThis !== 'undefined' ? globalThis : null, [
    'APP_VERSION',
    '__APP_VERSION__',
    'COMET_VERSION',
  ]);
  if (globalVersion) {
    return globalVersion;
  }
  const manifestVersion = detectManifestVersion();
  if (manifestVersion) {
    return manifestVersion;
  }
  if (typeof process !== 'undefined' && process && process.env) {
    const processVersion = readFromObject(process.env, ['APP_VERSION', 'COMET_VERSION', 'npm_package_version']);
    if (processVersion) {
      return processVersion;
    }
  }
  return DEFAULT_VERSION;
}

export function getEnvironment() {
  return detectEnvironment();
}

export function getAppVersion() {
  return detectAppVersion();
}

export const env = getEnvironment();
export const APP_VERSION = getAppVersion();
