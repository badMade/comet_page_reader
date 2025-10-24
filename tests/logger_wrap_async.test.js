import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('wrap logs wrapped error once with scoped context and rethrows', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext, wrap } = loggerModule;

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'wrap-sync-unit' });

    const syncError = new Error('sync failure body');
    syncError.stack = 'Error: sync failure body\n    at sync (/private/sync.js:1:1)';

    const wrapped = wrap(() => {
      throw syncError;
    }, {
      logger,
      correlationId: 'wrap-sync-corr',
      requestId: 'req-001',
      errorMessage: 'Sync wrapper failure',
    });

    let thrown;
    try {
      wrapped('arg');
    } catch (error) {
      thrown = error;
    }

    assert.strictEqual(thrown, syncError);
    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0][0]);

    assert.equal(entry.msg, 'Sync wrapper failure');
    assert.equal(entry.correlationId, 'wrap-sync-corr');
    assert.equal(entry.context.requestId, 'req-001');
    assert.equal(entry.context.meta.requestId, 'req-001');
    assert.equal(entry.context.meta.error, undefined);
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('sync failure body'));
    assert(entry.stack.includes('[REDACTED]'));
  } finally {
    console.error = originalError;
  }
});

test('wrapAsync logs wrapped error once with scoped context and rethrows', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext, wrapAsync } = loggerModule;

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'wrap-async-unit' });

    const rootCause = new Error('root cause boom');
    rootCause.stack = 'Error: root cause boom\n    at inner (/private/root.js:1:1)';
    const failing = new Error('async failure body');
    failing.cause = rootCause;
    failing.stack = 'Error: async failure body\n    at outer (/Users/me/app.js:2:2)';

    const wrapped = wrapAsync(async () => {
      throw failing;
    }, {
      logger,
      correlationId: 'wrap-async-corr',
      requestId: 'req-123',
      errorMessage: 'Async wrapper failure',
    });

    await assert.rejects(() => wrapped('arg'), error => {
      assert.strictEqual(error, failing);
      return true;
    });

    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0][0]);

    assert.equal(entry.msg, 'Async wrapper failure');
    assert.equal(entry.correlationId, 'wrap-async-corr');
    assert.equal(entry.context.requestId, 'req-123');
    assert.equal(entry.context.meta.requestId, 'req-123');
    assert.equal(entry.context.meta.error, undefined);
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('async failure body'));
    assert(entry.stack.includes('root cause boom'));
    assert(entry.stack.includes('[REDACTED]'));
    const stackSegments = entry.stack.split('\nCaused by: ');
    assert.equal(stackSegments.length, 3);
  } finally {
    console.error = originalError;
  }
});

test('parallel wrapAsync invocations keep correlation and metadata isolated', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext, wrapAsync } = loggerModule;

  const captured = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'info', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'wrap-async-parallel' });

    const handler = wrapAsync(async payload => {
      await new Promise(resolve => setTimeout(resolve, payload.delay));
      await logger.info('processing payload', { step: payload.step });
      return payload.result;
    }, payload => ({
      logger,
      correlationId: payload.correlationId,
      requestId: payload.requestId,
    }));

    const results = await Promise.all([
      handler({ correlationId: 'corr-1', requestId: 'req-1', step: 'first', result: 1, delay: 15 }),
      handler({ correlationId: 'corr-2', requestId: 'req-2', step: 'second', result: 2, delay: 5 }),
    ]);

    assert.deepEqual(results, [1, 2]);
    assert.equal(captured.length, 2);

    const entries = captured.map(args => JSON.parse(args[0]));
    const mapByCorrelation = new Map(entries.map(entry => [entry.correlationId, entry]));

    assert.equal(mapByCorrelation.size, 2);

    const first = mapByCorrelation.get('corr-1');
    const second = mapByCorrelation.get('corr-2');

    assert(first, 'missing entry for corr-1');
    assert(second, 'missing entry for corr-2');

    assert.equal(first.context.requestId, 'req-1');
    assert.equal(first.context.meta.step, 'first');
    assert.equal(second.context.requestId, 'req-2');
    assert.equal(second.context.meta.step, 'second');
  } finally {
    console.info = originalInfo;
  }
});
