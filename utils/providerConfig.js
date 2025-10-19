/**
 * Provider configuration helpers responsible for reading `agent.yaml`,
 * applying environment overrides, and building the runtime configuration passed
 * to adapters and the routing layer.
 *
 * @module utils/providerConfig
 */

import { loadYamlModule } from './yamlLoader.js';

const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  temperature: 0.3,
  headers: {},
});

const DEFAULT_ROUTING_CONFIG = Object.freeze({
  providerOrder: [
    'ollama',
    'huggingface_free',
    'gemini_free',
    'openai_trial',
    'mistral_trial',
    'gemini_paid',
    'openai_paid',
    'anthropic_paid',
    'mistral_paid',
  ],
  disablePaid: false,
  timeoutMs: 20000,
  retryLimit: 2,
  maxCostPerCallUsd: 0.01,
  maxMonthlyCostUsd: 2,
  dryRun: false,
});

const DEFAULT_GEMINI_CONFIG = Object.freeze({
  defaultModelFree: 'gemini-1.5-flash',
  defaultModelPaid: 'gemini-1.5-pro',
  apiKeyEnv: 'GOOGLE_API_KEY',
  projectEnv: 'GCP_PROJECT',
  locationEnv: 'GCP_LOCATION',
  credentialsEnv: 'GCP_CREDENTIALS',
  vertexEndpointEnv: 'VERTEX_ENDPOINT',
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

function normaliseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalised)) {
      return false;
    }
  }
  return fallback;
}

function normaliseNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normaliseProviderOrder(order) {
  if (!order) {
    return [];
  }
  if (Array.isArray(order)) {
    return order
      .map(entry => sanitiseString(entry)?.toLowerCase())
      .filter(Boolean);
  }
  if (typeof order === 'string') {
    return order
      .split(',')
      .map(entry => sanitiseString(entry)?.toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function readEnvironment() {
  if (typeof process === 'undefined' || !process.env) {
    return {};
  }
  return process.env;
}

function parseRoutingConfig(rawConfig, env = readEnvironment()) {
  const routingSource = rawConfig?.routing && typeof rawConfig.routing === 'object'
    ? rawConfig.routing
    : rawConfig;

  const providerOrderConfig =
    normaliseProviderOrder(routingSource?.provider_order || routingSource?.providerOrder);
  const envOrder = normaliseProviderOrder(env.PROVIDER_ORDER);
  const providerOrder = envOrder.length > 0 ? envOrder : providerOrderConfig;

  const disablePaid = normaliseBoolean(
    env.DISABLE_PAID ?? routingSource?.disable_paid ?? routingSource?.disablePaid,
    DEFAULT_ROUTING_CONFIG.disablePaid,
  );
  const timeoutMs = normaliseNumber(
    env.TIMEOUT_MS ?? routingSource?.timeout_ms ?? routingSource?.timeoutMs,
    DEFAULT_ROUTING_CONFIG.timeoutMs,
  );
  const retryLimit = Math.max(
    0,
    Math.floor(
      normaliseNumber(
        env.RETRY_LIMIT ?? routingSource?.retry_limit ?? routingSource?.retryLimit,
        DEFAULT_ROUTING_CONFIG.retryLimit,
      ),
    ),
  );
  const maxCostPerCallUsd = normaliseNumber(
    env.MAX_COST_PER_CALL_USD ?? env.MAX_COST_PER_CALL ?? routingSource?.max_cost_per_call_usd ?? routingSource?.maxCostPerCallUsd,
    DEFAULT_ROUTING_CONFIG.maxCostPerCallUsd,
  );
  const maxMonthlyCostUsd = normaliseNumber(
    env.MAX_MONTHLY_COST_USD ?? env.MAX_MONTHLY_COST ?? routingSource?.max_monthly_cost_usd ?? routingSource?.maxMonthlyCostUsd,
    DEFAULT_ROUTING_CONFIG.maxMonthlyCostUsd,
  );
  const dryRun = normaliseBoolean(
    env.DRY_RUN ?? routingSource?.dry_run ?? routingSource?.dryRun,
    DEFAULT_ROUTING_CONFIG.dryRun,
  );

  const routing = {
    providerOrder: providerOrder.length > 0 ? providerOrder : DEFAULT_ROUTING_CONFIG.providerOrder,
    disablePaid,
    timeoutMs,
    retryLimit,
    maxCostPerCallUsd,
    maxMonthlyCostUsd,
    dryRun,
  };

  return routing;
}

function parseGeminiConfig(rawConfig = {}) {
  const candidate = rawConfig?.gemini && typeof rawConfig.gemini === 'object' ? rawConfig.gemini : {};
  const normalised = {
    defaultModelFree:
      sanitiseString(candidate.default_model_free || candidate.defaultModelFree) || DEFAULT_GEMINI_CONFIG.defaultModelFree,
    defaultModelPaid:
      sanitiseString(candidate.default_model_paid || candidate.defaultModelPaid) || DEFAULT_GEMINI_CONFIG.defaultModelPaid,
    apiKeyEnv: sanitiseString(candidate.api_key_env || candidate.apiKeyEnv) || DEFAULT_GEMINI_CONFIG.apiKeyEnv,
    projectEnv: sanitiseString(candidate.project_env || candidate.projectEnv) || DEFAULT_GEMINI_CONFIG.projectEnv,
    locationEnv: sanitiseString(candidate.location_env || candidate.locationEnv) || DEFAULT_GEMINI_CONFIG.locationEnv,
    credentialsEnv:
      sanitiseString(candidate.credentials_env || candidate.credentialsEnv) || DEFAULT_GEMINI_CONFIG.credentialsEnv,
    vertexEndpointEnv:
      sanitiseString(candidate.vertex_endpoint_env || candidate.vertexEndpointEnv) ||
      DEFAULT_GEMINI_CONFIG.vertexEndpointEnv,
  };

  return normalised;
}

function parseProviderOverrides(rawProviders = {}, baseHeaders = {}) {
  if (!rawProviders || typeof rawProviders !== 'object') {
    return {};
  }

  return Object.entries(rawProviders).reduce((acc, [providerId, providerConfig]) => {
    if (!providerId || typeof providerConfig !== 'object') {
      return acc;
    }
    const normalisedId = sanitiseString(providerId)?.toLowerCase();
    if (!normalisedId) {
      return acc;
    }
    const headers = {
      ...normaliseHeaders(baseHeaders),
      ...normaliseHeaders(providerConfig.headers),
    };
    const normalisedConfig = {
      provider: normalisedId,
      model: sanitiseString(providerConfig.model),
      apiUrl: sanitiseString(providerConfig.api_url || providerConfig.apiUrl),
      apiKeyEnvVar: sanitiseString(providerConfig.api_key_var || providerConfig.apiKeyVar),
      temperature: typeof providerConfig.temperature === 'number' && Number.isFinite(providerConfig.temperature)
        ? providerConfig.temperature
        : undefined,
      headers,
    };
    acc[normalisedId] = cloneDefaultConfig({
      provider: normalisedId,
      ...normalisedConfig,
    });
    return acc;
  }, {});
}

/**
 * Converts raw YAML configuration into the structured format consumed by the
 * router and adapters, applying defaults and normalising case for keys.
 *
 * @param {object} rawConfig - Parsed YAML configuration object.
 * @returns {{base: object, providers: object, routing: object, gemini: object}}
 *   Normalised agent configuration.
 */
function normaliseAgentConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Invalid configuration structure.');
  }

  const baseHeaders = normaliseHeaders(rawConfig.headers);
  const baseConfig = cloneDefaultConfig({
    provider: sanitiseString(rawConfig.provider)?.toLowerCase() || DEFAULT_PROVIDER_CONFIG.provider,
    model: sanitiseString(rawConfig.model) || DEFAULT_PROVIDER_CONFIG.model,
    apiUrl: sanitiseString(rawConfig.api_url || rawConfig.apiUrl) || DEFAULT_PROVIDER_CONFIG.apiUrl,
    apiKeyEnvVar: sanitiseString(rawConfig.api_key_var || rawConfig.apiKeyVar) || DEFAULT_PROVIDER_CONFIG.apiKeyEnvVar,
    temperature: typeof rawConfig.temperature === 'number' && Number.isFinite(rawConfig.temperature)
      ? rawConfig.temperature
      : DEFAULT_PROVIDER_CONFIG.temperature,
    headers: baseHeaders,
  });

  const providerOverrides = parseProviderOverrides(rawConfig.providers, baseHeaders);
  const routing = parseRoutingConfig(rawConfig);
  const gemini = parseGeminiConfig(rawConfig);

  return {
    base: baseConfig,
    providers: providerOverrides,
    routing,
    gemini,
  };
}

/**
 * Builds a provider-specific configuration object based on the agent
 * configuration and an optional override identifier.
 *
 * @param {{base: object, providers?: object}} agentConfig - Normalised agent
 *   configuration.
 * @param {string} [providerOverride] - Provider identifier to target.
 * @returns {object} Provider configuration ready for adapter instantiation.
 */
function buildProviderConfig(agentConfig, providerOverride) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    return cloneDefaultConfig();
  }
  const baseProvider = agentConfig.base?.provider || DEFAULT_PROVIDER_CONFIG.provider;
  const resolvedProvider = sanitiseString(providerOverride)?.toLowerCase() || baseProvider;
  const overrides = agentConfig.providers?.[resolvedProvider];

  if (overrides) {
    const headers = {
      ...normaliseHeaders(agentConfig.base?.headers),
      ...normaliseHeaders(overrides.headers),
    };
    return cloneDefaultConfig({
      ...overrides,
      headers,
      provider: overrides.provider || resolvedProvider,
    });
  }

  if (resolvedProvider === baseProvider && agentConfig.base) {
    return cloneDefaultConfig({ ...agentConfig.base, provider: baseProvider });
  }

  return cloneDefaultConfig({ provider: resolvedProvider });
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

