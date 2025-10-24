/**
 * Structured logging utilities shared by Node.js and browser runtimes.
 *
 * The module exposes sanitised, context-aware loggers that support console
 * output everywhere and optional asynchronous file persistence when running
 * under Node.js. Configuration can be provided programmatically or sourced
 * from JSON/YAML manifests to keep behaviour consistent across environments.
 */
import { APP_VERSION, ENV, LOG_LEVEL, ENABLE_TRACE } from './config.js';
const LOG_LEVELS = Object.freeze({
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
});

const SENSITIVE_KEY_PATTERNS = [
  /key|token|secret|password|authorization/i,
  /session[-_]?id/i,
];

const DEFAULT_CONFIG = {
  level: LOG_LEVEL,
  console: {
    enabled: true,
  },
  file: {
    enabled: false,
    path: null,
  },
  context: {},
};

let activeConfig = {
  ...DEFAULT_CONFIG,
};

const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

let globalContext = {};
let AsyncLocalStorageClass = typeof globalThis?.AsyncLocalStorage === 'function'
  ? globalThis.AsyncLocalStorage
  : null;

if (!AsyncLocalStorageClass && isNode) {
  try {
    const asyncHooks = await import('node:async_hooks');
    if (asyncHooks?.AsyncLocalStorage) {
      AsyncLocalStorageClass = asyncHooks.AsyncLocalStorage;
    }
  } catch (error) {
    // Continue without AsyncLocalStorage support when the module is unavailable.
  }
}

class ExecutionContextManager {
  constructor() {
    this.asyncLocal = AsyncLocalStorageClass ? new AsyncLocalStorageClass() : null;
    this.browserTokens = new Map();
    this.activeToken = null;
  }

  run(context, callback) {
    if (this.asyncLocal) {
      const current = this.asyncLocal.getStore();
      const baseStack = Array.isArray(current) ? current : [];
      const hasContext = context && typeof context === 'object' && Object.keys(context).length > 0;
      const nextStack = hasContext ? [...baseStack, context] : baseStack;
      if (nextStack === current) {
        return callback();
      }
      return this.asyncLocal.run(nextStack, callback);
    }

    return this.runFallback(context, callback);
  }

  runFallback(context, callback) {
    const hasContext = context && typeof context === 'object' && Object.keys(context).length > 0;
    if (!hasContext) {
      return callback();
    }

    const parentToken = this.activeToken;
    const parentStack = parentToken ? this.browserTokens.get(parentToken) || [] : [];
    const token = Symbol('logger-scope');
    const stack = [...parentStack, context];

    this.browserTokens.set(token, stack);
    this.activeToken = token;

    const restore = () => {
      this.browserTokens.delete(token);
      this.activeToken = parentToken || null;
    };

    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        return result.finally(restore);
      }
      restore();
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  }

  getCurrentScopes() {
    if (this.asyncLocal) {
      const store = this.asyncLocal.getStore();
      return Array.isArray(store) ? store : [];
    }

    if (!this.activeToken) {
      return [];
    }

    const stack = this.browserTokens.get(this.activeToken);
    return Array.isArray(stack) ? stack : [];
  }

  getCurrentContext() {
    const scopes = this.getCurrentScopes();
    if (!scopes || scopes.length === 0) {
      return {};
    }
    return scopes.reduce((accumulator, scope) => ({ ...accumulator, ...scope }), {});
  }
}

const scopeManager = new ExecutionContextManager();

let fileStream = null;
let fsModule;

let yamlParserPromise = null;

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return val;
      }
    );
  } catch (error) {
    try {
      return String(value);
    } catch (stringifyError) {
      return '[Unserializable]';
    }
  }
}

function parseScalar(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }
  if (!Number.isNaN(Number(value))) {
    return Number(value);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIndentedYaml(rawConfig) {
  const lines = rawConfig.split(/\r?\n/);
  const stack = [{ indent: -1, value: {} }];

  lines.forEach(line => {
    if (!line || !line.trim() || line.trim().startsWith('#')) {
      return;
    }
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`Unable to parse YAML line: "${trimmed}"`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const remainder = trimmed.slice(separatorIndex + 1).trim();

    if (!remainder) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      return;
    }

    parent[key] = parseScalar(remainder);
  });

  return stack[0].value;
}

