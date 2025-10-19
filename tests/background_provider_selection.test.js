import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';
import { __setAgentYamlOverrideForTests, __clearAgentYamlOverrideForTests } from '../utils/providerConfig.js';

function createConfigYaml(provider) {
  return `provider: ${provider}\nmodel: ${provider}-model\napi_url: https://api.${provider}.example/v1/chat\napi_key_var: ${provider.toUpperCase()}_KEY\ntemperature: 0.5\n`;
}

test('setApiKey scopes storage to the active provider from agent.yaml', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  __setAgentYamlOverrideForTests(() => createConfigYaml('mistral'));

  try {
    const module = await importServiceWorker();
    await module.setApiKey('mistral-key');

    assert.equal(persistentStore['comet:apiKey:mistral'], 'mistral-key');
    assert.equal(typeof persistentStore['comet:apiKeyMeta:mistral'].lastUpdated, 'number');

    const details = await module.getApiKeyDetails();
    assert.equal(details.provider, 'mistral');
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

    assert.equal(persistentStore['comet:apiKey:openai'], 'openai-key');
    const details = await module.getApiKeyDetails();
    assert.equal(details.provider, 'openai');
  } finally {
    __clearAgentYamlOverrideForTests();
    uninstall();
  }
});
