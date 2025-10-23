import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';

test('unsupported background message responds asynchronously with failure payload', async () => {
  const { uninstall, chrome } = installChromeStub({
    'comet:apiKey:test': 'dummy-key',
    'comet:apiKeyMeta:test': { lastUpdated: Date.now() },
  });

  const listeners = [];
  chrome.runtime.onMessage.addListener = handler => {
    listeners.push(handler);
  };

  __setAgentYamlOverrideForTests(() => [
    'provider: test',
    'model: stub-model',
    'routing:',
    '  provider_order:',
    '    - test',
    '  max_tokens_per_call: 2000',
    '  max_monthly_tokens: 5000',
    'providers:',
    '  test:',
    '    provider: test',
    '    model: stub-model',
    '    api_url: https://api.test.example/v1/chat',
    '    api_key_var: TEST_KEY',
  ].join('\n'));

  const stubAdapter = {
    getCostMetadata() {
      return { summarise: { model: 'stub-model', label: 'stub-summary' } };
    },
    async summarise({ text }) {
      return { summary: text ? `summary:${text}` : '' };
    },
  };

  let module;
  try {
    module = await importServiceWorker();
    module.__setTestAdapterOverride('test', stubAdapter);
    await module.ensureInitialised('test');

    assert.equal(listeners.length, 1, 'service worker should register exactly one listener');
    const [listener] = listeners;

    const message = { type: 'comet:unsupported', payload: null };

    let channelOpen = false;
    let respondedSynchronously = null;
    let sync = true;

    const response = await new Promise(resolve => {
      channelOpen = listener(message, {}, result => {
        respondedSynchronously = sync;
        resolve(result);
      });
      sync = false;
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(channelOpen, true, 'listener should keep the channel open');
    assert.equal(respondedSynchronously, false, 'response should be delivered asynchronously');
    assert.equal(response.success, false, 'unsupported message should fail');
    assert.equal(response.error, 'Unsupported message type.');
    assert.equal(typeof response.correlationId, 'string');
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});
