/**
 * Intelligent routing layer that prioritises cost-effective providers while
 * respecting user preferences and spend controls.
 *
 * @module background/llm/router
 */

import {
  buildProviderConfig,
  loadAgentConfiguration,
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_GEMINI_CONFIG,
} from '../../utils/providerConfig.js';
import { resolveAlias, getProviderDisplayName, normaliseProviderId } from '../../utils/providers.js';
import { readApiKey } from '../../utils/apiKeyStore.js';
import createLogger from '../../utils/logger.js';
import { createAdapter } from '../adapters/registry.js';

const PROVIDER_TIERS = Object.freeze({
  LOCAL: 'local',
  FREE: 'free',
  TRIAL: 'trial',
  PAID: 'paid',
});

const AUTH_ERROR_CODES = new Set([401, 403]);

const TOKEN_SCOPES = Object.freeze(['https://www.googleapis.com/auth/cloud-platform']);

const PROVIDER_METADATA = Object.freeze({
  ollama: { tier: PROVIDER_TIERS.LOCAL, requiresKey: false, adapterKey: 'ollama' },
  huggingface_free: { tier: PROVIDER_TIERS.FREE, requiresKey: true, adapterKey: 'huggingface' },
  gemini_free: { tier: PROVIDER_TIERS.FREE, requiresKey: true, adapterKey: 'gemini' },
  gemini_paid: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'gemini' },
  openai_trial: { tier: PROVIDER_TIERS.TRIAL, requiresKey: true, adapterKey: 'openai' },
  openai_paid: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'openai' },
  mistral_trial: { tier: PROVIDER_TIERS.TRIAL, requiresKey: true, adapterKey: 'mistral' },
  mistral_paid: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'mistral' },
  anthropic_paid: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'anthropic' },
  openai: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'openai' },
  mistral: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'mistral' },
  anthropic: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'anthropic' },
  gemini: { tier: PROVIDER_TIERS.PAID, requiresKey: true, adapterKey: 'gemini' },
  huggingface: { tier: PROVIDER_TIERS.FREE, requiresKey: true, adapterKey: 'huggingface' },
});

const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_TIMEOUT_MS = 60_000;

function uniqueProviderOrder(order) {
  const seen = new Set();
  const result = [];
  order.forEach(providerId => {
    const resolved = normaliseProviderId(providerId, providerId);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  });
  return result;
}

function readEnvironment() {
  if (typeof process === 'undefined' || !process.env) {
    return {};
  }
  return process.env;
}

function delay(ms, timer = setTimeout) {
  return new Promise(resolve => timer(resolve, ms));
}

function hashValue(value) {
  if (!value) {
    return null;
  }
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    hash = (hash * 31 + charCode) % 2147483647;
  }
  return hash;
}

function getLogger(logger) {
  if (logger && typeof logger.info === 'function') {
    return logger;
  }
  return createLogger({ name: 'llm-router' });
}

function getFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') {
    return fetchImpl;
  }
  if (typeof globalThis.fetch === 'function') {
    return (...args) => globalThis.fetch(...args);
  }
  throw new Error('Fetch API is not available in this environment.');
}

function createTimeoutPromise(ms, errorMessage, timer = setTimeout, clearTimer = clearTimeout) {
  let handle;
  const promise = new Promise((_, reject) => {
    const error = new Error(errorMessage || `Operation timed out after ${ms}ms`);
    error.code = 'ETIMEOUT';
    handle = timer(() => reject(error), ms);
    if (handle && typeof handle.unref === 'function') {
      handle.unref();
    }
  });
  const cancel = () => {
    if (handle !== undefined) {
      if (typeof clearTimer === 'function') {
        clearTimer(handle);
      }
      handle = undefined;
    }
  };
  return { promise, cancel };
}

function normaliseNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function isAuthError(error) {
  if (!error) {
    return false;
  }
  if (typeof error.status === 'number') {
    return AUTH_ERROR_CODES.has(error.status);
  }
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('unauthorised') || message.includes('unauthorized') || message.includes('forbidden');
}

function normaliseProvider(providerId) {
  return resolveAlias(providerId);
}

