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

test('loadProviderConfig applies gemini overrides when requested', async () => {
  const yamlSource = `provider: openai\nmodel: gpt-4o-mini\nproviders:\n  gemini:\n    model: gemini-1.5-flash-latest\n    api_url: https://generativelanguage.googleapis.com/v1beta/models\n    api_key_var: GOOGLE_GEMINI_API_KEY\n    headers:\n      X-Client: Comet\n`;

  const config = await loadProviderConfig({ source: yamlSource, provider: 'gemini' });

  assert.equal(config.provider, 'gemini');
  assert.equal(config.model, 'gemini-1.5-flash-latest');
  assert.equal(config.apiUrl, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(config.apiKeyEnvVar, 'GOOGLE_GEMINI_API_KEY');
  assert.deepEqual(config.headers, { 'X-Client': 'Comet' });
});

test('loadProviderConfig falls back to defaults when suppressErrors is enabled', async () => {
  const config = await loadProviderConfig({ source: 'not: yaml', suppressErrors: true });

  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-4o-mini');
  assert.equal(config.apiUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(config.apiKeyEnvVar, 'OPENAI_API_KEY');
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

test('.env values populate process.env without clobbering existing entries', async () => {
  const originalFoo = process.env.FOO;
  const originalBar = process.env.BAR;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-env-override-'));
  const envPath = path.join(tmpDir, '.env');
  await fs.writeFile(envPath, 'FOO=override\nBAR=baz');

  try {
    process.env.FOO = 'existing';
    delete process.env.BAR;
    const parsed = loadEnv({ path: envPath });

    assert.deepEqual(parsed, { FOO: 'override', BAR: 'baz' });
    assert.equal(process.env.FOO, 'existing');
    assert.equal(process.env.BAR, 'baz');
  } finally {
    if (typeof originalFoo === 'undefined') {
      delete process.env.FOO;
    } else {
      process.env.FOO = originalFoo;
    }
    if (typeof originalBar === 'undefined') {
      delete process.env.BAR;
    } else {
      process.env.BAR = originalBar;
    }
  }
});
