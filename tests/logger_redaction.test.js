import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('redaction regex redacts sensitive keys across nested metadata', async () => {
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

    const logger = createLogger({ name: 'redaction-unit-test' });
    await logger.info('check redaction', {
      Authorization: 'Bearer secret-token',
      apiTOKEN: 'value',
      nested: {
        session_id: 'session-value',
        safe: 'keep-me',
        password: 'open-sesame',
      },
      array: [
        { ApiKey: '12345' },
        'visible',
      ],
    });

    assert.equal(captured.length, 1);
    const [firstCall] = captured;
    const entry = JSON.parse(firstCall[0]);

    assert.equal(entry.msg, 'check redaction');
    assert.equal(entry.context.meta.Authorization, '[REDACTED]');
    assert.equal(entry.context.meta.apiTOKEN, '[REDACTED]');
    assert.equal(entry.context.meta.nested.session_id, '[REDACTED]');
    assert.equal(entry.context.meta.nested.password, '[REDACTED]');
    assert.equal(entry.context.meta.nested.safe, 'keep-me');
    assert.equal(entry.context.meta.array[0].ApiKey, '[REDACTED]');
    assert.equal(entry.context.meta.array[1], 'visible');
  } finally {
    console.info = originalInfo;
  }
});
