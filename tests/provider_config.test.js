import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { loadProviderConfig, getFallbackProviderConfig } from '../utils/providerConfig.js';
import { loadEnv } from '../scripts/loadEnv.js';

test('loadProviderConfig merges provider overrides from agent.yaml', async () => {
  const yamlSource = `provider: anthropic\nmodel: default-model\napi_key_var: SHARED_KEY\nproviders:\n  anthropic:\n    model: claude-3-haiku\n    api_url: https://api.anthropic.com/v1/messages\n    api_key_var: ANTHROPIC_KEY\n    headers:\n      Anthropic-Version: 2023-06-01\n`;

  const config = await loadProviderConfig({ source: yamlSource });

  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-3-haiku');
  assert.equal(config.apiUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(config.apiKeyEnvVar, 'ANTHROPIC_KEY');
  assert.deepEqual(config.headers, { 'Anthropic-Version': '2023-06-01' });
});

test('loadProviderConfig allows overriding the provider through options', async () => {
  const yamlSource = `provider: openai\nproviders:\n  anthropic:\n    model: claude-3-haiku\n    api_url: https://api.anthropic.com/v1/messages\n    api_key_var: ANTHROPIC_KEY\n`;

  const config = await loadProviderConfig({ source: yamlSource, provider: 'anthropic' });

  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-3-haiku');
  assert.equal(config.apiUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(config.apiKeyEnvVar, 'ANTHROPIC_KEY');
});

test('getFallbackProviderConfig returns an independent copy', () => {
  const first = getFallbackProviderConfig();
  first.model = 'modified';
  const second = getFallbackProviderConfig();

  assert.equal(second.model, 'gpt-4o-mini');
  assert.notEqual(first, second);
});

test('loadEnv reads environment variables from the provided file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-env-'));
  const envPath = path.join(tmpDir, '.env');
  await fs.writeFile(envPath, 'FOO=bar\nHELLO=world');

  const parsed = loadEnv({ path: envPath });

  assert.deepEqual(parsed, { FOO: 'bar', HELLO: 'world' });
});

test('loadEnv ignores missing files without throwing', () => {
  const tmpDir = path.join(os.tmpdir(), `comet-env-missing-${Date.now()}`);
  const envPath = path.join(tmpDir, '.env');
  assert.doesNotThrow(() => loadEnv({ path: envPath }));
});