async function getYamlParser() {
  if (yamlParserPromise) {
    return yamlParserPromise;
  }

  if (!isNode) {
    yamlParserPromise = Promise.resolve(null);
    return yamlParserPromise;
  }

  yamlParserPromise = import('yaml')
    .then(module => {
      if (module && typeof module.parse === 'function') {
        return module.parse.bind(module);
      }
      if (module?.default && typeof module.default.parse === 'function') {
        return module.default.parse.bind(module.default);
      }
      return null;
    })
    .catch(error => {
      console.error('[logger] Failed to load YAML parser module.', error);
      return null;
    });

  return yamlParserPromise;
}

async function parseLoggingConfig(rawConfig) {
  if (!rawConfig) {
    return null;
  }

  try {
    return JSON.parse(rawConfig);
  } catch (jsonError) {
    // Continue to YAML parsing fallback paths.
  }

  const yamlParser = await getYamlParser();
  if (yamlParser) {
    try {
      return yamlParser(rawConfig);
    } catch (yamlError) {
      console.error('[logger] Failed to parse YAML configuration using yaml module.', yamlError);
    }
  }

  try {
    return parseIndentedYaml(rawConfig);
  } catch (fallbackError) {
    console.error('[logger] Failed to parse YAML configuration using fallback parser.', fallbackError);
  }

  return null;
}

function resolveConfigPath(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    return configPath;
  }

  if (isNode) {
    return configPath;
  }

  try {
    const runtime = globalThis.chrome?.runtime ?? globalThis.browser?.runtime;

    if (runtime?.getURL) {
      return runtime.getURL(configPath);
    }
  } catch (error) {
    // Ignore resolution failures and fall back to the provided path.
  }

  return configPath;
}

function normaliseLevel(level) {
  if (typeof level !== 'string') {
    return activeConfig.level;
  }
  const normalised = level.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalised)) {
    return normalised;
  }
  return activeConfig.level;
}

function shouldLog(level) {
  const rank = LOG_LEVELS[normaliseLevel(level)];
  const threshold = LOG_LEVELS[normaliseLevel(activeConfig.level)];
  return rank <= threshold;
}

function redactValue(value) {
  if (typeof value === 'string' && value) {
    return '[REDACTED]';
  }
  if (value && typeof value === 'object') {
    return Array.isArray(value) ? value.map(redactValue) : '[REDACTED]';
  }
  return '[REDACTED]';
}

function sanitizeMeta(meta) {
  if (!meta) {
    return meta;
  }
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    };
  }
  if (Array.isArray(meta)) {
    return meta.map(item => sanitizeMeta(item));
  }
  if (typeof meta === 'object') {
    const sanitized = {};
    Object.entries(meta).forEach(([key, value]) => {
      if (value instanceof Error) {
        sanitized[key] = {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
        return;
      }
      if (SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key))) {
        sanitized[key] = redactValue(value);
        return;
      }
      sanitized[key] = sanitizeMeta(value);
    });
    return sanitized;
  }
  return meta;
}

function collectScopeContext() {
  return scopeManager.getCurrentContext();
}

function mergeContexts(...contexts) {
  const merged = {};
  for (const context of contexts) {
    if (!context || typeof context !== 'object') {
      continue;
    }
    Object.entries(context).forEach(([key, value]) => {
      if (typeof value === 'undefined') {
        return;
      }
      merged[key] = value;
    });
  }
  return merged;
}

