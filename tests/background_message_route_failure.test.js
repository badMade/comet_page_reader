import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';
import { registerAdapter } from '../background/adapters/registry.js';

function extractStructuredEntries(calls, message) {
  return calls
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
    .filter(entry => (message ? entry.msg === message : true));
}

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

  const capturedLogs = [];
  const originalError = console.error;
  const originalWarn = console.warn;

  let module;
  try {
    module = await importServiceWorker();
    module.__setTestAdapterOverride('test', stubAdapter);

    await module.ensureInitialised('test');

    console.error = (...args) => {
      capturedLogs.push(args);
    };
    console.warn = (...args) => {
      capturedLogs.push(args);
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

    assert(capturedLogs.length >= 1, 'expected console.error to be invoked for the failure');

    const structuredEntries = extractStructuredEntries(capturedLogs, 'Background message handler failed.');

    assert.equal(structuredEntries.length, 1, 'expected exactly one structured error log entry');
    const [entry] = structuredEntries;

    assert.equal(entry.correlationId, response.correlationId);
    assert.equal(entry.level, 'error');
    assert.equal(entry.context.meta.type, 'comet:summarise');
    assert.equal(entry.context.meta.error.message, 'generate requires source text.');
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.length > 0, 'stack should include a redacted stack trace');
    assert(entry.stack.includes('generate requires source text.'));
    assert(entry.stack.includes('[REDACTED]'));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    if (module) {
      module.__clearTestOverrides();
    }
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});

test('adapter failure propagates correlation id and cause stack in structured log', async () => {
  const { uninstall, chrome } = installChromeStub({
    'comet:apiKey:test': 'dummy-key',
    'comet:apiKeyMeta:test': { lastUpdated: Date.now() },
    'comet:apiKey:test-cause': 'dummy-key',
    'comet:apiKeyMeta:test-cause': { lastUpdated: Date.now() },
  });

  const listeners = [];
  chrome.runtime.onMessage.addListener = handler => {
    listeners.push(handler);
  };

  __setAgentYamlOverrideForTests(() => [
    'provider: test-cause',
    'model: stub-model',
    'routing:',
    '  provider_order:',
    '    - test-cause',
    '  max_tokens_per_call: 2000',
    '  max_monthly_tokens: 5000',
    'providers:',
    '  test-cause:',
    '    provider: test-cause',
    '    model: stub-model',
    '    api_url: https://api.test.example/v1/chat',
    '    api_key_var: TEST_KEY',
  ].join('\n'));

  const buildStubAdapter = () => ({
    getCostMetadata() {
      return { summarise: { model: 'stub-model', label: 'stub-summary' } };
    },
    async summarise() {
      const inner = new Error('inner adapter failure');
      inner.stack = 'Error: inner adapter failure\n    at adapter (/private/adapter.js:1:1)';
      const outer = new Error('adapter pipeline failure');
      outer.cause = inner;
      outer.stack = 'Error: adapter pipeline failure\n    at pipeline (/Users/test/app.js:2:2)';
      throw outer;
    },
  });

  registerAdapter('test-cause', () => buildStubAdapter());
  const stubAdapter = buildStubAdapter();

  const capturedLogs = [];
  const originalError = console.error;
  const originalWarn = console.warn;

  let module;
  try {
    module = await importServiceWorker();
    module.__setTestAdapterOverride('test-cause', stubAdapter);

    await module.ensureInitialised('test-cause');

    console.error = (...args) => {
      capturedLogs.push(args);
    };
    console.warn = (...args) => {
      capturedLogs.push(args);
    };

    assert.equal(listeners.length, 1, 'service worker should register one runtime listener');
    const [listener] = listeners;

    const message = {
      type: 'comet:summarise',
      correlationId: 'custom-corr-42',
      payload: {
        url: 'https://example.com/article',
        segments: [{ id: 'segment-1', text: 'hello world' }],
        language: 'en',
        provider: 'test-cause',
      },
    };

    const response = await new Promise(resolve => {
      listener(message, {}, result => {
        resolve(result);
      });
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(response.success, false);
    assert.equal(response.correlationId, 'custom-corr-42');

    assert(capturedLogs.length >= 1, 'expected console.error to be invoked for adapter failure');

    const structuredEntries = extractStructuredEntries(capturedLogs, 'Background message handler failed.');
    assert.equal(structuredEntries.length, 1, 'expected exactly one structured error log entry');
    const [entry] = structuredEntries;

    assert.equal(entry.correlationId, 'custom-corr-42');
    assert.equal(entry.context.meta.type, 'comet:summarise');
    assert(entry.context.meta.error.message.includes('adapter pipeline failure'));
    assert(entry.context.meta.error.stack.includes('adapter pipeline failure'));
    assert.equal(typeof entry.stack, 'string');
    assert(entry.stack.includes('adapter pipeline failure'));
    assert(entry.stack.includes('Caused by:') || entry.stack.includes('LLMRouter.generate'));
    assert(entry.stack.includes('[REDACTED]'));

    const providerEntries = extractStructuredEntries(capturedLogs, 'Provider invocation failed.');
    assert.equal(providerEntries.length, 1, 'expected one provider failure log entry');
    const [providerEntry] = providerEntries;
    assert.equal(providerEntry.correlationId, 'custom-corr-42');
    assert(providerEntry.stack.includes('adapter pipeline failure'));
    assert(providerEntry.stack.includes('inner adapter failure'));
    assert(providerEntry.stack.includes('Caused by:'));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    if (module) {
      module.__clearTestOverrides();
    }
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});
