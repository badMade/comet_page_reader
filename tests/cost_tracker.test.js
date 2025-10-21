import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';

const USAGE_STORAGE_KEY = 'comet:usage';

test('ensureInitialised hydrates stored limit for the cost tracker', async () => {
  const storedUsage = {
    totalCostUsd: 12.5,
    promptTokens: 1200,
    completionTokens: 340,
    totalTokens: 1540,
    requests: [
      {
        model: 'gpt-4o-mini',
        promptTokens: 10,
        completionTokens: 20,
        costUsd: 0.01,
        timestamp: 1000,
      },
    ],
    lastReset: 12345,
    limitUsd: 42,
  };

  const { uninstall, persistentStore } = installChromeStub({ [USAGE_STORAGE_KEY]: storedUsage });

  try {
    const { ensureInitialised, handleUsageRequest } = await importServiceWorker();
    await ensureInitialised();
    const usage = await handleUsageRequest();

    assert.equal(usage.limitUsd, Math.min(storedUsage.limitUsd, 2));
    assert.equal(usage.totalCostUsd, storedUsage.totalCostUsd);
    assert.equal(usage.promptTokens, storedUsage.promptTokens);
    assert.equal(usage.completionTokens, storedUsage.completionTokens);
    assert.equal(usage.totalTokens, storedUsage.totalTokens);
    assert.equal(usage.requests.length, storedUsage.requests.length);
    assert.equal(usage.lastReset, storedUsage.lastReset);

    // Ensure persisted store remains untouched after reads.
    assert.equal(persistentStore[USAGE_STORAGE_KEY].limitUsd, storedUsage.limitUsd);
  } finally {
    uninstall();
  }
});