/**
 * Loads provider configuration details, optionally targeting a specific
 * provider override. The function parses `agent.yaml`, applies environment
 * overrides, and merges defaults for missing fields.
 *
 * @param {{provider?: string, suppressErrors?: boolean, source?: string,
 *   fetchImpl?: Function}} [options] - Loader configuration.
 * @returns {Promise<object>} Normalised provider configuration suitable for
 *   adapter construction.
 */
export async function loadProviderConfig(options = {}) {
  try {
    const yamlSource = await readAgentYaml(options);
    const YAML = await loadYamlModule();
    const parsed = YAML.parse(yamlSource);
    const agentConfig = normaliseAgentConfig(parsed);
    const providerConfig = buildProviderConfig(agentConfig, options.provider);
    return {
      ...providerConfig,
      routing: agentConfig.routing,
      providers: agentConfig.providers,
      gemini: agentConfig.gemini,
    };
  } catch (error) {
    if (options.suppressErrors) {
      return cloneDefaultConfig();
    }
    throw error;
  }
}

/**
 * Reads and normalises the full agent configuration, including routing and
 * provider overrides. Consumers typically cache the result to avoid repeated
 * YAML parsing.
 *
 * @param {{source?: string, fetchImpl?: Function}} [options] - Loader options
 *   used to supply alternate YAML content or fetch implementations.
 * @returns {Promise<{base: object, providers: object, routing: object, gemini: object}>}
 *   Complete agent configuration object.
 */
export async function loadAgentConfiguration(options = {}) {
  const yamlSource = await readAgentYaml(options);
  const YAML = await loadYamlModule();
  const parsed = YAML.parse(yamlSource);
  return normaliseAgentConfig(parsed);
}

/**
 * Generates a provider configuration using only default values. Optional
 * overrides can be supplied to adjust specific fields.
 *
 * @param {object} [overrides={}] - Field overrides merged into the defaults.
 * @returns {object} Provider configuration snapshot.
 */
export function getFallbackProviderConfig(overrides = {}) {
  return cloneDefaultConfig(overrides);
}

export {
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_GEMINI_CONFIG,
  normaliseAgentConfig,
  buildProviderConfig,
};

/**
 * Injects an alternate YAML payload for tests. The override can be a string or
 * a function returning a string, mirroring the behaviour of `readAgentYaml`.
 *
 * @param {string|Function} override - Alternate YAML content or supplier.
 */
export function __setAgentYamlOverrideForTests(override) {
  agentYamlOverride = override;
}

/**
 * Removes any previously configured YAML override, restoring the default
 * loading behaviour.
 */
export function __clearAgentYamlOverrideForTests() {
  agentYamlOverride = undefined;
}
