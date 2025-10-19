import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LLMRouter } from '../background/llm/router.js';
import { DEFAULT_GEMINI_CONFIG } from '../utils/providerConfig.js';

function createAgentConfig(overrides = {}) {
  return {
    base: {
      provider: 'openai_paid',
      model: 'gpt-4o-mini',
      apiUrl: 'https://api.openai.example/v1/chat',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      headers: {},
    },
    providers: {
      gemini_free: {
        provider: 'gemini_free',
        model: 'gemini-1.5-flash',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        apiKeyEnvVar: 'GOOGLE_API_KEY',
        headers: {},
      },
      openai_paid: {
        provider: 'openai_paid',
        model: 'gpt-4o-mini',
        apiUrl: 'https://api.openai.example/v1/chat',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        headers: {},
      },
    },
    routing: {
      providerOrder: ['gemini_free', 'openai_paid'],
      disablePaid: false,
      timeoutMs: 50,
      retryLimit: 0,
      maxCostPerCallUsd: 0.05,
      maxMonthlyCostUsd: 5,
      dryRun: false,
    },
    gemini: DEFAULT_GEMINI_CONFIG,
    ...overrides,
  };
}

function createCostTracker({ defaultEstimate = 0.001, estimates = {}, canSpend = true } = {}) {
  return {
    defaultEstimate,
    estimates,
    canSpendResult: canSpend,
    recorded: [],
    estimateCostForText(model) {
      return Object.prototype.hasOwnProperty.call(this.estimates, model)
        ? this.estimates[model]
        : this.defaultEstimate;
    },
    canSpend(amount) {
      return this.canSpendResult && amount <= 1;
    },
    record(model, promptTokens, completionTokens, metadata) {
      this.recorded.push({ model, promptTokens, completionTokens, metadata });
      return 0.0001;
    },
    estimateTokensFromText() {
      return 10;
    },
  };
}

function createAdapterStubs(results = {}) {
  return {
    gemini: () => ({
      summarise: async () => {
        if (results.gemini instanceof Error) {
          throw results.gemini;
        }
        return {
          summary: 'Gemini summary',
          promptTokens: 5,
          completionTokens: 5,
          model: 'gemini-1.5-flash',
        };
      },
    }),
    openai: () => ({
      summarise: async () => {
        if (results.openai instanceof Error) {
          throw results.openai;
        }
        return {
          summary: 'OpenAI summary',
          promptTokens: 8,
          completionTokens: 6,
          model: 'gpt-4o-mini',
        };
      },
    }),
  };
}

function createRouter({
  agentConfig = createAgentConfig(),
  costTracker = createCostTracker(),
  adapterResults = {},
  readApiKeys = {},
  environment = {},
} = {}) {
  const adapterFactories = createAdapterStubs(adapterResults);
  return new LLMRouter({
    costTracker,
    agentConfig,
    environment,
    readApiKeyFn: provider => readApiKeys[provider] || null,
    createAdapterFn: (key, config) => {
      const factory = adapterFactories[key];
      if (!factory) {
        throw new Error(`No adapter stub for ${key}`);
      }
      return factory(config);
    },
    routing: agentConfig.routing,
  });
}

test('generate prefers free providers before paid fallbacks', async () => {
  const router = createRouter({
    readApiKeys: { gemini_free: 'free-key' },
  });

  const result = await router.generate({ text: 'Hello world', language: 'en' });

  assert.equal(result.provider, 'gemini_free');
  assert.equal(result.text, 'Gemini summary');
});

test('generate falls back to paid provider when free fails', async () => {
  const router = createRouter({
    readApiKeys: { openai_paid: 'paid-key' },
    adapterResults: { gemini: new Error('quota exceeded') },
  });

  const result = await router.generate({ text: 'Hello world', language: 'en' });

  assert.equal(result.provider, 'openai_paid');
  assert.equal(result.text, 'OpenAI summary');
});

test('generate respects disablePaid flag', async () => {
  const agentConfig = createAgentConfig({
    routing: {
      providerOrder: ['gemini_free', 'openai_paid'],
      disablePaid: true,
      timeoutMs: 10,
      retryLimit: 0,
      maxCostPerCallUsd: 0.05,
      maxMonthlyCostUsd: 5,
      dryRun: false,
    },
  });

  const router = createRouter({
    agentConfig,
    adapterResults: { gemini: new Error('unavailable') },
  });

  await assert.rejects(
    router.generate({ text: 'Hello world', language: 'en' }),
    error => {
      assert.match(error.message, /No free providers available/);
      return true;
    },
  );
});

test('generate skips providers that exceed per-call cost', async () => {
  const costTracker = createCostTracker({
    defaultEstimate: 0.2,
    estimates: { 'gpt-4o-mini': 0.001 },
    canSpend: true,
  });
  const agentConfig = createAgentConfig({
    routing: {
      providerOrder: ['gemini_free', 'openai_paid'],
      disablePaid: false,
      timeoutMs: 10,
      retryLimit: 0,
      maxCostPerCallUsd: 0.01,
      maxMonthlyCostUsd: 5,
      dryRun: false,
    },
  });

  const router = createRouter({
    agentConfig,
    costTracker,
    readApiKeys: { openai_paid: 'paid-key' },
  });

  const result = await router.generate({ text: 'Hello world', language: 'en' });

  assert.equal(result.provider, 'openai_paid');
});
