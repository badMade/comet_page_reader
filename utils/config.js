const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_VERSION = '0.0.0';
const DEFAULT_LOG_LEVEL = 'info';

const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug', 'trace']);

const globalScope = typeof globalThis !== 'undefined' ? globalThis : undefined;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function toPathSegments(path) {
  if (Array.isArray(path)) {
    return path
      .map(segment => (typeof segment === 'string' ? segment.trim() : ''))
      .filter(segment => segment.length > 0);
  }

  if (typeof path !== 'string') {
    return [];
  }

  return path
    .split('.')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

function readValue(source, paths) {
  if (!source || typeof source !== 'object' || !Array.isArray(paths)) {
    return null;
  }

  for (const path of paths) {
    if (!path) {
      continue;
    }

    const segments = toPathSegments(path);
    if (segments.length === 0) {
      continue;
    }

    let current = source;
    let resolved = true;

    for (const segment of segments) {
      if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
        current = current[segment];
      } else {
        resolved = false;
        break;
      }
    }

    if (resolved) {
      return current;
    }
  }

  return null;
}

function readStringValue(source, paths) {
  const value = readValue(source, paths);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

let manifestData;
let manifestResolved = false;

function getManifestData() {
  if (manifestResolved) {
    return manifestData;
  }
  manifestResolved = true;

  if (!globalScope) {
    manifestData = null;
    return manifestData;
  }

  try {
    const runtime = globalScope.chrome?.runtime ?? globalScope.browser?.runtime;
    if (runtime && typeof runtime.getManifest === 'function') {
      const manifest = runtime.getManifest();
      manifestData = manifest && typeof manifest === 'object' ? manifest : null;
    } else {
      manifestData = null;
    }
  } catch (error) {
    manifestData = null;
  }

  return manifestData;
}

function normaliseLogLevel(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const normalised = value.trim().toLowerCase();

  if (normalised === 'warning') {
    return 'warn';
  }
  if (normalised === 'err') {
    return 'error';
  }
  if (normalised === 'log') {
    return 'info';
  }
  if (normalised === 'verbose') {
    return 'debug';
  }

  return VALID_LOG_LEVELS.has(normalised) ? normalised : null;
}

function detectEnvironment() {
  const globalEnv = readStringValue(globalScope, ['COMET_ENV', '__COMET_ENV__', 'NODE_ENV']);
  if (globalEnv) {
    return globalEnv;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaEnv = readStringValue(import.meta.env, ['COMET_ENV', 'MODE', 'NODE_ENV']);
    if (metaEnv) {
      return metaEnv;
    }
  }

  if (typeof process !== 'undefined' && process && process.env) {
    const processEnv = readStringValue(process.env, ['COMET_ENV', 'NODE_ENV']);
    if (processEnv) {
      return processEnv;
    }
  }

  const manifestEnv = readStringValue(getManifestData(), ['comet.environment', 'environment']);
  if (manifestEnv) {
    return manifestEnv;
  }

  return DEFAULT_ENVIRONMENT;
}

function detectAppVersion() {
  const globalVersion = readStringValue(globalScope, ['APP_VERSION', '__APP_VERSION__', 'COMET_VERSION']);
  if (globalVersion) {
    return globalVersion;
  }

  const manifestVersion = readStringValue(getManifestData(), ['version', 'version_name']);
  if (manifestVersion) {
    return manifestVersion;
  }

  if (typeof process !== 'undefined' && process && process.env) {
    const processVersion = readStringValue(process.env, ['APP_VERSION', 'COMET_VERSION', 'npm_package_version']);
    if (processVersion) {
      return processVersion;
    }
  }

  return DEFAULT_VERSION;
}

function detectLogLevel() {
  const globalLevel = normaliseLogLevel(readStringValue(globalScope, ['COMET_LOG_LEVEL', '__COMET_LOG_LEVEL__', 'LOG_LEVEL']));
  if (globalLevel) {
    return globalLevel;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaLevel = normaliseLogLevel(readStringValue(import.meta.env, ['COMET_LOG_LEVEL', 'LOG_LEVEL']));
    if (metaLevel) {
      return metaLevel;
    }
  }

  if (typeof process !== 'undefined' && process && process.env) {
    const processLevel = normaliseLogLevel(readStringValue(process.env, ['COMET_LOG_LEVEL', 'LOG_LEVEL']));
    if (processLevel) {
      return processLevel;
    }
  }

  const manifestLevel = normaliseLogLevel(readStringValue(getManifestData(), ['comet.logLevel', 'comet.log_level', 'logLevel']));
  if (manifestLevel) {
    return manifestLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

let cachedEnvironment;
let environmentResolved = false;

export function getEnvironment() {
  if (!environmentResolved) {
    cachedEnvironment = detectEnvironment();
    environmentResolved = true;
  }
  return cachedEnvironment;
}

let cachedAppVersion;
let appVersionResolved = false;

export function getAppVersion() {
  if (!appVersionResolved) {
    cachedAppVersion = detectAppVersion();
    appVersionResolved = true;
  }
  return cachedAppVersion;
}

let cachedLogLevel;
let logLevelResolved = false;

export function getLogLevel() {
  if (!logLevelResolved) {
    cachedLogLevel = detectLogLevel();
    logLevelResolved = true;
  }
  return cachedLogLevel;
}

export const ENV = getEnvironment();
export const APP_VERSION = getAppVersion();
export const LOG_LEVEL = getLogLevel();
export const env = ENV;

