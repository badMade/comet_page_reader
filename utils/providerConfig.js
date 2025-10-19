import { loadYamlModule } from './yamlLoader.js';

const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  temperature: 0.3,
  headers: {},
});

const CONFIG_RESOURCE_URL = new URL('../agent.yaml', import.meta.url);
const CONFIG_RESOURCE_URL_STRING = CONFIG_RESOURCE_URL.href;

function invokeFetch(fetchFn, resource, init) {
  if (fetchFn === globalThis.fetch) {
    return globalThis.fetch(resource, init);
  }
  return fetchFn(resource, init);
}

function cloneDefaultConfig(overrides = {}) {
  return {
    ...DEFAULT_PROVIDER_CONFIG,
    headers: { ...DEFAULT_PROVIDER_CONFIG.headers },
    ...overrides,
    headers: {
      ...DEFAULT_PROVIDER_CONFIG.headers,
      ...(overrides.headers || {}),
    },
  };
}

function normaliseHeaders(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value).reduce((acc, [key, headerValue]) => {
    if (typeof headerValue === 'undefined' || headerValue === null) {
      return acc;
    }
    acc[String(key)] = String(headerValue);
    return acc;
  }, {});
}

function sanitiseString(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normaliseRawConfig(rawConfig, options = {}) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Invalid configuration structure.');
  }
  const overrideProvider = sanitiseString(options.provider)?.toLowerCase();
  const provider = overrideProvider || sanitiseString(rawConfig.provider)?.toLowerCase() || DEFAULT_PROVIDER_CONFIG.provider;
  const providersSection = rawConfig.providers && typeof rawConfig.providers === 'object' ? rawConfig.providers : undefined;
  const providerOverrides = providersSection && typeof providersSection[provider] === 'object' ? providersSection[provider] : undefined;
  const candidate = { ...rawConfig, ...(providerOverrides || {}) };
  const headers = {
    ...normaliseHeaders(rawConfig.headers),
    ...normaliseHeaders(providerOverrides && providerOverrides.headers),
  };

  return {
    provider,
    model: sanitiseString(candidate.model) || DEFAULT_PROVIDER_CONFIG.model,
    apiUrl: sanitiseString(candidate.api_url || candidate.apiUrl) || DEFAULT_PROVIDER_CONFIG.apiUrl,
    apiKeyEnvVar: sanitiseString(candidate.api_key_var || candidate.apiKeyVar) || DEFAULT_PROVIDER_CONFIG.apiKeyEnvVar,
    temperature: typeof candidate.temperature === 'number' && Number.isFinite(candidate.temperature)
      ? candidate.temperature
      : DEFAULT_PROVIDER_CONFIG.temperature,
    headers,
  };
}

let agentYamlOverride;

function resolveOverride(override) {
  if (typeof override === 'function') {
    return override();
  }
  return override;
}

async function readAgentYaml({ source, fetchImpl } = {}) {
  if (source) {
    return source;
  }

  if (typeof agentYamlOverride !== 'undefined') {
    return resolveOverride(agentYamlOverride);
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('fs/promises');
    return fs.readFile(CONFIG_RESOURCE_URL, 'utf8');
  }

  if (typeof fetchImpl === 'function') {
    const response = await invokeFetch(fetchImpl, CONFIG_RESOURCE_URL_STRING);
    if (!response.ok) {
      throw new Error(`Failed to load agent.yaml (${response.status})`);
    }
    return response.text();
  }

  if (typeof fetch === 'function') {
    const response = await globalThis.fetch(CONFIG_RESOURCE_URL_STRING);
    if (!response.ok) {
      throw new Error(`Failed to load agent.yaml (${response.status})`);
    }
    return response.text();
  }

  throw new Error('Unable to load agent.yaml in the current environment.');
}

export async function loadProviderConfig(options = {}) {
  try {
    const yamlSource = await readAgentYaml(options);
    const YAML = await loadYamlModule();
    const parsed = YAML.parse(yamlSource);
    return normaliseRawConfig(parsed, { provider: options.provider });
  } catch (error) {
    if (options.suppressErrors) {
      return cloneDefaultConfig();
    }
    throw error;
  }
}

export function getFallbackProviderConfig(overrides = {}) {
  return cloneDefaultConfig(overrides);
}

export { DEFAULT_PROVIDER_CONFIG };

export function __setAgentYamlOverrideForTests(override) {
  agentYamlOverride = override;
}

export function __clearAgentYamlOverrideForTests() {
  agentYamlOverride = undefined;
}
