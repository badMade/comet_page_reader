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
      recordFlat(label, descriptor, metadata) {
        recordCalls.push({ label, descriptor, metadata });
        return typeof descriptor === 'number'
          ? descriptor
          : descriptor?.totalTokens || 0;
      },
      toJSON() {
        return {
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          cumulativeTotalTokens: 0,
          cumulativePromptTokens: 0,
          cumulativeCompletionTokens: 0,
          requests: [],
          limitTokens: 0,
          metadata: {},
        };
      },
      estimateTokenUsage() {
        return { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
      },
      record() {
        return 0;
      },
      getUsageTotals() {
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      },
      getCumulativeTotals() {
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
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
      {
        label: 'free-stt',
        descriptor: {
          completionTokens: 0,
          totalTokens: 0,
          metadata: { type: 'free-stt', estimatedTokens: 0 },
        },
        metadata: undefined,
      },
    ]);
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    uninstall();
  }
});
