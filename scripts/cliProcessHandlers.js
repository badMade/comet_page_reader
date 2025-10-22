/**
 * Shared helpers that provide consistent error handling and correlation
 * identifiers for Node-based CLI scripts.
 */
import { withCorrelation } from '../utils/logger.js';

let handlersRegistered = false;
let fatalExitScheduled = false;
let cachedCorrelationBase = null;
let cachedScriptName = 'cli';
let cachedExitCode = 1;
let cachedComponent = 'cli';

function normaliseSegment(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function resolveRandomId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function generateCorrelationBase(prefix) {
  const basePrefix = normaliseSegment(prefix) || 'cli';
  return `${basePrefix}-${resolveRandomId()}`;
}

function scheduleFatalExit(code = 1) {
  if (fatalExitScheduled || typeof process === 'undefined') {
    if (typeof process !== 'undefined' && (typeof process.exitCode === 'undefined' || process.exitCode === 0)) {
      process.exitCode = code;
    }
    return;
  }
  fatalExitScheduled = true;
  if (typeof process.exitCode === 'undefined' || process.exitCode === 0) {
    process.exitCode = code;
  }
  if (typeof process.exit === 'function') {
    setTimeout(() => {
      try {
        process.exit(code);
      } catch {
        process.exitCode = code;
      }
    }, 0);
  }
}

function resolveCorrelationBase(options = {}) {
  if (typeof options.scriptName === 'string' && options.scriptName.trim()) {
    cachedScriptName = options.scriptName.trim();
  }
  if (typeof options.exitCode === 'number' && Number.isFinite(options.exitCode)) {
    cachedExitCode = options.exitCode;
  }
  if (typeof options.component === 'string' && options.component.trim()) {
    cachedComponent = options.component.trim();
  }

  if (!cachedCorrelationBase) {
    const preferred =
      (typeof options.correlationId === 'string' && options.correlationId.trim()) ? options.correlationId.trim() :
      (typeof process !== 'undefined' && process.env && typeof process.env.COMET_CLI_CORRELATION_ID === 'string' && process.env.COMET_CLI_CORRELATION_ID.trim() ? process.env.COMET_CLI_CORRELATION_ID.trim() : null) ||
      (typeof process !== 'undefined' && process.env && typeof process.env.COMET_CORRELATION_ID === 'string' && process.env.COMET_CORRELATION_ID.trim() ? process.env.COMET_CORRELATION_ID.trim() : null) ||
      (typeof process !== 'undefined' && process.env && typeof process.env.CORRELATION_ID === 'string' && process.env.CORRELATION_ID.trim() ? process.env.CORRELATION_ID.trim() : null);

    if (preferred) {
      cachedCorrelationBase = preferred;
    } else {
      const prefix = normaliseSegment(options.correlationPrefix) || normaliseSegment(`cli-${cachedScriptName}`) || 'cli';
      cachedCorrelationBase = generateCorrelationBase(prefix);
    }

    if (!cachedCorrelationBase) {
      const prefix = normaliseSegment(`cli-${cachedScriptName}`) || 'cli';
      cachedCorrelationBase = generateCorrelationBase(prefix);
    }
  }

  return cachedCorrelationBase;
}

/**
 * Builds a correlation identifier for CLI log entries.
 *
 * @param {string} segment - Optional suffix describing the event or scope.
 * @param {{scriptName?: string, correlationId?: string, correlationPrefix?: string, exitCode?: number, component?: string}} [options={}]
 *   Configuration applied when the base identifier is initialised.
 * @returns {string} Stable correlation identifier for the current process.
 */
export function createCliCorrelationId(segment, options = {}) {
  const base = resolveCorrelationBase(options);
  const suffix = normaliseSegment(segment);
  if (!suffix) {
    return base;
  }
  return `${base}:${suffix}`;
}

/**
 * Registers process-wide handlers that surface fatal events through the
 * structured logger before terminating the process.
 *
 * @param {{fatal: Function, component?: string}} logger - Structured logger
 *   instance created via {@link createLogger}.
 * @param {{scriptName?: string, uncaughtExceptionMessage?: string, unhandledRejectionMessage?: string, correlationId?: string, correlationPrefix?: string, exitCode?: number, component?: string}} [options={}]
 *   Optional overrides for script metadata and emitted messages.
 */
export function registerCliErrorHandlers(logger, options = {}) {
  if (!logger || typeof logger.fatal !== 'function') {
    throw new TypeError('registerCliErrorHandlers requires a structured logger instance.');
  }

  resolveCorrelationBase(options);

  if (handlersRegistered || typeof process === 'undefined' || typeof process.on !== 'function') {
    return;
  }

  const scriptName = cachedScriptName;
  const exitCode = cachedExitCode;
  const uncaughtMessage = typeof options.uncaughtExceptionMessage === 'string' && options.uncaughtExceptionMessage.trim()
    ? options.uncaughtExceptionMessage.trim()
    : `Fatal uncaught exception in ${scriptName}.`;
  const rejectionMessage = typeof options.unhandledRejectionMessage === 'string' && options.unhandledRejectionMessage.trim()
    ? options.unhandledRejectionMessage.trim()
    : `Fatal unhandled rejection in ${scriptName}.`;

  const logFatal = (eventName, message) => input => {
    const correlationId = createCliCorrelationId(eventName, { scriptName });
    const meta = {
      ...withCorrelation(correlationId),
      component: cachedComponent,
      event: eventName,
      exitCode,
      script: scriptName,
    };
    if (input instanceof Error) {
      meta.error = input;
    } else if (typeof input !== 'undefined') {
      meta.reason = input;
    }
    Promise.resolve(logger.fatal(message, meta))
      .catch(() => {})
      .finally(() => {
        scheduleFatalExit(exitCode);
      });
  };

  process.on('uncaughtException', error => {
    logFatal('uncaught-exception', uncaughtMessage)(error);
  });

  process.on('unhandledRejection', reason => {
    logFatal('unhandled-rejection', rejectionMessage)(reason);
  });

  handlersRegistered = true;
}

/**
 * Introspection helper primarily used in tests to confirm registration state.
 *
 * @returns {{registered: boolean, scriptName: string, correlationBase: string|null, exitCode: number, component: string}}
 *   Snapshot of the handler state for the current process.
 */
export function getCliErrorHandlerState() {
  return {
    registered: handlersRegistered,
    scriptName: cachedScriptName,
    correlationBase: cachedCorrelationBase,
    exitCode: cachedExitCode,
    component: cachedComponent,
  };
}