function extractCorrelationId(...contexts) {
  for (const context of contexts) {
    if (!context || typeof context !== 'object') {
      continue;
    }
    const candidate = context.correlationId;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function normaliseCorrelationId(id) {
  if (typeof id !== 'string') {
    return null;
  }
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createCorrelationId(prefix = '') {
  const normalisedPrefix = typeof prefix === 'string' && prefix.trim() ? prefix.trim() : '';
  const cryptoRef = globalThis?.crypto;

  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    const uuid = cryptoRef.randomUUID();
    return normalisedPrefix ? `${normalisedPrefix}-${uuid}` : uuid;
  }

  const random = Math.random().toString(36).slice(2, 8);
  const timestamp = Date.now().toString(36);

  if (!normalisedPrefix) {
    return `${timestamp}-${random}`;
  }

  return `${normalisedPrefix}-${timestamp}-${random}`;
}

function redactStackString(stack) {
  if (typeof stack !== 'string' || stack.length === 0) {
    return null;
  }
  return stack
    .split('\n')
    .map(line => {
      if (!line) {
        return line;
      }
      let redacted = line.replace(/\(([^)]+)\)/g, (_, value) => {
        if (!value) {
          return '()';
        }
        return '([REDACTED])';
      });
      redacted = redacted.replace(/(https?:\/\/|file:\/\/|chrome-extension:\/\/)[^\s)]+/gi, (_, protocol) => `${protocol}[REDACTED]`);
      redacted = redacted.replace(/(?:^|\s)([A-Za-z]:\\[^\s)]+|\/[^\s)]+)/g, match => {
        const prefix = match.startsWith(' ') ? ' ' : '';
        return `${prefix}[REDACTED]`;
      });
      return redacted;
    })
    .join('\n');
}

function buildStackTrace(error) {
  if (!error || !(error instanceof Error)) {
    return null;
  }
  const seen = new Set();
  const segments = [];
  let current = error;
  while (current && current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const stack = typeof current.stack === 'string' && current.stack.trim().length > 0
      ? current.stack
      : [current.name, current.message].filter(Boolean).join(': ');
    if (stack) {
      const redacted = redactStackString(stack);
      if (redacted) {
        segments.push(redacted);
      }
    }
    if (current.cause instanceof Error) {
      current = current.cause;
      continue;
    }
    break;
  }
  return segments.length > 0 ? segments.join('\nCaused by: ') : null;
}

function detectError(messageOrMeta, meta) {
  if (messageOrMeta instanceof Error) {
    return messageOrMeta;
  }
  if (meta instanceof Error) {
    return meta;
  }
  if (meta && typeof meta === 'object') {
    if (meta.error instanceof Error) {
      return meta.error;
    }
    if (meta.reason instanceof Error) {
      return meta.reason;
    }
    if (meta.cause instanceof Error) {
      return meta.cause;
    }
  }
  return null;
}

async function ensureFileStream() {
  if (!isNode || !activeConfig.file?.enabled || !activeConfig.file?.path) {
    return null;
  }
  if (fileStream) {
    return fileStream;
  }
  try {
    if (!fsModule) {
      fsModule = await import('node:fs');
    }
    fileStream = fsModule.createWriteStream(activeConfig.file.path, { flags: 'a' });
    return fileStream;
  } catch (error) {
    console.error('[logger] Failed to initialise file logging.', error);
    return null;
  }
}

