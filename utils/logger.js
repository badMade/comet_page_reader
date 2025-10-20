const LOG_LEVELS = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
});

const SENSITIVE_KEY_PATTERNS = [
  /api[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /authorization/i,
  /session[-_]?id/i,
];

const DEFAULT_CONFIG = {
  level: 'info',
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

let globalContext = {};
let fileStream = null;
let fsModule;

let yamlParserPromise = null;

const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

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

function formatLine(entry) {
  const { timestamp, level, logger, message } = entry;
  const parts = [
    `[${timestamp}]`,
    `[${level.toUpperCase()}]`,
    `[${logger}]`,
    message,
  ].filter(Boolean);
  return parts.join(' ');
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

async function emitLog(level, loggerName, loggerContext, message, meta) {
  if (!shouldLog(level)) {
    return;
  }
  const timestamp = new Date().toISOString();
  const error = detectError(message, meta);
  const baseEntry = {
    timestamp,
    level: normaliseLevel(level),
    logger: loggerName || 'root',
    message: normaliseMessage(message),
    context: {
      ...sanitizeMeta(activeConfig.context || {}),
      ...sanitizeMeta(globalContext),
      ...sanitizeMeta(loggerContext),
    },
  };
  if (error) {
    baseEntry.error = sanitizeMeta(error);
  }
  const additionalMeta = sanitizeMeta(meta);
  if (additionalMeta && Object.keys(additionalMeta).length > 0 && !(Array.isArray(additionalMeta) && additionalMeta.length === 0)) {
    baseEntry.meta = additionalMeta;
  }
  if (activeConfig.console?.enabled !== false) {
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' || level === 'trace' ? 'debug' : 'info';
    const consoleArgs = [formatLine(baseEntry)];
    if (baseEntry.meta) {
      consoleArgs.push(baseEntry.meta);
    }
    if (baseEntry.error && !baseEntry.meta) {
      consoleArgs.push(baseEntry.error);
    }
    console[consoleMethod](...consoleArgs);
  }
  writeToFile(baseEntry);
}

export function setGlobalContext(context) {
  if (!context || typeof context !== 'object') {
    return;
  }
  globalContext = {
    ...globalContext,
    ...sanitizeMeta(context),
  };
}

export function clearGlobalContext() {
  globalContext = {};
}

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

export function getLoggerConfig() {
  return { ...activeConfig };
}

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

class StructuredLogger {
  constructor(name, context = {}) {
    this.name = name || 'root';
    this.context = { ...context };
  }

  child(extraContext = {}) {
    return new StructuredLogger(this.name, { ...this.context, ...sanitizeMeta(extraContext) });
  }

  extend(extraContext = {}) {
    this.context = { ...this.context, ...sanitizeMeta(extraContext) };
  }

  async trace(message, meta) {
    await emitLog('trace', this.name, this.context, message, meta);
  }

  async debug(message, meta) {
    await emitLog('debug', this.name, this.context, message, meta);
  }

  async info(message, meta) {
    await emitLog('info', this.name, this.context, message, meta);
  }

  async warn(message, meta) {
    await emitLog('warn', this.name, this.context, message, meta);
  }

  async error(message, meta) {
    await emitLog('error', this.name, this.context, message, meta);
  }
}

export function createLogger(options = {}) {
  const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : 'root';
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  return new StructuredLogger(name, sanitizeMeta(context));
}

const envLevel = isNode && process.env && typeof process.env.COMET_LOG_LEVEL === 'string'
  ? process.env.COMET_LOG_LEVEL
  : null;
const envLogFile = isNode && process.env && typeof process.env.COMET_LOG_FILE === 'string'
  ? process.env.COMET_LOG_FILE
  : null;

if (envLevel) {
  setLoggerConfig({ level: envLevel });
}
if (envLogFile) {
  setLoggerConfig({ file: { enabled: true, path: envLogFile } });
}

export default createLogger;
