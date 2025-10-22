const DEFAULTS = Object.freeze({
  ENVIRONMENT: 'production',
  VERSION: '0.0.0',
  LOG_LEVEL: 'info',
  ENABLE_TRACE: false,
});

const LOG_LEVEL_ALIASES = Object.freeze({
  verbose: 'debug',
  warning: 'warn',
  warnings: 'warn',
  err: 'error',
  error: 'error',
  errors: 'error',
  fatal: 'error',
  critical: 'error',
  log: 'info',
});

function getGlobalScope() {
  if (typeof globalThis !== 'undefined') {
    return globalThis;
  }
  if (typeof self !== 'undefined') {
    return self;
  }
  if (typeof window !== 'undefined') {
    return window;
  }
  if (typeof global !== 'undefined') {
    return global;
  }
  return undefined;
}

const GLOBAL_SCOPE = getGlobalScope();
const isNode = typeof process !== 'undefined' && !!process?.versions?.node;
const ENV_VARS = isNode && typeof process?.env === 'object' ? process.env : null;

function loadManifest() {
  if (!GLOBAL_SCOPE) {
    return null;
  }
  const runtime = GLOBAL_SCOPE.chrome?.runtime ?? GLOBAL_SCOPE.browser?.runtime;
  if (!runtime || typeof runtime.getManifest !== 'function') {
    return null;
  }
  try {
    return runtime.getManifest();
  } catch (error) {
    // Ignore manifest lookup errors and fall back to environment variables.
    return null;
  }
}

const MANIFEST = loadManifest();

function toPathSegments(path) {
  if (Array.isArray(path)) {
    return path.filter(segment => typeof segment === 'string' && segment.length > 0);
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
  if (!source || typeof source !== 'object') {
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

    if (resolved && typeof current !== 'undefined' && current !== null) {
      return current;
    }
  }

  return null;
}

function toTrimmedString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function toEnvString(value) {
  const stringValue = toTrimmedString(value);
  if (!stringValue) {
    return null;
  }
  return stringValue.toLowerCase();
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const stringValue = toTrimmedString(value);
  if (!stringValue) {
    return null;
  }

  const normalised = stringValue.toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalised)) {
    return true;
  }
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalised)) {
    return false;
  }
  return null;
}

function normaliseLogLevel(value) {
  const stringValue = toTrimmedString(value);
  if (!stringValue) {
    return null;
  }

  const normalised = stringValue.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOG_LEVEL_ALIASES, normalised)) {
    return LOG_LEVEL_ALIASES[normalised];
  }

  if (['trace', 'debug', 'info', 'warn', 'error'].includes(normalised)) {
    return normalised;
  }

  return null;
}

const manifestTrace = parseBoolean(
  readValue(MANIFEST, [
    ['logging', 'enableTrace'],
    ['logging', 'trace'],
    ['comet', 'enableTrace'],
    ['comet', 'logging', 'trace'],
    ['comet', 'logging', 'enableTrace'],
    ['enableTrace'],
    ['ENABLE_TRACE'],
    ['trace'],
  ])
);

const envTrace = parseBoolean(
  readValue(ENV_VARS, ['COMET_ENABLE_TRACE', 'ENABLE_TRACE', 'TRACE', 'COMET_TRACE'])
);

const ENABLE_TRACE =
  typeof manifestTrace === 'boolean'
    ? manifestTrace
    : typeof envTrace === 'boolean'
      ? envTrace
      : DEFAULTS.ENABLE_TRACE;

const manifestLogLevel = normaliseLogLevel(
  readValue(MANIFEST, [
    ['logging', 'level'],
    ['logging', 'threshold'],
    ['comet', 'logLevel'],
    ['comet', 'logging', 'level'],
    ['comet', 'logging', 'threshold'],
    ['logLevel'],
    ['LOG_LEVEL'],
    ['log_level'],
  ])
);

const envLogLevel = normaliseLogLevel(
  readValue(ENV_VARS, ['COMET_LOG_LEVEL', 'LOG_LEVEL', 'npm_package_config_log_level'])
);

const LOG_LEVEL =
  manifestLogLevel ?? envLogLevel ?? (ENABLE_TRACE ? 'trace' : DEFAULTS.LOG_LEVEL);

const manifestEnv = toEnvString(
  readValue(MANIFEST, [
    ['environment'],
    ['env'],
    ['mode'],
    ['comet', 'environment'],
    ['comet', 'env'],
    ['comet', 'mode'],
  ])
);

const envEnv = toEnvString(readValue(ENV_VARS, ['COMET_ENV', 'NODE_ENV', 'ENV']));

const ENV = manifestEnv ?? envEnv ?? DEFAULTS.ENVIRONMENT;

const manifestVersion = toTrimmedString(
  readValue(MANIFEST, [
    ['version_name'],
    ['version'],
    ['appVersion'],
    ['comet', 'version'],
  ])
);

const envVersion = toTrimmedString(
  readValue(ENV_VARS, ['APP_VERSION', 'COMET_VERSION', 'npm_package_version', 'VERSION'])
);

const APP_VERSION = manifestVersion ?? envVersion ?? DEFAULTS.VERSION;

export { LOG_LEVEL, ENABLE_TRACE, APP_VERSION, ENV };
