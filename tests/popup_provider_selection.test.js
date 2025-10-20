import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL as NodeURL } from 'node:url';

import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

async function importPopupModule() {
  const moduleUrl = new NodeURL('../popup/script.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

function createAgentConfig({ defaultProvider, supportedProviders }) {
  const lines = [];
  if (defaultProvider) {
    lines.push(`provider: ${defaultProvider}`);
  }
  if (supportedProviders && supportedProviders.length > 0) {
    lines.push(`# Supported providers: ${supportedProviders.join(', ')}`);
  }
  return lines.join('\n');
}

test('popup retains stored provider preference when agent allows it', async () => {
  const { chrome: chromeStub, getElement } = setupPopupTestEnvironment();
  document.readyState = 'complete';
  chromeStub.runtime.getURL = path => path;
  const agentConfig = createAgentConfig({
    defaultProvider: 'anthropic_paid',
    supportedProviders: ['anthropic_paid', 'mistral_paid'],
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => agentConfig,
  });

  const providerMessages = [];
  chromeStub.runtime.sendMessage = (message, callback) => {
    chromeStub.runtime.lastError = null;
    const { type, payload } = message;
    if (type === 'comet:getApiKeyDetails') {
      queueMicrotask(() => {
        callback({
          ok: true,
          result: {
            apiKey: null,
            provider: 'mistral_paid',
            requestedProvider: 'mistral_paid',
            lastUpdated: null,
          },
        });
      });
      return undefined;
    }
    if (type === 'comet:setProvider') {
      providerMessages.push(payload?.provider);
      queueMicrotask(() => {
        callback({
          ok: true,
          result: { provider: payload?.provider, requiresApiKey: true },
        });
      });
      return undefined;
    }
    if (type === 'comet:getUsage') {
      queueMicrotask(() => {
        callback({
          ok: true,
          result: { totalCostUsd: 0, limitUsd: 5, lastReset: Date.now() },
        });
      });
      return undefined;
    }
    throw new Error(`Unexpected message: ${type}`);
  };

  await importPopupModule();

  const waitForTick = () => new Promise(resolve => setTimeout(resolve, 0));
  await waitForTick();
  await waitForTick();

  const providerSelect = getElement('providerSelect');
  assert.equal(providerSelect.value, 'mistral_paid');
  assert.deepEqual(providerMessages, []);
});

test('popup updates background provider when agent restrictions apply', async () => {
  const { chrome: chromeStub, getElement } = setupPopupTestEnvironment();
  document.readyState = 'complete';
  chromeStub.runtime.getURL = path => path;
  const agentConfig = createAgentConfig({
    defaultProvider: 'anthropic_paid',
    supportedProviders: ['anthropic_paid'],
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => agentConfig,
  });

  const providerMessages = [];
  chromeStub.runtime.sendMessage = (message, callback) => {
    chromeStub.runtime.lastError = null;
    const { type, payload } = message;
    if (type === 'comet:getApiKeyDetails') {
      queueMicrotask(() => {
        callback({
          ok: true,
          result: {
            apiKey: null,
            provider: 'mistral_paid',
            requestedProvider: 'mistral_paid',
            lastUpdated: null,
          },
        });
      });
      return undefined;
    }
    if (type === 'comet:setProvider') {
      providerMessages.push(payload?.provider);
      queueMicrotask(() => {
        callback({
          ok: true,
          result: { provider: payload?.provider, requiresApiKey: true },
        });
      });
      return undefined;
    }
    if (type === 'comet:getUsage') {
      queueMicrotask(() => {
        callback({
          ok: true,
          result: { totalCostUsd: 0, limitUsd: 5, lastReset: Date.now() },
        });
      });
      return undefined;
    }
    throw new Error(`Unexpected message: ${type}`);
  };

  await importPopupModule();

  const waitForTick = () => new Promise(resolve => setTimeout(resolve, 0));
  await waitForTick();
  await waitForTick();

  const providerSelect = getElement('providerSelect');
  assert.equal(providerSelect.value, 'anthropic_paid');
  assert.deepEqual(providerMessages, ['anthropic_paid']);
});