async function writeToFile(entry) {
  const stream = await ensureFileStream();
  if (!stream) {
    return;
  }
  try {
    stream.write(`${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error('[logger] Failed to write log entry.', error);
  }
}

function normaliseMessage(message) {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  if (message && typeof message === 'object') {
    return JSON.stringify(sanitizeMeta(message));
  }
  if (typeof message === 'undefined') {
    return '';
  }
  return String(message);
}

function selectConsoleMethod(level) {
  const normalised = normaliseLevel(level);
  if (normalised === 'fatal' || normalised === 'error') {
    return 'error';
  }
  if (normalised === 'warn') {
    return 'warn';
  }
  if (normalised === 'trace') {
    if (ENABLE_TRACE && typeof console?.trace === 'function') { // Simplified condition
      return 'trace';
    }
    return 'debug';
  }
  if (normalised === 'debug') {
    return 'debug';
  }
  return 'info';
}

function formatPrettyEntry(entry) {
  const { ts, level, component, msg, stack, correlationId, context, env, version } = entry;
  const headline = `${ts} [${level.toUpperCase()}] (${component}) ${msg}`;
  const details = { env, version };
  if (correlationId) {
    details.correlationId = correlationId;
  }
  if (stack) {
    details.stack = stack;
  }
  if (context && Object.keys(context).length > 0) {
    details.context = context;
  }
  const suffix = safeStringify(details);
  return suffix && suffix !== '{}' ? `${headline} ${suffix}` : headline;
}

async function emitLog(level, loggerInstance, message, meta) {
  if (!shouldLog(level)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const error = detectError(message, meta);
  const loggerName = typeof loggerInstance?.name === 'string' && loggerInstance.name.trim().length > 0
    ? loggerInstance.name.trim()
    : 'root';
  const componentName = typeof loggerInstance?.component === 'string' && loggerInstance.component.trim().length > 0
    ? loggerInstance.component.trim()
    : loggerName;
  const environment = typeof ENV === 'string' && ENV ? ENV : 'production';
  const version = typeof APP_VERSION === 'string' && APP_VERSION ? APP_VERSION : '0.0.0';

  const scopedContext = sanitizeMeta(collectScopeContext());
  const mergedContext = mergeContexts(
    sanitizeMeta(activeConfig.context || {}),
    sanitizeMeta(globalContext),
    scopedContext,
    sanitizeMeta(loggerInstance?.context || {}),
  );
  const additionalMeta = sanitizeMeta(meta);
  const correlationId = extractCorrelationId(additionalMeta, mergedContext, scopedContext, loggerInstance?.context, globalContext);
  const contextWithoutReserved = { ...mergedContext };
  if (typeof contextWithoutReserved.component !== 'undefined') {
    delete contextWithoutReserved.component;
  }
  if (typeof contextWithoutReserved.correlationId !== 'undefined') {
    delete contextWithoutReserved.correlationId;
  }
  if (additionalMeta && typeof additionalMeta === 'object') {
    delete additionalMeta.correlationId;
  }

  const stack = error ? buildStackTrace(error) : null;
  const contextPayload = { ...contextWithoutReserved };
  if (additionalMeta && typeof additionalMeta === 'object' && Object.keys(additionalMeta).length > 0) {
    const existingMeta = contextPayload.meta && typeof contextPayload.meta === 'object' ? contextPayload.meta : {};
    contextPayload.meta = { ...existingMeta, ...additionalMeta };
  }

  const entry = {
    ts: timestamp,
    level: normaliseLevel(level),
    msg: normaliseMessage(message),
    stack: stack ?? null,
    context: contextPayload,
    component: mergedContext.component && typeof mergedContext.component === 'string' && mergedContext.component.trim().length > 0
      ? mergedContext.component.trim()
      : componentName,
    correlationId: correlationId ?? null,
    env: environment,
    version,
  };

  if (activeConfig.console?.enabled !== false) {
    const consoleMethod = selectConsoleMethod(level);
    if (environment === 'production') {
      console[consoleMethod](JSON.stringify(entry));
    } else {
      console[consoleMethod](formatPrettyEntry(entry));
    }
  }

  await writeToFile(entry);
}

/**
 * Merge additional context into the shared global logging scope.
 *
 * @param {Object} context Key-value pairs to expose with every log entry. Values
 *   are sanitised to remove sensitive keys and to serialise nested errors.
 *
 * @returns {void}
 *
 *
 */
export function setGlobalContext(context) {
  if (!context || typeof context !== 'object') {
    return;
  }
  globalContext = {
    ...globalContext,
    ...sanitizeMeta(context),
  };
}

/**
 * Remove all values from the shared global logging scope.
 *
 * This reset is useful in long-lived browser sessions where contextual data
 * should not leak between users or permission changes.
 *
 * @returns {void}
 *
 */
export function clearGlobalContext() {
  globalContext = {};
}

/**
 * Update logger configuration in-place.
 *
 * @param {Object} config Partial configuration containing console/file toggles,
 *   logging thresholds, or default context. Unknown values are merged and
 *   the log level is normalised to a supported severity.
 *
 * @returns {void}
 *
 *
 */
export function setLoggerConfig(config) {
  if (!config || typeof config !== 'object') {
    return;
  }
  const nextConfig = {
    ...activeConfig,
    ...config,
  };
  if (config.level) {
    nextConfig.level = normaliseLevel(config.level);
  }
  activeConfig = nextConfig;
  if (!activeConfig.console) {
    activeConfig.console = { enabled: true };
  }
  if (!activeConfig.file) {
    activeConfig.file = { enabled: false, path: null };
  }
}

/**
 * Obtain a copy of the active logger configuration.
 *
 * @returns {Object} A shallow clone of the configuration so callers cannot mutate the
 *   internal state directly.
 */

export function getLoggerConfig() {
  return { ...activeConfig };
}

/**
 * Load logger configuration from disk or remote assets.
 *
 * @param {string} [configPath='logging_config.yaml'] Relative path or URL used to fetch JSON/YAML
 *   settings. Defaults to `logging_config.yaml` in both Node.js and
 *   browser-based environments.
 *
 * @returns {Promise<void>} Resolves once configuration is parsed and applied. Errors
 *   are logged to the console and suppressed when the default manifest is
 *   missing.
 */
export async function loadLoggingConfig(configPath = 'logging_config.yaml') {
  try {
    let rawConfig = null;
    if (isNode) {
      const fs = await import('node:fs/promises');
      try {
        rawConfig = await fs.readFile(configPath, 'utf8');
      } catch (readError) {
        if (configPath !== 'logging_config.yaml') {
          throw readError;
        }
        return;
      }
    } else if (typeof fetch === 'function') {
      const resolvedPath = resolveConfigPath(configPath);
      try {
        const response = await fetch(resolvedPath);
        if (response.ok) {
          rawConfig = await response.text();
        } else if (configPath !== 'logging_config.yaml') {
          throw new Error(`Failed to load logging configuration: ${response.status}`);
        } else {
          return;
        }
      } catch (fetchError) {
        if (configPath !== 'logging_config.yaml') {
          throw fetchError;
        }
        return;
      }
    }
    if (!rawConfig) {
      return;
    }
    const parsed = await parseLoggingConfig(rawConfig);
    if (parsed && typeof parsed === 'object') {
      setLoggerConfig(parsed);
    }
  } catch (error) {
    console.error('[logger] Failed to load logging configuration.', error);
  }
}

/** @internal */
class StructuredLogger {
  constructor(name, context = {}, component = null) {
    this.name = name || 'root';
    this.component = typeof component === 'string' && component.trim().length > 0 ? component.trim() : this.name;
    this.context = { ...context };
  }

  child(extraContext = {}) {
    return new StructuredLogger(this.name, { ...this.context, ...sanitizeMeta(extraContext) }, this.component);
  }

  extend(extraContext = {}) {
    this.context = { ...this.context, ...sanitizeMeta(extraContext) };
  }

  withCorrelation(id) {
    const correlationId = normaliseCorrelationId(id);
    if (!correlationId) {
      return this;
    }
    return this.child({ correlationId });
  }

  wrap(fn, ctx = {}) {
    return wrapSyncFunction(fn, ensureLoggerContext(ctx, this));
  }

  wrapAsync(fn, ctx = {}) {
    return wrapAsyncFunction(fn, ensureLoggerContext(ctx, this));
  }

  async trace(message, meta) {
    await emitLog('trace', this, message, meta);
  }

  async debug(message, meta) {
    await emitLog('debug', this, message, meta);
  }

  async info(message, meta) {
    await emitLog('info', this, message, meta);
  }

  async warn(message, meta) {
    await emitLog('warn', this, message, meta);
  }

  async error(message, meta) {
    await emitLog('error', this, message, meta);
  }

  async fatal(message, meta) {
    await emitLog('fatal', this, message, meta);
  }
}

const fallbackLogger = new StructuredLogger('runtime', {}, 'runtime');
const DEFAULT_WRAP_ERROR_MESSAGE = 'Unhandled error in wrapped function.';

function resolveScopeContext(rawContext, args) {
  const resolved = typeof rawContext === 'function' ? rawContext(...args) : rawContext;
  if (!resolved || typeof resolved !== 'object') {
    return { context: null, logger: null, errorMessage: DEFAULT_WRAP_ERROR_MESSAGE };
  }
  const { logger, errorMessage, message, ...rest } = resolved;
  const loggerRef = logger && typeof logger.error === 'function' ? logger : null;
  let finalErrorMessage = DEFAULT_WRAP_ERROR_MESSAGE;
  if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
    finalErrorMessage = errorMessage.trim();
  } else if (errorMessage === null || errorMessage === false) {
    finalErrorMessage = null;
  } else if (typeof message === 'string' && message.trim().length > 0) {
    finalErrorMessage = message.trim();
  }
  const sanitisedContext = sanitizeMeta(rest);
  return {
    context: sanitisedContext && Object.keys(sanitisedContext).length > 0 ? sanitisedContext : null,
    logger: loggerRef,
    errorMessage: finalErrorMessage,
  };
}

function logWrappedError(logger, message, error) {
  if (!message) {
    return;
  }
  const target = logger && typeof logger.error === 'function' ? logger : fallbackLogger;
  const meta = { error };
  Promise.resolve(target.error(message, meta)).catch(() => {});
}

function wrapSyncFunction(fn, ctx = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('wrap requires a function');
  }
  return (...args) => {
    const { context, logger, errorMessage } = resolveScopeContext(ctx, args);
    const invoke = () => {
      try {
        return fn(...args);
      } catch (error) {
        logWrappedError(logger, errorMessage, error);
        throw error;
      }
    };
    return scopeManager.run(context, invoke);
  };
}

function wrapAsyncFunction(fn, ctx = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('wrapAsync requires a function');
  }
  return async (...args) => {
    const { context, logger, errorMessage } = resolveScopeContext(ctx, args);
    const invoke = async () => {
      try {
        return await fn(...args);
      } catch (error) {
        logWrappedError(logger, errorMessage, error);
        throw error;
      }
    };
    return scopeManager.run(context, invoke);
  };
}

function ensureLoggerContext(ctx, loggerInstance) {
  if (typeof ctx === 'function') {
    return (...args) => {
      const resolved = ctx(...args);
      if (!resolved || typeof resolved !== 'object') {
        return { logger: loggerInstance };
      }
      if (resolved.logger && typeof resolved.logger.error === 'function') {
        return resolved;
      }
      return { ...resolved, logger: loggerInstance };
    };
  }
  if (!ctx || typeof ctx !== 'object') {
    return { logger: loggerInstance };
  }
  const context = { ...ctx };
  if (!context.logger || typeof context.logger.error !== 'function') {
    context.logger = loggerInstance;
  }
  return context;
}

export function withCorrelation(id) {
  const correlationId = normaliseCorrelationId(id);
  return correlationId ? { correlationId } : {};
}

export function wrap(fn, ctx = {}) {
  return wrapSyncFunction(fn, ctx);
}

export function wrapAsync(fn, ctx = {}) {
  return wrapAsyncFunction(fn, ctx);
}

/**
 * Create a structured logger instance.
 *
 * @param {object} [options={}] Optional settings.
 * @param {string} [options.name='root'] Logical logger name used in emitted records.
 * @param {object} [options.context={}] Default metadata merged into every entry. Values
 *   are sanitised to redact sensitive fields prior to emission.
 *
 * @returns {StructuredLogger} A logger whose methods asynchronously emit entries to
 *   console streams and, when configured, file appenders.
 */
export function createLogger(options = {}) {
  const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : 'root';
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  const component = typeof options.component === 'string' && options.component.trim().length > 0 ? options.component.trim() : name;
  return new StructuredLogger(name, sanitizeMeta(context), component);
}

const envLogFile = isNode && process.env && typeof process.env.COMET_LOG_FILE === 'string'
  ? process.env.COMET_LOG_FILE
  : null;

if (LOG_LEVEL) {
  setLoggerConfig({ level: LOG_LEVEL });
}
if (envLogFile) {
  setLoggerConfig({ file: { enabled: true, path: envLogFile } });
}

export default createLogger;
