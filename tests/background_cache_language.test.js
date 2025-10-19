import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { registerAdapter } from '../background/adapters/registry.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';

test('summaries are cached per language for the same segment', async () => {
  const { uninstall, chrome } = installChromeStub({
    'comet:apiKey:test': 'dummy-key',
    'comet:apiKeyMeta:test': { lastUpdated: Date.now() },
  });
  const listenerRegistry = [];
  chrome.runtime.onMessage.addListener = handler => {
    listenerRegistry.push(handler);
  };

  const callLog = [];
  registerAdapter('test', () => ({
    getCostMetadata() {
      return { summarise: { model: 'stub-model' } };
    },
    async summarise({ text, language }) {
      callLog.push({ language, text });
      return { summary: `${language}:${text}` };
    },
  }));

  __setAgentYamlOverrideForTests(() => 'provider: test\nmodel: stub-model\n');

  try {
    const module = await importServiceWorker();
    await module.ensureInitialised('test');

    assert.equal(listenerRegistry.length, 1, 'service worker should register a single listener');
    const [listener] = listenerRegistry;
    const segment = { id: 'segment-1', text: 'Hello world' };
    const url = 'https://example.com/article';

    const sendSummariseMessage = payload =>
      new Promise((resolve, reject) => {
        try {
          listener({ type: 'comet:summarise', payload }, {}, response => {
            if (!response?.ok) {
              reject(new Error(response?.error || 'Unexpected error'));
              return;
            }
            resolve(response.result);
          });
        } catch (error) {
          reject(error);
        }
      });

    const firstResult = await sendSummariseMessage({ url, segments: [segment], language: 'en', provider: 'test' });
    assert.deepEqual(firstResult.summaries, [{ id: segment.id, summary: 'en:Hello world' }]);
    assert.equal(callLog.length, 1);

    const secondResult = await sendSummariseMessage({ url, segments: [segment], language: 'fr', provider: 'test' });
    assert.deepEqual(secondResult.summaries, [{ id: segment.id, summary: 'fr:Hello world' }]);
    assert.equal(callLog.length, 2, 'a new summary should be generated for a different language');

    const thirdResult = await sendSummariseMessage({ url, segments: [segment], language: 'en', provider: 'test' });
    assert.deepEqual(thirdResult.summaries, [{ id: segment.id, summary: 'en:Hello world' }]);
    assert.equal(callLog.length, 2, 'cached summaries should be reused for the same language');
  } finally {
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});

test('parseCacheKey correctly parses legacy cache keys', async () => {
  const { uninstall } = installChromeStub();
  try {
    const module = await importServiceWorker();
    const key = 'https://example.com::123';
    const parsed = module.parseCacheKey(key);
    assert.equal(parsed.language, 'en');
    assert.equal(parsed.providerId, 'openai');
  } finally {
    uninstall();
  }
});

test('parseCacheKey correctly parses language and providerId', async () => {
  const { uninstall } = installChromeStub();
  try {
    const module = await importServiceWorker();
    const key = module.getCacheKey({
      url: 'https://example.com',
      segmentId: '123',
      language: 'fr',
      providerId: 'test',
    });
    const parsed = module.parseCacheKey(key);
    assert.equal(parsed.language, 'fr');
    assert.equal(parsed.providerId, 'test');
  } finally {
    uninstall();
  }
});

test('getSummary requests summary with the correct language from the message', async () => {
  const { uninstall, chrome } = installChromeStub({
    'comet:apiKey:test': 'dummy-key',
    'comet:apiKeyMeta:test': { lastUpdated: Date.now() },
  });
  const listenerRegistry = [];
  chrome.runtime.onMessage.addListener = handler => {
    listenerRegistry.push(handler);
  };

  const callLog = [];
  registerAdapter('test', () => ({
    getCostMetadata() {
      return { summarise: { model: 'stub-model' } };
    },
    async summarise({ text, language }) {
      callLog.push({ language, text });
      return { summary: `${language}:${text}` };
    },
  }));

  __setAgentYamlOverrideForTests(() => 'provider: test\nmodel: stub-model\n');

  try {
    const module = await importServiceWorker();
    await module.ensureInitialised('test');

    assert.equal(listenerRegistry.length, 1, 'service worker should register a single listener');
    const [listener] = listenerRegistry;
    const segment = { id: 'segment-1', text: 'Hello world' };
    const url = 'https://example.com/article';

    const sendSummariseMessage = payload =>
      new Promise((resolve, reject) => {
        try {
          listener({ type: 'comet:summarise', payload }, {}, response => {
            if (!response?.ok) {
              reject(new Error(response?.error || 'Unexpected error'));
              return;
            }
            resolve(response.result);
          });
        } catch (error) {
          reject(error);
        }
      });

    const result = await sendSummariseMessage({ url, segments: [segment], language: 'de', provider: 'test' });
    assert.deepEqual(result.summaries, [{ id: segment.id, summary: 'de:Hello world' }]);
    assert.equal(callLog.length, 1);
    assert.equal(callLog[0].language, 'de');
  } finally {
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});
