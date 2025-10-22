import { test } from 'node:test';
import assert from 'node:assert/strict';

const createModuleSpecifier = (() => {
  let counter = 0;
  return () => `../utils/logger.js?behaviour=${Date.now()}-${counter++}`;
})();

async function importFreshLoggerModule() {
  const moduleUrl = new URL(createModuleSpecifier(), import.meta.url);
  return import(moduleUrl.href);
}

test('logger redacts sensitive keys using regex patterns in deeply nested meta', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

  const captured = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'info', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'redaction-test' });
    await logger.info('sensitive payload', {
      Authorization: 'Bearer secret-token',
      apiTOKEN: 'value',
      nested: {
        session_id: 'session-value',
        safe: 'keep-me',
      },
      items: [
        { ApiKey: '123' },
        'visible',
      ],
    });

    assert.equal(captured.length, 1);
    const [firstCall] = captured;
    const parsed = JSON.parse(firstCall[0]);

    assert.equal(parsed.msg, 'sensitive payload');
    assert.equal(parsed.context.meta.Authorization, '[REDACTED]');
    assert.equal(parsed.context.meta.apiTOKEN, '[REDACTED]');
    assert.equal(parsed.context.meta.nested.session_id, '[REDACTED]');
    assert.equal(parsed.context.meta.nested.safe, 'keep-me');
    assert.equal(parsed.context.meta.items[0].ApiKey, '[REDACTED]');
    assert.equal(parsed.context.meta.items[1], 'visible');
  } finally {
    console.info = originalInfo;
  }
});

test('logger honours dynamic level thresholds across severity transitions', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

  const warns = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => {
    warns.push(args);
  };
  console.error = (...args) => {
    errors.push(args);
  };

  try {
    setLoggerConfig({ level: 'warn', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'threshold-test' });

    await logger.info('suppressed info');
    await logger.debug('suppressed debug');
    await logger.warn('emit warn');
    await logger.error('emit error');

    assert.equal(warns.length, 1);
    assert.equal(errors.length, 1);

    setLoggerConfig({ level: 'error' });

    await logger.warn('filtered warn');
    await logger.error('emit error again');

    assert.equal(warns.length, 1);
    assert.equal(errors.length, 2);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('logger builds redacted stack traces from chained error causes', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext } = loggerModule;

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'stack-test' });

    const inner = new Error('inner failure');
    inner.stack = 'Error: inner failure\n    at inner (/very/secret/path/inner.js:1:1)';
    const outer = new Error('outer failure');
    outer.stack = 'Error: outer failure\n    at outer (file:///Users/me/app.js:2:2)';
    outer.cause = inner;

    await logger.error('outer failure occurred', { error: outer });

    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0][0]);

    assert.equal(parsed.msg, 'outer failure occurred');
    assert.equal(typeof parsed.stack, 'string');
    assert(parsed.stack.includes('Error: outer failure'));
    assert(parsed.stack.includes('Caused by:'));
    assert(parsed.stack.includes('Error: inner failure'));
    assert(parsed.stack.includes('[REDACTED]'));
    assert(!parsed.stack.includes('/very/secret/path'));
  } finally {
    console.error = originalError;
  }
});

test('correlation helpers prioritise meta values and propagate across derived loggers', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext, setGlobalContext, withCorrelation } = loggerModule;

  const captured = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'info', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();
    setGlobalContext({ correlationId: 'global-corr', installationId: 'install-1' });

    const baseLogger = createLogger({ name: 'correlation-test', context: { tenantId: 'tenant-5' } });
    const childLogger = baseLogger.child({ correlationId: 'child-corr', component: 'child-component' });

    await childLogger.info('child context message', { foo: 'bar' });

    assert.equal(captured.length, 1);
    let parsed = JSON.parse(captured[0][0]);
    assert.equal(parsed.correlationId, 'child-corr');
    assert.equal(parsed.context.tenantId, 'tenant-5');
    assert.equal(parsed.context.meta.foo, 'bar');

    await childLogger.info('meta overrides', { correlationId: 'meta-corr', secret: 'value' });

    assert.equal(captured.length, 2);
    parsed = JSON.parse(captured[1][0]);
    assert.equal(parsed.correlationId, 'meta-corr');
    assert.equal(parsed.context.meta.secret, '[REDACTED]');
    assert(!('correlationId' in parsed.context.meta));

    assert.deepEqual(withCorrelation(' helper '), { correlationId: 'helper' });
    assert.deepEqual(withCorrelation(''), {});
  } finally {
    console.info = originalInfo;
  }
});

test('wrap and wrapAsync report failures once with scoped context and rethrow errors', async () => {
  const loggerModule = await importFreshLoggerModule();
  const { createLogger, setLoggerConfig, clearGlobalContext, wrap, wrapAsync } = loggerModule;

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => {
    captured.push(args);
  };

  try {
    setLoggerConfig({ level: 'error', console: { enabled: true }, file: { enabled: false, path: null }, context: {} });
    clearGlobalContext();

    const logger = createLogger({ name: 'wrap-test' });

    const syncError = new Error('sync failure body');
    const wrappedSync = wrap(() => {
      throw syncError;
    }, {
      logger,
      correlationId: 'wrap-sync-corr',
      requestId: 'req-001',
      errorMessage: 'Sync wrapper failure',
    });

    let thrown;
    try {
      wrappedSync('arg');
    } catch (error) {
      thrown = error;
    }
    assert.strictEqual(thrown, syncError);

    const asyncError = new Error('async failure body');
    const wrappedAsync = wrapAsync(async () => {
      throw asyncError;
    }, {
      logger,
      correlationId: 'wrap-async-corr',
      requestId: 'req-002',
      errorMessage: 'Async wrapper failure',
    });

    await assert.rejects(() => wrappedAsync('arg'));

    await logger.error('post-run check');

    assert.equal(captured.length, 3);
    const syncEntry = JSON.parse(captured[0][0]);
    assert.equal(syncEntry.msg, 'Sync wrapper failure');
    assert.equal(syncEntry.correlationId, 'wrap-sync-corr');
    assert.equal(syncEntry.context.requestId, 'req-001');
    assert.equal(syncEntry.context.meta.error.message, 'sync failure body');
    assert(syncEntry.stack.includes('sync failure body'));

    const asyncEntry = JSON.parse(captured[1][0]);
    assert.equal(asyncEntry.msg, 'Async wrapper failure');
    assert.equal(asyncEntry.correlationId, 'wrap-async-corr');
    assert.equal(asyncEntry.context.requestId, 'req-002');
    assert.equal(asyncEntry.context.meta.error.message, 'async failure body');
    assert(asyncEntry.stack.includes('async failure body'));

    const finalEntry = JSON.parse(captured[2][0]);
    assert.equal(finalEntry.msg, 'post-run check');
    assert.equal(finalEntry.correlationId, null);
    assert(!('requestId' in finalEntry.context));
  } finally {
    console.error = originalError;
  }
});
