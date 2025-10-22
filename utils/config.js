const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_VERSION = '0.0.0';
const DEFAULT_LOG_LEVEL = 'info';

const LOG_LEVEL_ALIASES = Object.freeze({
  verbose: 'debug',
  warning: 'warn',
  fatal: 'error',
  log: 'info',
});

const VALID_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);
const TRUE_STRINGS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_STRINGS = new Set(['0', 'false', 'no', 'off']);

let cachedManifest;
let manifestLoaded = false;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getGlobalScope() {
  return typeof globalThis !== 'undefined' ? globalThis : undefined;
}

function readManifestFromRuntime(scope) {
  try {
    const runtime = scope?.chrome?.runtime ?? scope?.browser?.runtime;
    if (runtime && typeof runtime.getManifest === 'function') {
      return runtime.getManifest();
    }
  } catch (error) {
    // Ignore manifest lookup failures.
  }
  return null;
}

function getManifest() {
  if (manifestLoaded) {
    return cachedManifest ?? null;
  }

  manifestLoaded = true;
  const scope = getGlobalScope();
  if (!scope) {
    cachedManifest = null;
    return cachedManifest;
  }

  if (scope.__COMET_MANIFEST__ && typeof scope.__COMET_MANIFEST__ === 'object') {
    cachedManifest = scope.__COMET_MANIFEST__;
    return cachedManifest;
  }

  cachedManifest = readManifestFromRuntime(scope);
  if (cachedManifest && typeof cachedManifest === 'object') {
    return cachedManifest;
  }

  cachedManifest = null;
  return cachedManifest;
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
      if (
        current &&
        typeof current === 'object' &&
        Object.prototype.hasOwnProperty.call(current, segment)
      ) {
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

function readString(source, paths) {
  const value = readValue(source, paths);
  if (isNonEmptyString(value)) {
    return value.trim();
  }
  return null;
}

function normaliseLogLevel(level) {
  if (!isNonEmptyString(level)) {
    return null;
  }
  const trimmed = level.trim().toLowerCase();
  const candidate = LOG_LEVEL_ALIASES[trimmed] ?? trimmed;
  if (VALID_LOG_LEVELS.has(candidate)) {
    return candidate;
  }
  return null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalised)) {
      return true;
    }
    if (FALSE_STRINGS.has(normalised)) {
      return false;
    }
  }
  return null;
}

function detectEnvironment() {
  const manifestEnv = readString(getManifest(), [
    'comet.environment',
    'comet.env',
    'environment',
    'env',
  ]);
  if (manifestEnv) {
    return manifestEnv;
  }

  const scopeEnv = readString(getGlobalScope(), [
    'COMET_ENV',
    '__COMET_ENV__',
    'NODE_ENV',
  ]);
  if (scopeEnv) {
    return scopeEnv;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaEnv = readString(import.meta, ['env.COMET_ENV', 'env.MODE', 'env.NODE_ENV']);
    if (metaEnv) {
      return metaEnv;
    }
  }

  const processEnv = readString(typeof process !== 'undefined' ? process : null, [
    'env.COMET_ENV',
    'env.NODE_ENV',
  ]);
  if (processEnv) {
    return processEnv;
  }

  return DEFAULT_ENVIRONMENT;
}

function detectAppVersion() {
  const scopeVersion = readString(getGlobalScope(), [
    'APP_VERSION',
    '__APP_VERSION__',
    'COMET_VERSION',
  ]);
  if (scopeVersion) {
    return scopeVersion;
  }

  const manifestVersion = readString(getManifest(), [
    'comet.version',
    'version',
    'version_name',
    'versionName',
  ]);
  if (manifestVersion) {
    return manifestVersion;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaVersion = readString(import.meta, ['env.APP_VERSION', 'env.COMET_VERSION']);
    if (metaVersion) {
      return metaVersion;
    }
  }

  const processVersion = readString(typeof process !== 'undefined' ? process : null, [
    'env.APP_VERSION',
    'env.COMET_VERSION',
    'env.npm_package_version',
  ]);
  if (processVersion) {
    return processVersion;
  }

  return DEFAULT_VERSION;
}

