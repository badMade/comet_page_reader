import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';

test('free audio adapters bypass cost limits and retain zero spend', async () => {
  const { uninstall, localStore } = installChromeStub();
  localStore['comet:apiKey:openai_paid'] = 'test-key';
  localStore['comet:apiKeyMeta:openai_paid'] = { lastUpdated: Date.now() };

  let module;
  try {
    module = await importServiceWorker();

    const spendCalls = [];
    const recordCalls = [];
    const fakeCostTracker = {
      canSpend(amount) {
        spendCalls.push(amount);
        return true;
      },
      recordFlat(label, amount, metadata) {
        recordCalls.push({ label, amount, metadata });
        return amount;
      },
      toJSON() {
        return { totalCostUsd: 0, requests: [] };
      },
      estimateCostForText() {
        return 0;
      },
      record() {
        return 0;
      },
      estimateTokensFromText() {
        return 0;
      },
    };

    const stubAdapter = {
      getCostMetadata() {
        return { transcribe: { label: 'free-stt', flatCost: 0 } };
      },
      async transcribe() {
        return { text: 'transcribed audio' };
      },
    };

    module.__setTestCostTrackerOverride(fakeCostTracker);
    module.__setTestAdapterOverride('openai_paid', stubAdapter);

    await module.ensureInitialised('openai_paid');
    const result = await module.__transcribeForTests({
      base64: Buffer.from('sound').toString('base64'),
      filename: 'speech.webm',
      mimeType: 'audio/webm',
      provider: 'openai_paid',
    });

    assert.equal(result, 'transcribed audio');
    assert.deepEqual(spendCalls, [0]);
    assert.deepEqual(recordCalls, [
      { label: 'free-stt', amount: 0, metadata: { type: 'free-stt' } },
    ]);
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    uninstall();
  }
});
