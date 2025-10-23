import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importFreshLoggerModule } from './fixtures/logger-test-utils.js';

test('correlation helpers prioritise meta values and inherit scoped context', async () => {
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

    const baseLogger = createLogger({ name: 'correlation-unit', context: { tenantId: 'tenant-5' } });
    const childLogger = baseLogger.child({ correlationId: 'child-corr', component: 'child-component' });

    await childLogger.info('child context message', { foo: 'bar' });

    assert.equal(captured.length, 1);
    let parsed = JSON.parse(captured[0][0]);
    assert.equal(parsed.correlationId, 'child-corr');
    assert.equal(parsed.context.tenantId, 'tenant-5');
    assert.equal(parsed.context.meta.foo, 'bar');

    await childLogger.info('meta overrides correlation', { correlationId: 'meta-corr', secret: 'value' });

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

test('createCorrelationId falls back to timestamp and random segments when crypto.randomUUID is unavailable', { concurrency: false }, async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalRandom = Math.random;
  const originalNow = Date.now;

  const stubCrypto = {};

  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      enumerable: true,
      get: () => stubCrypto,
    });
    Math.random = () => 0.123456789;
    Date.now = () => 1234567890;

    const { createCorrelationId } = await importFreshLoggerModule();

    const prefixed = createCorrelationId(' test-prefix ');
    const unprefixed = createCorrelationId();

    assert.equal(prefixed, 'test-prefix-kf12oi-4fzzzx');
    assert.equal(unprefixed, 'kf12oi-4fzzzx');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalDescriptor);
    } else {
      delete globalThis.crypto;
    }
    Math.random = originalRandom;
    Date.now = originalNow;
  }
});

test('createCorrelationId uses crypto.randomUUID when available', { concurrency: false }, async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  const stubCrypto = { randomUUID: () => 'uuid-1234' };

  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      enumerable: true,
      get: () => stubCrypto,
    });

    const { createCorrelationId } = await importFreshLoggerModule();

    assert.equal(createCorrelationId('prefix'), 'prefix-uuid-1234');
    assert.equal(createCorrelationId(), 'uuid-1234');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalDescriptor);
    } else {
      delete globalThis.crypto;
    }
  }
});