function detectLogLevel() {
  const manifestLevel = normaliseLogLevel(
    readValue(getManifest(), [
      'comet.logging.level',
      'logging.level',
      'loggingLevel',
      'logLevel',
    ]),
  );
  if (manifestLevel) {
    return manifestLevel;
  }

  const scopeLevel = normaliseLogLevel(
    readValue(getGlobalScope(), [
      'COMET_LOG_LEVEL',
      '__COMET_LOG_LEVEL__',
      'LOG_LEVEL',
    ]),
  );
  if (scopeLevel) {
    return scopeLevel;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaLevel = normaliseLogLevel(
      readValue(import.meta, ['env.COMET_LOG_LEVEL', 'env.LOG_LEVEL']),
    );
    if (metaLevel) {
      return metaLevel;
    }
  }

  const processLevel = normaliseLogLevel(
    readValue(typeof process !== 'undefined' ? process : null, [
      'env.COMET_LOG_LEVEL',
      'env.LOG_LEVEL',
    ]),
  );
  if (processLevel) {
    return processLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

function detectLogFilePath() {
  const manifestPath = readString(getManifest(), [
    'comet.logging.file.path',
    'logging.file.path',
    'logging.filePath',
    'logFile',
  ]);
  if (manifestPath) {
    return manifestPath;
  }

  const scopePath = readString(getGlobalScope(), [
    'COMET_LOG_FILE',
    '__COMET_LOG_FILE__',
    'LOG_FILE',
  ]);
  if (scopePath) {
    return scopePath;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaPath = readString(import.meta, ['env.COMET_LOG_FILE', 'env.LOG_FILE']);
    if (metaPath) {
      return metaPath;
    }
  }

  const processPath = readString(typeof process !== 'undefined' ? process : null, [
    'env.COMET_LOG_FILE',
    'env.LOG_FILE',
  ]);
  if (processPath) {
    return processPath;
  }

  return null;
}

function detectLogFileEnabled(logFilePath) {
  const manifestEnabled = parseBoolean(
    readValue(getManifest(), [
      'comet.logging.file.enabled',
      'logging.file.enabled',
      'logging.fileEnabled',
      'logging.file.enable',
    ]),
  );
  if (manifestEnabled !== null) {
    return manifestEnabled;
  }

  const scopeEnabled = parseBoolean(
    readValue(getGlobalScope(), [
      'COMET_LOG_FILE_ENABLED',
      '__COMET_LOG_FILE_ENABLED__',
      'LOG_FILE_ENABLED',
    ]),
  );
  if (scopeEnabled !== null) {
    return scopeEnabled;
  }

  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env) {
    const metaEnabled = parseBoolean(
      readValue(import.meta, ['env.COMET_LOG_FILE_ENABLED', 'env.LOG_FILE_ENABLED']),
    );
    if (metaEnabled !== null) {
      return metaEnabled;
    }
  }

  const processEnabled = parseBoolean(
    readValue(typeof process !== 'undefined' ? process : null, [
      'env.COMET_LOG_FILE_ENABLED',
      'env.LOG_FILE_ENABLED',
    ]),
  );
  if (processEnabled !== null) {
    return processEnabled;
  }

  return isNonEmptyString(logFilePath);
}

const resolvedEnv = detectEnvironment();
const resolvedAppVersion = detectAppVersion();
const resolvedLogLevel = detectLogLevel();
const resolvedLogFilePath = detectLogFilePath();
const resolvedLogFileEnabled = detectLogFileEnabled(resolvedLogFilePath);

export const ENV = resolvedEnv;
export const APP_VERSION = resolvedAppVersion;
export const LOG_LEVEL = resolvedLogLevel;
export const LOG_FILE_PATH = resolvedLogFilePath;
export const LOG_FILE_ENABLED = resolvedLogFileEnabled;

export function getEnvironment() {
  return ENV;
}

export function getAppVersion() {
  return APP_VERSION;
}

export function getLogLevel() {
  return LOG_LEVEL;
}

export function getLogFilePath() {
  return LOG_FILE_PATH;
}

export function isFileLoggingEnabled() {
  return LOG_FILE_ENABLED;
}

export const env = ENV;
