/**
 * Utility for loading environment variables from a `.env` file during local
 * development.
 *
 * @module scripts/loadEnv
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

import createLogger, { withCorrelation, wrapAsync } from '../utils/logger.js';

const logger = createLogger({ name: 'load-env' });

function createCorrelationId(prefix = 'load-env') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

let fatalExitScheduled = false;

function scheduleFatalExit() {
  if (fatalExitScheduled || typeof process === 'undefined') {
    return;
  }
  fatalExitScheduled = true;
  if (typeof process.exitCode === 'undefined' || process.exitCode === 0) {
    process.exitCode = 1;
  }
  if (typeof process.exit === 'function') {
    setTimeout(() => {
      try {
        process.exit(1);
      } catch {
        process.exitCode = 1;
      }
    }, 0);
  }
}

function registerProcessHandlers() {
  if (typeof process === 'undefined' || typeof process.on !== 'function') {
    return;
  }

  const createFatalHandler = (eventName, message) => value => {
    const correlationId = createCorrelationId(`load-env-${eventName}`);
    const run = wrapAsync(async input => {
      const meta = {
        ...withCorrelation(correlationId),
        event: eventName,
      };
      if (input instanceof Error) {
        meta.error = input;
      } else if (typeof input !== 'undefined') {
        meta.reason = input;
      }
      try {
        await logger.fatal(message, meta);
      } finally {
        scheduleFatalExit();
      }
    }, () => ({
      logger,
      component: logger.component,
      ...withCorrelation(correlationId),
      errorMessage: null,
      event: eventName,
    }));
    return run(value);
  };

  const handleUncaughtException = createFatalHandler(
    'uncaught-exception',
    'Fatal uncaught exception while loading environment variables.'
  );
  const handleUnhandledRejection = createFatalHandler(
    'unhandled-rejection',
    'Fatal unhandled rejection while loading environment variables.'
  );

  process.on('uncaughtException', error => {
    handleUncaughtException(error).catch(() => {});
  });

  process.on('unhandledRejection', reason => {
    handleUnhandledRejection(reason).catch(() => {});
  });
}

registerProcessHandlers();

/**
 * Loads environment variables from a `.env` file using `dotenv`.
 *
 * @param {{cwd?: string, path?: string}} [options={}] - Loader options.
 * @returns {Record<string, string>} Parsed environment variables.
 */
export function loadEnv(options = {}) {
  if (typeof process === 'undefined') {
    return {};
  }

  const cwd = options.cwd || process.cwd();
  const envPath = options.path || path.join(cwd, '.env');
  const result = dotenv.config({ path: envPath, quiet: true });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {};
    }
    throw result.error;
  }

  return result.parsed || {};
}

async function main() {
  loadEnv();
}

const run = logger.wrapAsync(main, () => ({
  logger,
  component: logger.component,
  ...withCorrelation(createCorrelationId('load-env-run')),
  errorMessage: 'Failed to load environment variables.',
}));

if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  const entryUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entryUrl && process.env.NODE_ENV !== 'production') {
    await run();
  }
}
