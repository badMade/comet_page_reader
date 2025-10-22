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
