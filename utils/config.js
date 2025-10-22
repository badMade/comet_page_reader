const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_VERSION = '0.0.0';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_CONSOLE_ENABLED = true;
const DEFAULT_FILE_ENABLED = false;

const globalScope = typeof globalThis !== 'undefined' ? globalThis : null;
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

let manifestCache = null;
let manifestLoaded = false;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function toPathSegments(path) {
  if (Array.isArray(path)) {
    return path
      .filter(segment => typeof segment === 'string')
      .map(segment => segment.trim())
      .filter(trimmedSegment => trimmedSegment.length > 0);
  }
  if (typeof path !== 'string') {
    return [];
  }
  return path
    .split('.')
    .map(segment => segment.trim())
    .filter(trimmedSegment => trimmedSegment.length > 0);
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

function loadManifest() {
  if (manifestLoaded) {
    return manifestCache;
  }
  manifestLoaded = true;

  if (!globalScope) {
    manifestCache = null;
    return manifestCache;
  }

  try {
    const runtime = globalScope.chrome?.runtime ?? globalScope.browser?.runtime;
    if (runtime && typeof runtime.getManifest === 'function') {
      manifestCache = runtime.getManifest();
      return manifestCache;
    }
  } catch (error) {
    // Ignore manifest lookup failures.
  }

  manifestCache = null;
  return manifestCache;
}

function normaliseLogLevel(level) {
  if (typeof level !== 'string') {
    return null;
  }
  const trimmed = level.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (['error', 'warn', 'info', 'debug', 'trace'].includes(lowered)) {
    return lowered;
  }
  if (lowered === 'warning') {
    return 'warn';
  }
  if (lowered === 'verbose') {
    return 'debug';
  }
  return null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return null;
    }
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }
    if (['1', 'true', 'yes', 'on', 'enabled', 'y'].includes(trimmed)) {
      return true;
    }
    if (['0', 'false', 'no', 'off', 'disabled', 'n'].includes(trimmed)) {
      return false;
    }
    return null;
  }
  return null;
}

function getEnvironment() {
  const manifest = loadManifest();
  const manifestEnv = readValue(manifest, [
    ['comet', 'environment'],
    ['comet', 'env'],
    ['environment'],
    ['env'],
    ['logging', 'environment'],
  ]);
  if (isNonEmptyString(manifestEnv)) {
    return manifestEnv.trim();
  }

  const globalEnv = readValue(globalScope, ['COMET_ENV', '__COMET_ENV__', 'NODE_ENV']);
  if (isNonEmptyString(globalEnv)) {
    return globalEnv.trim();
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaEnv = readValue(import.meta.env, ['COMET_ENV', 'MODE', 'NODE_ENV']);
    if (isNonEmptyString(metaEnv)) {
      return metaEnv.trim();
    }
  }

  if (isNode && process?.env) {
    const processEnv = readValue(process.env, ['COMET_ENV', 'NODE_ENV']);
    if (isNonEmptyString(processEnv)) {
      return processEnv.trim();
    }
  }

  return DEFAULT_ENVIRONMENT;
}

function getAppVersion() {
  const globalVersion = readValue(globalScope, ['APP_VERSION', '__APP_VERSION__', 'COMET_VERSION']);
  if (isNonEmptyString(globalVersion)) {
    return globalVersion.trim();
  }

  const manifest = loadManifest();
  const manifestVersion = readValue(manifest, [['comet', 'version'], ['version']]);
  if (isNonEmptyString(manifestVersion)) {
    return manifestVersion.trim();
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaVersion = readValue(import.meta.env, ['APP_VERSION', 'COMET_VERSION', 'npm_package_version']);
    if (isNonEmptyString(metaVersion)) {
      return metaVersion.trim();
    }
  }

  if (isNode && process?.env) {
    const processVersion = readValue(process.env, ['APP_VERSION', 'COMET_VERSION', 'npm_package_version']);
    if (isNonEmptyString(processVersion)) {
      return processVersion.trim();
    }
  }

  return DEFAULT_VERSION;
}

