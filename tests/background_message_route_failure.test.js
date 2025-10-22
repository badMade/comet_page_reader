import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';

test('failing background message route logs a single structured error with correlation id and stack', async () => {
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

  const capturedErrors = [];
  const originalError = console.error;

  let module;
  try {
    module = await importServiceWorker();
    module.__setTestAdapterOverride('test', stubAdapter);

    await module.ensureInitialised('test');

    console.error = (...args) => {
      capturedErrors.push(args);
    };

    assert.equal(listeners.length, 1, 'service worker should register one runtime listener');
    const [listener] = listeners;

    const message = {
      type: 'comet:summarise',
      payload: {
        url: 'https://example.com/article',
        segments: [{ id: 'segment-1', text: '' }],
        language: 'en',
        provider: 'test',
      },
    };

    const response = await new Promise(resolve => {
      listener(message, {}, result => {
        resolve(result);
      });
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(response.success, false);
    assert.equal(typeof response.correlationId, 'string');

    const structuredEntries = capturedErrors
      .map(args => args[0])
      .filter(value => typeof value === 'string')
      .map(value => {
        try {
          return JSON.parse(value);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean)
      .filter(entry => entry.msg === 'Background message handler failed.');

    assert.equal(structuredEntries.length, 1, 'expected exactly one structured error log entry');
    const [entry] = structuredEntries;

    assert.equal(entry.correlationId, response.correlationId);
    assert.equal(entry.level, 'error');
    assert.equal(entry.context.meta.type, 'comet:summarise');
    assert.equal(entry.context.meta.error.message, 'generate requires source text.');
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('generate requires source text.'));
    assert(entry.stack.includes('[REDACTED]'));
  } finally {
    console.error = originalError;
    if (module) {
      module.__clearTestOverrides();
    }
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});
