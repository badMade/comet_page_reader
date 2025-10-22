import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('logger severity gating suppresses entries below configured level', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

  const capturedWarn = [];
  const capturedError = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => {
    capturedWarn.push(args);
  };
  console.error = (...args) => {
    capturedError.push(args);
  };

  try {
    setLoggerConfig({ level: 'warn', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'severity-unit' });

    await logger.debug('debug suppressed');
    await logger.info('info suppressed');
    await logger.warn('warn emitted');
    await logger.error('error emitted');

    assert.equal(capturedWarn.length, 1);
    assert.equal(capturedError.length, 1);

    setLoggerConfig({ level: 'error' });

    await logger.warn('warn suppressed at error level');
    await logger.error('error emitted again');

    assert.equal(capturedWarn.length, 1);
    assert.equal(capturedError.length, 2);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});
