import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('logger preserves chained causes while redacting stack frames', async () => {
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

    const logger = createLogger({ name: 'stack-unit' });

    const inner = new Error('inner failure');
    inner.stack = 'Error: inner failure\n    at inner (/very/secret/path/inner.js:1:1)';
    const outer = new Error('outer failure');
    outer.stack = 'Error: outer failure\n    at outer (file:///Users/me/app.js:2:2)';
    outer.cause = inner;

    await logger.error('outer failure occurred', { error: outer });

    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0][0]);

    assert.equal(entry.msg, 'outer failure occurred');
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('Error: outer failure'));
    assert(entry.stack.includes('Caused by:'));
    assert(entry.stack.includes('Error: inner failure'));
    assert(entry.stack.includes('[REDACTED]'));
    assert(!entry.stack.includes('/very/secret/path'));
  } finally {
    console.error = originalError;
  }
});
