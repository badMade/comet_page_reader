import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('structured logger redacts sensitive metadata before emission', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

  const entries = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    entries.push(args);
  };

  try {
    setLoggerConfig({ level: 'info', console: { enabled: true } });
    clearGlobalContext();

    const logger = createLogger({ name: 'structured-test' });
    await logger.info('Logging sensitive payload.', {
      apiKey: 'top-secret',
      nested: {
        token: 'token-value',
        safe: 'visible',
        sessionId: 'session-123',
      },
      array: [
        { password: 'hunter2' },
        'public-value',
      ],
    });

    assert.equal(entries.length, 1);
    const [firstCall] = entries;
    assert(Array.isArray(firstCall));
    const [rawEntry] = firstCall;
    const parsed = JSON.parse(rawEntry);

    assert.equal(parsed.level, 'info');
    assert.equal(parsed.msg, 'Logging sensitive payload.');
    assert.equal(parsed.context.meta.apiKey, '[REDACTED]');
    assert.equal(parsed.context.meta.nested.token, '[REDACTED]');
    assert.equal(parsed.context.meta.nested.safe, 'visible');
    assert.equal(parsed.context.meta.nested.sessionId, '[REDACTED]');
    assert.equal(parsed.context.meta.array[0].password, '[REDACTED]');
    assert.equal(parsed.context.meta.array[1], 'public-value');
  } finally {
    console.info = originalInfo;
  }
});

test('structured logger serialises chained error causes into the stack field', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig } = loggerModule;

  const entries = [];
  const originalError = console.error;
  console.error = (...args) => {
    entries.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true } });
    const logger = createLogger({ name: 'structured-test' });

    const innerError = new Error('inner failure');
    innerError.stack = 'Error: inner failure\n    at inner (/var/task/app.js:10:5)';
    const outerError = new Error('outer failure');
    outerError.stack = 'Error: outer failure\n    at outer (/Users/example/app.js:42:1)';
    outerError.cause = innerError;

    await logger.error(outerError);

    assert.equal(entries.length, 1);
    const [firstCall] = entries;
    const parsed = JSON.parse(firstCall[0]);
    assert.equal(parsed.msg, 'outer failure');
    assert.equal(typeof parsed.stack, 'string');
    assert(parsed.stack.includes('Error: outer failure'));
    assert(parsed.stack.includes('Caused by:'));
    assert(parsed.stack.includes('Error: inner failure'));
  } finally {
    console.error = originalError;
  }
});

test('log level filtering prevents lower severity messages from emitting', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig } = loggerModule;

  const entries = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    entries.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true } });
    const logger = createLogger({ name: 'structured-test' });

    await logger.info('This should be filtered.');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(entries.length, 0);
  } finally {
    console.info = originalInfo;
  }
});

test('withCorrelation helpers attach correlation identifiers to emitted entries', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, withCorrelation } = loggerModule;

  const entries = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    entries.push(args);
  };

  try {
    setLoggerConfig({ level: 'info', console: { enabled: true } });
    const baseLogger = createLogger({ name: 'structured-test' });

    const correlatedLogger = baseLogger.withCorrelation('corr-12345');
    assert.notStrictEqual(correlatedLogger, baseLogger);
    assert.equal(correlatedLogger.context.correlationId, 'corr-12345');
    assert.strictEqual(baseLogger.withCorrelation(''), baseLogger);

    await correlatedLogger.info('Correlated message.', { extra: true });

    assert.equal(entries.length, 1);
    const parsed = JSON.parse(entries[0][0]);
    assert.equal(parsed.correlationId, 'corr-12345');
    assert.equal(parsed.context.meta.extra, true);

    assert.deepEqual(withCorrelation(' helper-id '), { correlationId: 'helper-id' });
    assert.deepEqual(withCorrelation(''), {});
  } finally {
    console.info = originalInfo;
  }
});
