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
    assert.equal(entry.context.meta.error.message, 'sync failure body');
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
    assert.equal(entry.context.meta.error.message, 'async failure body');
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('async failure body'));
    assert(entry.stack.includes('root cause boom'));
    assert(entry.stack.includes('[REDACTED]'));
  } finally {
    console.error = originalError;
  }
});
