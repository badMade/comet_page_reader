import YAML from 'yaml';

const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  temperature: 0.3,
  headers: {},
});

const CONFIG_RESOURCE_URL = new URL('../agent.yaml', import.meta.url);

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

function normaliseRawConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Invalid configuration structure.');
  }
  const provider = sanitiseString(rawConfig.provider)?.toLowerCase() || DEFAULT_PROVIDER_CONFIG.provider;
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

async function readAgentYaml({ source, fetchImpl } = {}) {
  if (source) {
    return source;
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('fs/promises');
    return fs.readFile(CONFIG_RESOURCE_URL, 'utf8');
  }

  if (typeof fetchImpl === 'function') {
    const response = await fetchImpl(CONFIG_RESOURCE_URL);
    if (!response.ok) {
      throw new Error(`Failed to load agent.yaml (${response.status})`);
    }
    return response.text();
  }

  if (typeof fetch === 'function') {
    const response = await fetch(CONFIG_RESOURCE_URL);
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
    const parsed = YAML.parse(yamlSource);
    return normaliseRawConfig(parsed);
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