function getLogLevel() {
  const manifest = loadManifest();
  const manifestLevel = normaliseLogLevel(
    readValue(manifest, [
      ['comet', 'logging', 'level'],
      ['comet', 'logLevel'],
      ['logging', 'level'],
      ['logLevel'],
    ]),
  );
  if (manifestLevel) {
    return manifestLevel;
  }

  const globalLevel = normaliseLogLevel(readValue(globalScope, ['COMET_LOG_LEVEL', 'LOG_LEVEL']));
  if (globalLevel) {
    return globalLevel;
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaLevel = normaliseLogLevel(readValue(import.meta.env, ['COMET_LOG_LEVEL', 'LOG_LEVEL']));
    if (metaLevel) {
      return metaLevel;
    }
  }

  if (isNode && process?.env) {
    const processLevel = normaliseLogLevel(readValue(process.env, ['COMET_LOG_LEVEL', 'LOG_LEVEL']));
    if (processLevel) {
      return processLevel;
    }
  }

  return DEFAULT_LOG_LEVEL;
}

function getConsoleLoggingEnabled() {
  const manifest = loadManifest();
  const manifestConsole = parseBoolean(
    readValue(manifest, [
      ['comet', 'logging', 'console', 'enabled'],
      ['logging', 'console', 'enabled'],
      ['console', 'enabled'],
    ]),
  );
  if (manifestConsole !== null) {
    return manifestConsole;
  }

  const globalConsole = parseBoolean(readValue(globalScope, ['COMET_LOG_CONSOLE', 'LOG_CONSOLE']));
  if (globalConsole !== null) {
    return globalConsole;
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaConsole = parseBoolean(readValue(import.meta.env, ['COMET_LOG_CONSOLE', 'LOG_CONSOLE']));
    if (metaConsole !== null) {
      return metaConsole;
    }
  }

  if (isNode && process?.env) {
    const processConsole = parseBoolean(readValue(process.env, ['COMET_LOG_CONSOLE', 'LOG_CONSOLE']));
    if (processConsole !== null) {
      return processConsole;
    }
  }

  return DEFAULT_CONSOLE_ENABLED;
}

function getFileLoggingEnabled() {
  const manifest = loadManifest();
  const manifestFile = parseBoolean(
    readValue(manifest, [
      ['comet', 'logging', 'file', 'enabled'],
      ['logging', 'file', 'enabled'],
    ]),
  );
  if (manifestFile !== null) {
    return manifestFile;
  }

  const globalFile = parseBoolean(readValue(globalScope, ['COMET_LOG_FILE_ENABLED', 'LOG_FILE_ENABLED']));
  if (globalFile !== null) {
    return globalFile;
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaFile = parseBoolean(readValue(import.meta.env, ['COMET_LOG_FILE_ENABLED', 'LOG_FILE_ENABLED']));
    if (metaFile !== null) {
      return metaFile;
    }
  }

  if (isNode && process?.env) {
    const processFile = parseBoolean(readValue(process.env, ['COMET_LOG_FILE_ENABLED', 'LOG_FILE_ENABLED']));
    if (processFile !== null) {
      return processFile;
    }
  }

  return DEFAULT_FILE_ENABLED;
}

function getLogFilePath() {
  const manifest = loadManifest();
  const manifestPath = readValue(manifest, [
    ['comet', 'logging', 'file', 'path'],
    ['logging', 'file', 'path'],
    ['logFilePath'],
  ]);
  if (isNonEmptyString(manifestPath)) {
    return manifestPath.trim();
  }

  const globalPath = readValue(globalScope, ['COMET_LOG_FILE', 'LOG_FILE', 'LOG_FILE_PATH']);
  if (isNonEmptyString(globalPath)) {
    return String(globalPath).trim();
  }

  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const metaPath = readValue(import.meta.env, ['COMET_LOG_FILE', 'LOG_FILE', 'LOG_FILE_PATH']);
    if (isNonEmptyString(metaPath)) {
      return String(metaPath).trim();
    }
  }

  if (isNode && process?.env) {
    const processPath = readValue(process.env, ['COMET_LOG_FILE', 'LOG_FILE', 'LOG_FILE_PATH']);
    if (isNonEmptyString(processPath)) {
      return String(processPath).trim();
    }
  }

  return null;
}

export {
  getEnvironment,
  getAppVersion,
  getLogLevel,
  getConsoleLoggingEnabled,
  getFileLoggingEnabled,
  getLogFilePath,
  loadManifest,
  normaliseLogLevel,
  parseBoolean,
  readValue,
  toPathSegments,
};

export const ENV = getEnvironment();
export const APP_VERSION = getAppVersion();
export const LOG_LEVEL = getLogLevel();
export const CONSOLE_LOGGING_ENABLED = getConsoleLoggingEnabled();
export const LOG_FILE_ENABLED = getFileLoggingEnabled();
export const LOG_FILE_PATH = getLogFilePath();
