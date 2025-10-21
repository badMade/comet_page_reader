import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokensFromUsd } from '../utils/cost.js';
import { loadAgentConfiguration } from '../utils/providerConfig.js';
import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';

const USAGE_STORAGE_KEY = 'comet:usage';

test('ensureInitialised hydrates stored limit for the cost tracker', async () => {
  const storedUsage = {
    totalCostUsd: 12.5,
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
    const agentConfig = await loadAgentConfiguration();
    const configuredLimit = agentConfig.routing?.maxMonthlyTokens ?? 0;
    const usage = await handleUsageRequest();

    const expectedLimit = Math.min(
      estimateTokensFromUsd(storedUsage.limitUsd),
      configuredLimit,
    );
    assert.equal(usage.limitTokens, expectedLimit);
    assert.equal(usage.totalTokens, storedUsage.requests.reduce((total, request) => total + request.promptTokens + request.completionTokens, 0));
    assert.equal(usage.requests.length, storedUsage.requests.length);
    assert.equal(usage.lastReset, storedUsage.lastReset);
    assert.equal(usage.metadata.legacyTotalCostUsd, storedUsage.totalCostUsd);

    // Ensure persisted store remains untouched after reads.
    assert.equal(persistentStore[USAGE_STORAGE_KEY].limitUsd, storedUsage.limitUsd);
  } finally {
    uninstall();
  }
});
