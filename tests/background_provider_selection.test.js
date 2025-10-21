import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadYamlModule } from '../utils/yamlLoader.js';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';

const yamlModulePromise = loadYamlModule();

async function createConfigYaml(provider) {
  const YAML = await yamlModulePromise;
  return YAML.stringify({
    provider,
    model: `${provider}-model`,
    api_url: `https://api.${provider}.example/v1/chat`,
    api_key_var: `${provider.toUpperCase()}_KEY`,
    temperature: 0.5,
    routing: {
      provider_order: [provider],
      max_tokens_per_call: 50,
      max_monthly_tokens: 1000,
      disable_paid: false,
    },
    providers: {
      [provider]: {
        provider,
        model: `${provider}-model`,
        api_url: `https://api.${provider}.example/v1/chat`,
        api_key_var: `${provider.toUpperCase()}_KEY`,
      },
    },
  });
}

test('setApiKey scopes storage to the active provider from agent.yaml', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  __setAgentYamlOverrideForTests(() => createConfigYaml('mistral'));

  try {
    const module = await importServiceWorker();
    await module.ensureInitialised('mistral');
    await module.setApiKey('mistral-key');

    assert.equal(persistentStore['comet:apiKey:mistral_paid'], 'mistral-key');
    assert.equal(typeof persistentStore['comet:apiKeyMeta:mistral_paid'].lastUpdated, 'number');

    const details = await module.getApiKeyDetails();
    assert.equal(details.provider, 'mistral_paid');
    assert.equal(details.requestedProvider, 'mistral_paid');
    assert.equal(details.apiKey, 'mistral-key');
  } finally {
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});

test('falls back to default provider when adapter registration fails', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  __setAgentYamlOverrideForTests(() => createConfigYaml('unknown'));

  try {
    const module = await importServiceWorker();
    await module.setApiKey('openai-key');

    assert.equal(persistentStore['comet:apiKey:openai_paid'], 'openai-key');
    const details = await module.getApiKeyDetails();
    assert.equal(details.provider, 'openai_paid');
    assert.equal(details.requestedProvider, 'auto');
  } finally {
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});

test('returns user requested provider when selection differs from active adapter', async () => {
  const { uninstall, persistentStore } = installChromeStub();

  try {
    const module = await importServiceWorker();
    await module.setActiveProvider('openai_trial');
    assert.equal(persistentStore['comet:activeProvider'], 'openai_trial');

    const details = await module.getApiKeyDetails();
    assert.equal(details.provider, 'openai_trial');
    assert.equal(details.requestedProvider, 'openai_trial');
  } finally {
    uninstall();
  }
});
