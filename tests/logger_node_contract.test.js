import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

async function captureConsole(method, run) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => {
    calls.push(args);
  };
  try {
    await run();
  } finally {
    console[method] = original;
  }
  return calls;
}

function parseCapturedEntries(calls) {
  return calls
    .map(args => args[0])
    .filter(value => typeof value === 'string')
    .map(value => {
      try {
        return JSON.parse(value);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

test('node logger contract behaviours', async t => {
  await t.test('redacts sensitive metadata using regex patterns', async () => {
    const loggerModule = await importFreshLoggerModule();
    const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

    setLoggerConfig({
      level: 'info',
      console: { enabled: true },
      file: { enabled: false, path: null },
      context: {},
    });
    clearGlobalContext();

    const calls = await captureConsole('info', async () => {
      const logger = createLogger({ name: 'node-redaction' });
      await logger.info('node redaction check', {
        apiKey: 'abc123',
        nested: {
          secretToken: 's3cr3t',
          session_id: 'session-value',
          retain: 'keep-me',
        },
        errors: [new Error('list error'), 'ok'],
      });
    });

    const entries = parseCapturedEntries(calls);
    assert.equal(entries.length, 1);
    const [entry] = entries;

    assert.equal(entry.msg, 'node redaction check');
    assert.equal(entry.context.meta.apiKey, '[REDACTED]');
    assert.equal(entry.context.meta.nested.secretToken, '[REDACTED]');
    assert.equal(entry.context.meta.nested.session_id, '[REDACTED]');
    assert.equal(entry.context.meta.nested.retain, 'keep-me');
    assert.equal(entry.context.meta.errors[0].message, 'list error');
    assert.equal(typeof entry.context.meta.errors[0].stack, 'string');
    assert.equal(entry.context.meta.errors[1], 'ok');
  });

  await t.test('respects severity thresholds for console emission', async () => {
    const loggerModule = await importFreshLoggerModule();
    const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

    setLoggerConfig({
      level: 'warn',
      console: { enabled: true },
      file: { enabled: false, path: null },
      context: {},
    });
    clearGlobalContext();

    const captured = { debug: [], info: [], warn: [], error: [] };
    const originalDebug = console.debug;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.debug = (...args) => {
      captured.debug.push(args);
    };
    console.info = (...args) => {
      captured.info.push(args);
    };
    console.warn = (...args) => {
      captured.warn.push(args);
    };
    console.error = (...args) => {
      captured.error.push(args);
    };

    try {
      const logger = createLogger({ name: 'node-severity' });

      await logger.trace('trace suppressed');
      await logger.debug('debug suppressed');
      await logger.info('info suppressed');
      await logger.warn('warn emitted');
      await logger.error('error emitted');

      assert.equal(captured.debug.length, 0);
      assert.equal(captured.info.length, 0);
      assert.equal(captured.warn.length, 1);
      assert.equal(captured.error.length, 1);

      setLoggerConfig({ level: 'error' });

      await logger.warn('warn suppressed at error level');
      await logger.error('error emitted at error level');

      assert.equal(captured.warn.length, 1);
      assert.equal(captured.error.length, 2);
    } finally {
      console.debug = originalDebug;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  await t.test('propagates cause stacks and redacts paths', async () => {
    const loggerModule = await importFreshLoggerModule();
    const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

    setLoggerConfig({
      level: 'error',
      console: { enabled: true },
      file: { enabled: false, path: null },
      context: {},
    });
    clearGlobalContext();

    const calls = await captureConsole('error', async () => {
      const logger = createLogger({ name: 'node-cause' });
      const cause = new Error('inner network failure');
      cause.stack = 'Error: inner network failure\n    at inner (/private/inner.js:1:1)';
      const failure = new Error('outer pipeline failure');
      failure.cause = cause;
      failure.stack = 'Error: outer pipeline failure\n    at outer (/Users/example/path.js:2:2)';

      await logger.error('outer pipeline failure', {
        error: failure,
        details: { token: 'value', retryable: true },
      });
    });

    const entries = parseCapturedEntries(calls);
    assert.equal(entries.length, 1);
    const [entry] = entries;

    assert.equal(entry.msg, 'outer pipeline failure');
    assert.equal(entry.context.meta.error.message, 'outer pipeline failure');
    assert.equal(typeof entry.context.meta.error.stack, 'string');
    assert.equal(entry.context.meta.details.token, '[REDACTED]');
    assert.equal(entry.context.meta.details.retryable, true);
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('outer pipeline failure'));
    assert(entry.stack.includes('inner network failure'));
    assert(entry.stack.includes('Caused by:'));
    assert(entry.stack.includes('[REDACTED]'));
  });

  await t.test('correlation helpers propagate trimmed identifiers', async () => {
    const loggerModule = await importFreshLoggerModule();
    const { createLogger, setLoggerConfig, clearGlobalContext, setGlobalContext, withCorrelation } = loggerModule;

    setLoggerConfig({
      level: 'info',
      console: { enabled: true },
      file: { enabled: false, path: null },
      context: {},
    });
    clearGlobalContext();
    setGlobalContext({ correlationId: 'global-corr', tenantId: 'tenant-9' });

    const calls = await captureConsole('info', async () => {
      const logger = createLogger({ name: 'node-correlation', context: { sessionId: 'sess-1' } });
      const correlated = logger.withCorrelation('  ctx-corr-5 ');

      await correlated.info('child correlation message', { foo: 'bar' });
      await logger.info('meta overrides correlation', { correlationId: ' meta-corr ', token: 'value' });
    });

    const entries = parseCapturedEntries(calls);
    assert.equal(entries.length, 2);
    const [first, second] = entries;

    assert.equal(first.correlationId, 'ctx-corr-5');
    assert.equal(first.context.sessionId, '[REDACTED]');
    assert.equal(first.context.tenantId, 'tenant-9');
    assert.equal(first.context.meta.foo, 'bar');

    assert.equal(second.correlationId, 'meta-corr');
    assert.equal(second.context.sessionId, '[REDACTED]');
    assert.equal(second.context.tenantId, 'tenant-9');
    assert.equal(second.context.meta.token, '[REDACTED]');
    assert(!('correlationId' in second.context.meta));

    assert.deepEqual(withCorrelation(' helper '), { correlationId: 'helper' });
    assert.deepEqual(withCorrelation(''), {});

    clearGlobalContext();
  });

  await t.test('wrap utilities apply scoped context and rethrow errors', async () => {
    const loggerModule = await importFreshLoggerModule();
    const { createLogger, setLoggerConfig, clearGlobalContext, wrap, wrapAsync } = loggerModule;

    setLoggerConfig({
      level: 'error',
      console: { enabled: true },
      file: { enabled: false, path: null },
      context: {},
    });
    clearGlobalContext();

    const captured = [];
    const originalError = console.error;
    console.error = (...args) => {
      captured.push(args);
    };

    try {
      const logger = createLogger({ name: 'node-wrap', context: { sessionId: 'sess-wrap' } });

      const syncFailure = new Error('sync failure reason');
      syncFailure.stack = 'Error: sync failure reason\n    at sync (/etc/app.js:1:1)';

      const wrappedSync = wrap(
        () => {
          throw syncFailure;
        },
        requestId => ({
          logger,
          correlationId: `sync-${requestId}`,
          requestId,
          apiSecret: 'top-secret',
          errorMessage: 'Sync failure handled',
        }),
      );

      let thrownSync;
      try {
        wrappedSync('req-9');
      } catch (error) {
        thrownSync = error;
      }
      assert.strictEqual(thrownSync, syncFailure);

      const asyncCause = new Error('async root cause');
      asyncCause.stack = 'Error: async root cause\n    at inner (/tmp/inner.js:1:1)';
      const asyncFailure = new Error('async wrapper failure');
      asyncFailure.cause = asyncCause;
      asyncFailure.stack = 'Error: async wrapper failure\n    at outer (/tmp/outer.js:2:2)';

      const wrappedAsync = wrapAsync(
        async userId => {
          throw asyncFailure;
        },
        userId => ({
          logger,
          correlationId: `async-${userId}`,
          userId,
          token: 'value',
          errorMessage: 'Async failure handled',
        }),
      );

      await assert.rejects(async () => wrappedAsync('user-1'), error => error === asyncFailure);
    } finally {
      console.error = originalError;
    }

    assert.equal(captured.length, 2);
    const [syncEntry, asyncEntry] = captured.map(args => JSON.parse(args[0]));

    assert.equal(syncEntry.msg, 'Sync failure handled');
    assert.equal(syncEntry.correlationId, 'sync-req-9');
    assert.equal(syncEntry.context.requestId, 'req-9');
    assert.equal(syncEntry.context.apiSecret, '[REDACTED]');
    assert.equal(typeof syncEntry.stack, 'string');
    assert(syncEntry.stack.includes('sync failure reason'));
    assert(syncEntry.stack.includes('[REDACTED]'));

    assert.equal(asyncEntry.msg, 'Async failure handled');
    assert.equal(asyncEntry.correlationId, 'async-user-1');
    assert.equal(asyncEntry.context.userId, 'user-1');
    assert.equal(asyncEntry.context.meta.error.message, 'async wrapper failure');
    assert.equal(typeof asyncEntry.stack, 'string');
    assert(asyncEntry.stack.includes('async wrapper failure'));
    assert(asyncEntry.stack.includes('async root cause'));
    assert(asyncEntry.stack.includes('Caused by:'));
    assert(asyncEntry.stack.includes('[REDACTED]'));
  });
});