function normaliseModelName(modelValue, fallback) {
  if (typeof modelValue === 'string') {
    const trimmed = modelValue.trim();
    if (trimmed) {
      const segments = trimmed.split('/').filter(Boolean);
      if (segments.length > 0) {
        return segments[segments.length - 1];
      }
      return trimmed;
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  return fallback;
}

function getLegacyProviderId(providerId) {
  if (!providerId) {
    return null;
  }
  if (providerId.endsWith('_paid') || providerId.endsWith('_trial')) {
    return providerId.replace(/_(paid|trial)$/, '');
  }
  if (providerId === 'gemini_free' || providerId === 'gemini_paid') {
    return 'gemini';
  }
  if (providerId === 'huggingface_free') {
    return 'huggingface';
  }
  return null;
}

async function createJwtAssertion({ clientEmail, privateKey, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: scope.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const unsignedToken = `${encode(header)}.${encode(payload)}`;
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  const signature = signer.sign(privateKey, 'base64url');
  return `${unsignedToken}.${signature}`;
}

async function fetchAccessToken({ credentialsPath, fetchImpl, scope }) {
  if (!credentialsPath) {
    throw new Error('Missing Vertex credentials path. Provide GCP_ACCESS_TOKEN or configure GCP_CREDENTIALS.');
  }
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(credentialsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Invalid service account credentials JSON.');
  }
  const assertion = await createJwtAssertion({ clientEmail: parsed.client_email, privateKey: parsed.private_key, scope });
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to obtain Vertex access token (${response.status}): ${message}`);
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Vertex token response missing access_token.');
  }
  return { token: data.access_token, expiresIn: normaliseNumber(data.expires_in, 3600) };
}

/**
 * Orchestrates provider selection for summarisation requests. The router keeps
 * track of provider health, cost limits, and authentication so the extension
 * can prioritise free tiers while respecting user preferences and budgets.
 */
export class LLMRouter {
  /**
   * Creates a router instance with optional dependency overrides used during
   * testing.
   *
   * @param {{
   *   logger?: Console,
   *   readApiKeyFn?: Function,
   *   environment?: object,
   *   now?: Function,
   *   random?: Function,
   *   fetchImpl?: Function,
   *   costTracker?: import('../../utils/cost.js').CostTracker,
   *   loadAgentConfigurationFn?: Function,
   *   agentConfig?: object,
   *   routing?: object,
   *   createAdapterFn?: Function,
   * }} [options] - Dependency injection hooks.
   */
  constructor(options = {}) {
    this.logger = getLogger(options.logger);
    this.readApiKeyFn = options.readApiKeyFn || (provider => readApiKey({ provider }));
    this.environment = options.environment || readEnvironment();
    this.now = options.now || (() => Date.now());
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.fetch = getFetch(options.fetchImpl);
    this.costTracker = options.costTracker;
    this.loadAgentConfigurationFn = options.loadAgentConfigurationFn || loadAgentConfiguration;
    this.agentConfig = options.agentConfig || null;
    this.providerConfigCache = new Map();
    this.adapterCache = new Map();
    this.providerState = new Map();
    this.routing = options.routing || DEFAULT_ROUTING_CONFIG;
    this.vertexTokenCache = null;
    this.createAdapterFn = typeof options.createAdapterFn === 'function' ? options.createAdapterFn : createAdapter;
  }

  /**
   * Assigns the cost tracker instance used to enforce spend limits during
   * routing decisions.
   *
   * @param {import('../../utils/cost.js').CostTracker} costTracker - Tracker
   *   instance monitoring spend.
   */
  setCostTracker(costTracker) {
    this.costTracker = costTracker;
  }

  /**
   * Updates the agent configuration snapshot and refreshes routing defaults
   * derived from it.
   *
   * @param {{routing?: object}} agentConfig - Normalised configuration object.
   */
  setAgentConfig(agentConfig) {
    this.agentConfig = agentConfig;
    if (agentConfig?.routing) {
      this.routing = {
        ...DEFAULT_ROUTING_CONFIG,
        ...agentConfig.routing,
      };
    }
  }

  /**
   * Clears cached provider configurations and adapter instances so subsequent
   * requests reload the latest configuration.
   */
  clearCaches() {
    this.providerConfigCache.clear();
    this.adapterCache.clear();
  }

  /**
   * Ensures the agent configuration has been loaded from disk or the provided
   * loader before attempting to route a request.
   *
   * @returns {Promise<void>} Resolves once the configuration is available.
   */
  async ensureAgentConfigLoaded() {
    if (!this.agentConfig) {
      const config = await this.loadAgentConfigurationFn();
      this.setAgentConfig(config);
    }
  }

  /**
   * Returns the active routing configuration, falling back to defaults when
   * missing.
   *
   * @returns {object} Routing configuration snapshot.
   */
  getRoutingConfig() {
    return this.routing || DEFAULT_ROUTING_CONFIG;
  }

  /**
   * Provides the Gemini-specific configuration derived from the agent config or
   * defaults.
   *
   * @returns {object} Gemini configuration block.
   */
  getGeminiConfig() {
    return this.agentConfig?.gemini || DEFAULT_GEMINI_CONFIG;
  }

  /**
   * Retrieves metadata describing the specified provider, including tier and
   * authentication requirements.
   *
   * @param {string} providerId - Provider identifier.
   * @returns {{tier: string, requiresKey: boolean, adapterKey: string}} Provider metadata.
   */
  getProviderMetadata(providerId) {
    const resolved = normaliseProvider(providerId);
    return PROVIDER_METADATA[resolved] || {
      tier: PROVIDER_TIERS.PAID,
      requiresKey: true,
      adapterKey: resolved,
    };
  }

  /**
   * Indicates whether the provider belongs to a paid tier.
   *
   * @param {string} providerId - Provider identifier.
   * @returns {boolean} True when the provider requires payment.
   */
  isPaidProvider(providerId) {
    const metadata = this.getProviderMetadata(providerId);
    return metadata?.tier === PROVIDER_TIERS.PAID;
  }

  /**
   * Resolves the configuration block for the specified provider, caching the
   * result for subsequent lookups.
   *
   * @param {string} providerId - Provider identifier or alias.
   * @returns {Promise<object>} Provider configuration snapshot.
   */
  async getProviderConfig(providerId) {
    const resolved = normaliseProvider(providerId);
    if (this.providerConfigCache.has(resolved)) {
      return this.providerConfigCache.get(resolved);
    }
    await this.ensureAgentConfigLoaded();
    const config = buildProviderConfig(this.agentConfig, resolved);
    this.providerConfigCache.set(resolved, config);
    return config;
  }

  /**
   * Retrieves the adapter instance responsible for fulfilling requests against
   * the given provider.
   *
   * @param {string} providerId - Provider identifier or alias.
   * @returns {Promise<object>} Adapter instance implementing provider methods.
   */
  async getAdapter(providerId) {
    const resolved = normaliseProvider(providerId);
    if (this.adapterCache.has(resolved)) {
      return this.adapterCache.get(resolved);
    }
    const metadata = this.getProviderMetadata(resolved);
    if (!metadata) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const config = await this.getProviderConfig(resolved);
    const adapter = this.createAdapterFn(metadata.adapterKey || resolved, config);
    this.adapterCache.set(resolved, adapter);
    return adapter;
  }

  /**
   * Returns internal state tracking provider health, retries, and usage.
   *
   * @param {string} providerId - Provider identifier.
   * @returns {{failures: number, blockedUntil: number, invalidAuth: boolean, lastKeyHash: number|null, calls: number, tokensIn: number, tokensOut: number, totalTokens: number}}
   *   Mutable state object.
   */
  getProviderState(providerId) {
    const resolved = normaliseProvider(providerId);
    if (!this.providerState.has(resolved)) {
      this.providerState.set(resolved, {
        failures: 0,
        blockedUntil: 0,
        invalidAuth: false,
        lastKeyHash: null,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        totalTokens: 0,
      });
    }
    return this.providerState.get(resolved);
  }

  /**
   * Records a provider failure and opens the circuit when repeated errors are
   * observed.
   *
   * @param {string} providerId - Provider identifier.
   * @param {Error} error - Error returned by the provider call.
   */
  markProviderFailure(providerId, error) {
    const state = this.getProviderState(providerId);
    state.failures += 1;
    if (isAuthError(error)) {
      state.invalidAuth = true;
    }
    if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      state.blockedUntil = this.now() + CIRCUIT_BREAKER_TIMEOUT_MS;
    }
  }

  /**
   * Registers a successful provider invocation and updates aggregate metrics.
   *
   * @param {string} providerId - Provider identifier.
   * @param {{tokensIn?: number, tokensOut?: number, totalTokens?: number}} [details]
   *   - Usage metrics supplied by the adapter.
   */
  markProviderSuccess(providerId, { tokensIn = 0, tokensOut = 0, totalTokens = 0 } = {}) {
    const state = this.getProviderState(providerId);
    state.failures = 0;
    state.blockedUntil = 0;
    state.calls += 1;
    state.tokensIn += tokensIn;
    state.tokensOut += tokensOut;
    state.totalTokens += totalTokens;
  }

  /**
   * Clears cached authentication failures when a different API key is detected
   * for the provider.
   *
   * @param {string} providerId - Provider identifier.
   * @param {number|null} apiKeyHash - Hash of the API key used for the request.
   */
  clearAuthFailure(providerId, apiKeyHash) {
    const state = this.getProviderState(providerId);
    if (state.lastKeyHash !== apiKeyHash) {
      state.invalidAuth = false;
    }
    state.lastKeyHash = apiKeyHash;
  }

  /**
   * Determines whether the provider is currently blocked due to repeated
   * failures.
   *
   * @param {string} providerId - Provider identifier.
   * @returns {boolean} True when the provider should be skipped temporarily.
   */
  isBlocked(providerId) {
    const state = this.getProviderState(providerId);
    return state.blockedUntil && state.blockedUntil > this.now();
  }

  /**
   * Resolves the API key for the provider from storage, legacy aliases, or the
   * environment.
   *
   * @param {string} providerId - Provider identifier.
   * @param {{apiKeyEnvVar?: string}} [config] - Provider configuration.
   * @returns {Promise<string|null>} API key value or null when unavailable.
   */
  async getApiKey(providerId, config) {
    const resolved = normaliseProvider(providerId);
    const stored = await this.readApiKeyFn(resolved);
    if (stored) {
      return stored;
    }
    const legacyId = getLegacyProviderId(resolved);
    if (legacyId) {
      const legacyKey = await this.readApiKeyFn(legacyId);
      if (legacyKey) {
        return legacyKey;
      }
    }
    const envVar = config?.apiKeyEnvVar;
    if (envVar && this.environment && typeof this.environment[envVar] === 'string') {
      return this.environment[envVar];
    }
    return null;
  }

  /**
   * Computes the provider routing order by combining configured defaults and
   * the user's preferred provider when supplied.
   *
   * @param {string|null} preference - Optional preferred provider identifier.
   * @returns {string[]} Ordered list of provider IDs to attempt.
   */
  getRoutingOrder(preference) {
    const baseOrder = uniqueProviderOrder(this.getRoutingConfig().providerOrder || []);
    const resolvedPreference = normaliseProvider(preference);
    if (!resolvedPreference || resolvedPreference === 'auto') {
      return baseOrder;
    }
    const metadata = this.getProviderMetadata(resolvedPreference);
    if (metadata && metadata.tier !== PROVIDER_TIERS.PAID) {
      const combined = uniqueProviderOrder([resolvedPreference, ...baseOrder]);
      return combined.filter(providerId => providerId !== 'auto');
    }
    const combined = uniqueProviderOrder([...baseOrder, resolvedPreference]);
    return combined.filter(providerId => providerId !== 'auto');
  }

  /**
   * Checks whether the upcoming request can be executed without breaching the
   * configured per-call or cumulative cost ceilings.
   *
   * @param {string} model - Model identifier used for cost estimation.
   * @param {string} text - Source text being summarised.
   * @returns {Promise<boolean>} True when sufficient budget remains.
   */
  async ensureTokenBudget(model, text) {
    if (!this.costTracker) {
      return true;
    }
    const routing = this.getRoutingConfig();
    const estimate = this.costTracker.estimateTokenUsage(model, text);
    const totalTokens = estimate?.totalTokens || 0;
    if (routing.maxTokensPerCall > 0 && totalTokens > routing.maxTokensPerCall) {
      return false;
    }
    return this.costTracker.canSpend(totalTokens);
  }

  /**
   * Records the token usage of a provider invocation when a tracker is available.
   *
   * @param {string} model - Model identifier used for tracker lookups.
   * @param {number} promptTokens - Tokens submitted in the request.
   * @param {number} completionTokens - Tokens returned in the response.
   * @param {object} metadata - Additional metadata stored alongside the entry.
   * @returns {Promise<{
   *   totalTokens: number,
   *   usageTotals: {promptTokens: number, completionTokens: number, totalTokens: number}|null,
   *   cumulativeTotals: {promptTokens: number, completionTokens: number, totalTokens: number}|null,
   * }>} Recorded token summary.
   */
  async recordCost(model, promptTokens, completionTokens, metadata) {
    if (!this.costTracker) {
      return { totalTokens: 0, usageTotals: null, cumulativeTotals: null };
    }
    const totalTokens = this.costTracker.record(model, promptTokens, completionTokens, metadata);
    const usageTotals = typeof this.costTracker.getUsageTotals === 'function'
      ? this.costTracker.getUsageTotals()
      : null;
    const cumulativeTotals = typeof this.costTracker.getCumulativeTotals === 'function'
      ? this.costTracker.getCumulativeTotals()
      : null;
    return { totalTokens, usageTotals, cumulativeTotals };
  }

  /**
   * Obtains a Vertex AI access token using either environment variables or a
   * service-account JSON file.
   *
   * @param {{project: string, location: string, credentialsPath?: string}} params -
   *   Authentication parameters.
   * @returns {Promise<{token: string, expiresIn: number}>} Access token details.
   */
  async getVertexAccessToken({ project, location, credentialsPath }) {
    const envCandidates = ['VERTEX_ACCESS_TOKEN', 'GOOGLE_VERTEX_TOKEN', 'GCP_ACCESS_TOKEN'];
    for (const candidate of envCandidates) {
      const value = this.environment?.[candidate];
      if (typeof value === 'string' && value) {
        return { token: value, expiresIn: 3600 };
      }
    }
    if (typeof process === 'undefined' || !process.versions?.node) {
      throw new Error('Vertex access tokens require Node.js environment or pre-supplied token.');
    }
    return fetchAccessToken({ credentialsPath, fetchImpl: this.fetch, scope: TOKEN_SCOPES });
  }

  /**
   * Resolves the authentication strategy for Gemini providers, preferring API
   * keys but falling back to Vertex credentials when required.
   *
   * @param {string} providerId - Provider identifier.
   * @param {object} config - Provider configuration snapshot.
   * @returns {Promise<object>} Authentication descriptor.
   */
  async resolveGeminiAuth(providerId, config) {
    const apiKey = await this.getApiKey(providerId, config);
    const keyHash = hashValue(apiKey || '');
    this.clearAuthFailure(providerId, keyHash);
    if (apiKey) {
      return { mode: 'apiKey', apiKey };
    }

    const geminiConfig = this.getGeminiConfig();
    const project = this.environment?.[geminiConfig.projectEnv];
    const location = this.environment?.[geminiConfig.locationEnv];
    const credentialsPath = this.environment?.[geminiConfig.credentialsEnv];
    if (!project || !location) {
      throw new Error('Gemini Vertex configuration missing GCP_PROJECT or GCP_LOCATION.');
    }
    const endpoint = this.environment?.[geminiConfig.vertexEndpointEnv] || config.apiUrl;
    const cached = this.vertexTokenCache;
    if (cached && cached.expiresAt && cached.expiresAt > this.now() + 60_000) {
      return { mode: 'vertex', accessToken: cached.token, project, location, endpoint };
    }
    const { token, expiresIn } = await this.getVertexAccessToken({ project, location, credentialsPath });
    this.vertexTokenCache = {
      token,
      expiresAt: this.now() + (expiresIn * 1000),
    };
    return { mode: 'vertex', accessToken: token, project, location, endpoint };
  }

  /**
   * Builds the invocation context containing provider ID and authentication
   * details ready to be passed to adapters.
   *
   * @param {string} providerId - Provider identifier.
   * @param {object} config - Provider configuration snapshot.
   * @returns {Promise<{providerId: string, auth: object}>} Invocation context.
   */
  async buildInvocationContext(providerId, config) {
    const metadata = this.getProviderMetadata(providerId);
    if (!metadata) {
      throw new Error(`Unsupported provider: ${providerId}`);
    }
    if (!metadata.requiresKey) {
      return { providerId: normaliseProvider(providerId), auth: { mode: 'none' } };
    }
    if (metadata.adapterKey === 'gemini') {
      const auth = await this.resolveGeminiAuth(providerId, config);
      return { providerId: normaliseProvider(providerId), auth };
    }
    const apiKey = await this.getApiKey(providerId, config);
    const keyHash = hashValue(apiKey || '');
    this.clearAuthFailure(providerId, keyHash);
    if (!apiKey) {
      throw new Error(`Missing ${getProviderDisplayName(providerId)} API key.`);
    }
    return { providerId: normaliseProvider(providerId), auth: { mode: 'apiKey', apiKey } };
  }

  /**
   * Executes the supplied asynchronous operation, enforcing a timeout when the
   * routing configuration specifies one.
   *
   * @param {string} providerId - Provider identifier for error context.
   * @param {Function} operation - Function returning a promise.
   * @param {number} timeoutMs - Timeout in milliseconds.
   * @returns {Promise<*>} Result of the operation.
   */
  async executeWithTimeout(providerId, operation, timeoutMs) {
    if (timeoutMs > 0) {
      const { promise: timeoutPromise, cancel } = createTimeoutPromise(timeoutMs, `Provider ${providerId} timed out`);
      const operationPromise = Promise.resolve().then(operation);
      try {
        return await Promise.race([operationPromise, timeoutPromise]);
      } finally {
        cancel();
      }
    }
    return operation();
  }

  /**
   * Invokes the specified provider to generate a summary while handling retries
   * and usage accounting.
   *
   * @param {string} providerId - Provider identifier.
   * @param {{text: string, language: string, metadata?: object}} payload -
   *   Invocation parameters.
   * @returns {Promise<{text: string, tokensIn: number, tokensOut: number, model: string, provider: string, totalTokens: number}>}
   *   Provider response enriched with accounting metadata.
   */
  async invokeProvider(providerId, { text, language, metadata }) {
    const resolved = normaliseProvider(providerId);
    const config = await this.getProviderConfig(resolved);
    const { auth } = await this.buildInvocationContext(resolved, config);
    const adapter = await this.getAdapter(resolved);
    const routing = this.getRoutingConfig();
    const model = config.model || (auth.mode === 'vertex'
      ? this.getGeminiConfig().defaultModelPaid
      : this.getGeminiConfig().defaultModelFree);

    const performCall = async () => {
      const response = await adapter.summarise({
        apiKey: auth.apiKey,
        accessToken: auth.accessToken,
        project: auth.project,
        location: auth.location,
        endpoint: auth.endpoint,
        text,
        language,
        model,
      });
      const summary = response?.summary || '';
      const promptTokens = typeof response?.promptTokens === 'number'
        ? response.promptTokens
        : this.costTracker?.estimateTokensFromText(text) || 0;
      const completionTokens = typeof response?.completionTokens === 'number'
        ? response.completionTokens
        : this.costTracker?.estimateTokensFromText(summary) || 0;
      const modelUsed = normaliseModelName(response?.model, model);
      const usageRecord = await this.recordCost(modelUsed, promptTokens, completionTokens, {
        provider: resolved,
        type: metadata?.type || 'summary',
        url: metadata?.url,
        segmentId: metadata?.segmentId,
      });
      const recordedTokens = typeof usageRecord === 'number'
        ? usageRecord
        : usageRecord?.totalTokens ?? 0;
      const usageTotals = typeof this.costTracker?.getUsageTotals === 'function'
        ? this.costTracker.getUsageTotals()
        : usageRecord && typeof usageRecord === 'object'
          ? usageRecord.usageTotals ?? null
          : null;
      const cumulativeTotals = typeof this.costTracker?.getCumulativeTotals === 'function'
        ? this.costTracker.getCumulativeTotals()
        : usageRecord && typeof usageRecord === 'object'
          ? usageRecord.cumulativeTotals ?? null
          : null;
      this.markProviderSuccess(resolved, {
        tokensIn: promptTokens,
        tokensOut: completionTokens,
        totalTokens: recordedTokens,
      });
      this.logger.info('Recorded provider usage.', {
        provider: resolved,
        model: modelUsed,
        promptTokens,
        completionTokens,
        recordedTokens,
        totals: usageTotals,
        cumulativeTotals,
      });
      return {
        text: summary,
        tokensIn: promptTokens,
        tokensOut: completionTokens,
        model: modelUsed,
        provider: resolved,
        totalTokens: recordedTokens,
        usageTotals,
        cumulativeTotals,
      };
    };

    const retryLimit = routing.retryLimit ?? DEFAULT_ROUTING_CONFIG.retryLimit;
    let attempt = 0;
    let lastError;
    let backoff = DEFAULT_BACKOFF_MS;

    while (attempt <= retryLimit) {
      try {
        const result = await this.executeWithTimeout(resolved, performCall, routing.timeoutMs);
        return result;
      } catch (error) {
        lastError = error;
        if (isAuthError(error)) {
          this.markProviderFailure(resolved, error);
          throw error;
        }
        attempt += 1;
        if (attempt > retryLimit) {
          this.markProviderFailure(resolved, error);
          throw error;
        }
        const jitter = backoff * (0.5 + this.random());
        await delay(Math.min(backoff + jitter, MAX_BACKOFF_MS));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }

    throw lastError || new Error(`Provider ${resolved} failed unexpectedly.`);
  }

  /**
   * Routes a summarisation request through the configured provider order,
   * returning the first successful response or raising an aggregated error.
   *
   * @param {{
   *   text: string,
   *   language?: string,
   *   providerPreference?: string|null,
   *   metadata?: object,
   * }} params - Request parameters supplied by the caller.
   * @returns {Promise<object>} Summary payload compatible with popup
   *   expectations.
   */
  async generate({
    text,
    language = 'en',
    providerPreference = null,
    metadata = {},
  } = {}) {
    if (!text) {
      throw new Error('generate requires source text.');
    }
    await this.ensureAgentConfigLoaded();
    const routing = this.getRoutingConfig();
    const order = this.getRoutingOrder(providerPreference);
    const failures = [];
    const disablePaid = routing.disablePaid === true;

    for (const providerId of order) {
      if (!providerId) {
        continue;
      }
      const resolved = normaliseProvider(providerId);
      const metadataEntry = this.getProviderMetadata(resolved);
      if (!metadataEntry) {
        continue;
      }
      if (disablePaid && metadataEntry.tier === PROVIDER_TIERS.PAID) {
        this.logger.info('Provider skipped because paid providers are disabled.', { provider: resolved });
        continue;
      }
      if (this.isBlocked(resolved)) {
        this.logger.warn('Provider skipped because circuit breaker is open.', { provider: resolved });
        continue;
      }

      const config = await this.getProviderConfig(resolved);
      const model = config.model || metadataEntry.adapterKey || 'unknown-model';
      const canSpend = await this.ensureTokenBudget(model, text);
      if (!canSpend) {
        this.logger.warn('Provider skipped due to token cap.', { provider: resolved, model });
        failures.push({ provider: resolved, reason: 'token_cap' });
        continue;
      }

      if (routing.dryRun) {
        this.logger.info('Dry run routing selected provider.', { provider: resolved });
        return {
          text: '[dry-run] no request sent',
          tokens_in: 0,
          tokens_out: 0,
          model,
          provider: resolved,
          total_tokens: 0,
          usage_totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cumulative_totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          usageTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cumulativeTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          dryRun: true,
        };
      }

      try {
        const result = await this.invokeProvider(resolved, { text, language, metadata });
        this.logger.info('Provider selected.', { provider: resolved, tier: metadataEntry.tier });
        return {
          text: result.text,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          model: result.model,
          provider: resolved,
          total_tokens: result.totalTokens,
          usage_totals: result.usageTotals || null,
          cumulative_totals: result.cumulativeTotals || null,
          usageTotals: result.usageTotals || null,
          cumulativeTotals: result.cumulativeTotals || null,
        };
      } catch (error) {
        this.markProviderFailure(resolved, error);
        this.logger.warn('Provider invocation failed.', { provider: resolved, error });
        failures.push({ provider: resolved, error });
      }
    }

    if (disablePaid) {
      throw new Error('No free providers available and paid disabled.');
    }

    const errorMessages = failures
      .map(entry => `${entry.provider}: ${entry.reason || entry.error?.message || 'unavailable'}`)
      .join('; ');
    const errors = failures
      .map(entry => entry?.error)
      .filter(error => error instanceof Error);
    const message = `All providers failed. Attempts: ${errorMessages}`;
    if (errors.length > 0) {
      throw new AggregateError(errors, message, { cause: errors[errors.length - 1] });
    }
    throw new Error(message);
  }
}

export { PROVIDER_TIERS };
