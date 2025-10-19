import createLogger, { loadLoggingConfig, setGlobalContext } from '../utils/logger.js';
import { createCostTracker, DEFAULT_LIMIT_USD } from '../utils/cost.js';
import { ensureNotesFile } from '../utils/notes.js';
import { DEFAULT_PROVIDER, fetchApiKeyDetails, readApiKey, saveApiKey } from '../utils/apiKeyStore.js';
import { getValue, setValue, withLock, getSessionValue, setSessionValue, runtime } from '../utils/storage.js';
import {
  getFallbackProviderConfig,
  loadAgentConfiguration,
  buildProviderConfig,
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_GEMINI_CONFIG,
} from '../utils/providerConfig.js';
import {
  DEFAULT_PROVIDER_ID,
  getProviderDisplayName,
  normaliseProviderId,
  resolveAlias,
  providerRequiresApiKey,
} from '../utils/providers.js';
import { registerAdapter, createAdapter } from './adapters/registry.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { MistralAdapter } from './adapters/mistral.js';
import { HuggingFaceAdapter } from './adapters/huggingface.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { LLMRouter } from './llm/router.js';

const logger = createLogger({ name: 'background-service' });
setGlobalContext({ runtime: 'background-service' });

const adapterLogger = logger.child({ subsystem: 'adapter' });

registerAdapter('openai', config => new OpenAIAdapter(config, { logger: adapterLogger.child({ provider: 'openai' }) }));
registerAdapter('anthropic', config => new AnthropicAdapter(config, { logger: adapterLogger.child({ provider: 'anthropic' }) }));
registerAdapter('mistral', config => new MistralAdapter(config, { logger: adapterLogger.child({ provider: 'mistral' }) }));
registerAdapter('huggingface', config => new HuggingFaceAdapter(config, { logger: adapterLogger.child({ provider: 'huggingface' }) }));
registerAdapter('ollama', config => new OllamaAdapter(config, { logger: adapterLogger.child({ provider: 'ollama' }) }));
registerAdapter('gemini', config => new GeminiAdapter(config, { logger: adapterLogger.child({ provider: 'gemini' }) }));

ensureNotesFile().catch(error => {
  logger.warn('Unable to refresh notes.txt.', { error });
});

const USAGE_STORAGE_KEY = 'comet:usage';
const CACHE_STORAGE_KEY = 'comet:cache';
const PROVIDER_STORAGE_KEY = 'comet:activeProvider';

let preferredProviderId = null;

let costTracker;
let memoryCache = new Map();
let initialised = false;
let providerConfig = getFallbackProviderConfig();
let agentConfigSnapshot = null;
let adapterInstance = null;
let adapterLoadPromise = null;
let loadingProviderId = null;
let activeProviderId = providerConfig.provider || DEFAULT_PROVIDER;
let routingSettings = DEFAULT_ROUTING_CONFIG;
let llmRouter = null;
let loggingConfigured = false;

function createCorrelationId(prefix = 'bg') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

const testAdapterOverrides = new Map();
let testCostTrackerOverride = null;

const PROVIDER_ADAPTER_KEYS = Object.freeze({
  openai_paid: 'openai',
  openai_trial: 'openai',
  gemini_free: 'gemini',
  gemini_paid: 'gemini',
  huggingface_free: 'huggingface',
  mistral_trial: 'mistral',
  mistral_paid: 'mistral',
  anthropic_paid: 'anthropic',
});

function getAdapterKey(providerId) {
  const normalised = normaliseProviderId(providerId, providerId);
  return PROVIDER_ADAPTER_KEYS[normalised] || normalised;
}

function getCacheKey({ url, segmentId, language = 'en', providerId = DEFAULT_PROVIDER_ID }) {
  return JSON.stringify({
    url,
    segmentId,
    language: language || 'en',
    providerId: providerId || DEFAULT_PROVIDER_ID,
  });
}

function parseCacheKey(key) {
  if (typeof key !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(key);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall back to legacy format handling below.
  }

  const legacyParts = key.split('::');
  if (legacyParts.length >= 2) {
    const [url, segmentId] = legacyParts;
    return { url, segmentId, language: 'en', providerId: 'openai' };
  }

  return null;
}

function createFallbackAgentConfig() {
  const fallback = getFallbackProviderConfig();
  return {
    base: { ...fallback },
    providers: {},
    routing: DEFAULT_ROUTING_CONFIG,
    gemini: DEFAULT_GEMINI_CONFIG,
  };
}

async function ensureAgentConfig() {
  logger.debug('Ensuring agent configuration.');
  if (agentConfigSnapshot) {
    logger.debug('Using cached agent configuration.');
    return agentConfigSnapshot;
  }
  try {
    agentConfigSnapshot = await loadAgentConfiguration();
    logger.info('Agent configuration loaded.', {
      providers: Object.keys(agentConfigSnapshot?.providers || {}),
    });
  } catch (error) {
    logger.error('Failed to load agent configuration. Using defaults.', { error });
    agentConfigSnapshot = createFallbackAgentConfig();
  }
  routingSettings = agentConfigSnapshot.routing || DEFAULT_ROUTING_CONFIG;
  return agentConfigSnapshot;
}

async function ensureRouter() {
  await ensureAgentConfig();
  if (!llmRouter) {
    logger.info('Creating LLM router instance.');
    llmRouter = new LLMRouter({
      costTracker,
      agentConfig: agentConfigSnapshot,
      environment: typeof process !== 'undefined' ? process.env : {},
    });
  } else {
    logger.debug('Refreshing existing LLM router configuration.');
    llmRouter.setAgentConfig(agentConfigSnapshot);
    if (costTracker) {
      llmRouter.setCostTracker(costTracker);
    }
  }
  return llmRouter;
}

function updatePreferredProvider(preference) {
  if (typeof preference !== 'string') {
    return;
  }
  const trimmed = preference.trim().toLowerCase();
  if (!trimmed) {
    return;
  }
  preferredProviderId = trimmed;
}

async function ensureAdapter(providerId) {
  const requestedProviderRaw = providerId
    ? normaliseProviderId(providerId, DEFAULT_PROVIDER_ID)
    : null;
  const requestedProvider = requestedProviderRaw === 'auto'
    ? null
    : requestedProviderRaw
      ? resolveAlias(requestedProviderRaw)
      : null;
  logger.debug('Ensuring provider adapter.', {
    requestedProvider: requestedProviderRaw,
    activeProvider: activeProviderId,
    preferredProvider: preferredProviderId,
  });
  if (requestedProviderRaw && requestedProviderRaw !== 'auto') {
    const preferredCandidate = resolveAlias(requestedProviderRaw) || requestedProviderRaw;
    updatePreferredProvider(preferredCandidate);
  }

  if (adapterInstance && (!requestedProvider || activeProviderId === requestedProvider)) {
    logger.debug('Reusing existing adapter instance.', { activeProvider: activeProviderId });
    return adapterInstance;
  }

  if (adapterLoadPromise) {
    logger.debug('Adapter load already in progress.', {
      loadingProvider: loadingProviderId,
      requestedProvider,
    });
    if (loadingProviderId && (!requestedProvider || loadingProviderId === requestedProvider)) {
      return adapterLoadPromise;
    }
    await adapterLoadPromise;
    if (adapterInstance && (!requestedProvider || activeProviderId === requestedProvider)) {
      logger.debug('Adapter instance became available after awaiting existing load.');
      return adapterInstance;
    }
  }

  const storedPreference = await getValue(PROVIDER_STORAGE_KEY);
  if (storedPreference === 'auto') {
    if (!requestedProviderRaw) {
      preferredProviderId = 'auto';
    }
  } else if (typeof storedPreference === 'string' && !requestedProviderRaw) {
    updatePreferredProvider(storedPreference);
  }
  const resolvedPreference =
    preferredProviderId && preferredProviderId !== 'auto'
      ? resolveAlias(preferredProviderId)
      : null;
  const overrideProvider = requestedProvider || resolvedPreference;
  await ensureAgentConfig();
  const baseFallbackProvider = providerConfig?.provider || activeProviderId || DEFAULT_PROVIDER_ID;
  const baseAlias = resolveAlias(baseFallbackProvider);
  if (!preferredProviderId && !storedPreference && !providerId) {
    const matchesDefault =
      baseFallbackProvider === DEFAULT_PROVIDER
      || baseFallbackProvider === DEFAULT_PROVIDER_ID
      || baseAlias === DEFAULT_PROVIDER
      || baseAlias === DEFAULT_PROVIDER_ID;
    if (matchesDefault) {
      preferredProviderId = DEFAULT_PROVIDER_ID;
    }
  }
  const fallbackProvider = baseFallbackProvider === 'auto'
    ? DEFAULT_PROVIDER_ID
    : resolveAlias(baseFallbackProvider);
  const preferredProvider = overrideProvider || fallbackProvider;
  logger.info('Loading adapter.', {
    preferredProvider,
    fallbackProvider,
  });

  if (testAdapterOverrides.has(preferredProvider)) {
    adapterInstance = testAdapterOverrides.get(preferredProvider);
    activeProviderId = preferredProvider;
    providerConfig = getFallbackProviderConfig({ provider: preferredProvider });
    return adapterInstance;
  }

  loadingProviderId = preferredProvider;
  adapterInstance = null;

  adapterLoadPromise = (async () => {
    let config;
    try {
      config = buildProviderConfig(agentConfigSnapshot, preferredProvider);
    } catch (error) {
      logger.error(`Failed to resolve configuration for provider "${preferredProvider}". Falling back to default.`, {
        error,
      });
      config = getFallbackProviderConfig({ provider: preferredProvider });
    }

    let adapter;
    try {
      const adapterKey = getAdapterKey(config.provider);
      adapter = createAdapter(adapterKey, config);
    } catch (error) {
      logger.error(`Adapter for provider "${config.provider}" unavailable. Falling back to default.`, {
        error,
      });
      config = getFallbackProviderConfig();
      const fallbackAdapterKey = getAdapterKey(config.provider);
      if (preferredProviderId === DEFAULT_PROVIDER_ID) {
        const fallbackPreference = resolveAlias(config.provider) || config.provider;
        updatePreferredProvider(fallbackPreference);
      }
      adapter = createAdapter(fallbackAdapterKey, config);
    }

    providerConfig = config;
    activeProviderId = config.provider || DEFAULT_PROVIDER_ID;
    if (!preferredProviderId || preferredProviderId === 'auto') {
      await setValue(PROVIDER_STORAGE_KEY, preferredProviderId || activeProviderId);
    }
    if (llmRouter) {
      llmRouter.setAgentConfig(agentConfigSnapshot);
    }
    logger.info('Adapter initialised.', { activeProvider: activeProviderId });
    return adapter;
  })()
    .catch(error => {
      providerConfig = getFallbackProviderConfig();
      activeProviderId = providerConfig.provider || DEFAULT_PROVIDER_ID;
      logger.error('Falling back to default adapter due to unexpected error.', { error });
      const fallbackAdapterKey = getAdapterKey(activeProviderId);
      return createAdapter(fallbackAdapterKey, providerConfig);
    })
    .finally(() => {
      adapterLoadPromise = null;
      loadingProviderId = null;
      logger.debug('Adapter load complete.');
    });

  adapterInstance = await adapterLoadPromise;
  return adapterInstance;
}

async function getActiveProviderId(providerId) {
  await ensureAdapter(providerId);
  return activeProviderId || DEFAULT_PROVIDER;
}

async function ensureInitialised(providerId) {
  const previousProvider = activeProviderId;
  if (!loggingConfigured) {
    await loadLoggingConfig().catch(() => {});
    loggingConfigured = true;
    logger.debug('Logging configuration applied in background service worker.');
  }
  await ensureAgentConfig();
  await ensureAdapter(providerId);
  const providerChanged = previousProvider && previousProvider !== activeProviderId;

  if (initialised) {
    if (providerChanged) {
      logger.info('Provider changed; clearing summary cache.', {
        previousProvider,
        activeProvider: activeProviderId,
      });
      memoryCache.clear();
      await persistCache();
    }
    return;
  }

  const storedUsage = await getValue(USAGE_STORAGE_KEY);
  const configuredLimit = typeof routingSettings?.maxMonthlyCostUsd === 'number'
    ? routingSettings.maxMonthlyCostUsd
    : DEFAULT_LIMIT_USD;
  let limitUsd = configuredLimit;
  let usage;

  if (storedUsage && typeof storedUsage === 'object') {
    const { limitUsd: savedLimit, ...snapshot } = storedUsage;
    if (typeof savedLimit === 'number' && Number.isFinite(savedLimit)) {
      limitUsd = Math.min(configuredLimit, savedLimit);
    }
    usage = Object.keys(snapshot).length > 0 ? snapshot : undefined;
  }

  costTracker = createCostTracker(limitUsd, usage);
  if (testCostTrackerOverride) {
    costTracker = testCostTrackerOverride;
  }
  if (llmRouter) {
    llmRouter.setCostTracker(costTracker);
  }
  const cachedEntries = (await getSessionValue(CACHE_STORAGE_KEY)) || {};
  memoryCache = new Map(Object.entries(cachedEntries));
  logger.info('Initialising background state.', {
    limitUsd,
    cachedEntries: memoryCache.size,
  });
  await ensureRouter();
  initialised = true;
  logger.info('Background service worker initialised.');
}

async function setActiveProvider(providerId) {
  const normalised = normaliseProviderId(providerId, preferredProviderId || activeProviderId || DEFAULT_PROVIDER_ID);
  updatePreferredProvider(normalised);
  await setValue(PROVIDER_STORAGE_KEY, preferredProviderId);
  const desiredProvider = normalised === 'auto'
    ? DEFAULT_PROVIDER_ID
    : resolveAlias(normalised);
  const previousProvider = activeProviderId;
  logger.info('Setting active provider.', {
    requested: providerId,
    normalised,
    desiredProvider,
  });
  await ensureAdapter(desiredProvider);
  if (previousProvider && previousProvider !== activeProviderId) {
    logger.info('Active provider changed; resetting cache.', {
      previousProvider,
      activeProvider: activeProviderId,
    });
    memoryCache.clear();
    await persistCache();
  }
  return {
    provider: activeProviderId,
    requiresApiKey: providerRequiresApiKey(activeProviderId),
  };
}

async function persistUsage() {
  logger.debug('Persisting usage snapshot.');
  await withLock(USAGE_STORAGE_KEY, async () => {
    await setValue(USAGE_STORAGE_KEY, costTracker.toJSON());
  });
}

async function persistCache() {
  const entries = Object.fromEntries(memoryCache.entries());
  logger.debug('Persisting cache snapshot.', { entryCount: Object.keys(entries).length });
  await setSessionValue(CACHE_STORAGE_KEY, entries);
}

async function readStoredApiKey(providerId) {
  const direct = await readApiKey({ provider: providerId });
  if (direct) {
    return direct;
  }
  if (providerId.endsWith('_paid') || providerId.endsWith('_trial')) {
    const legacy = providerId.replace(/_(paid|trial)$/, '');
    const legacyKey = await readApiKey({ provider: legacy });
    if (legacyKey) {
      return legacyKey;
    }
  }
  if (providerId === 'gemini_free' || providerId === 'gemini_paid') {
    const geminiKey = await readApiKey({ provider: 'gemini' });
    if (geminiKey) {
      return geminiKey;
    }
  }
  if (providerId === 'huggingface_free') {
    const huggingfaceKey = await readApiKey({ provider: 'huggingface' });
    if (huggingfaceKey) {
      return huggingfaceKey;
    }
  }
  return null;
}

async function resolveApiKey(providerId) {
  const activeProvider = await getActiveProviderId(providerId);
  const storedKey = await readStoredApiKey(activeProvider);
  if (storedKey) {
    return { apiKey: storedKey, providerId: activeProvider };
  }
  const envVar = providerConfig?.apiKeyEnvVar;
  if (envVar && typeof process !== 'undefined' && process.env && process.env[envVar]) {
    return { apiKey: process.env[envVar], providerId: activeProvider };
  }
  return { apiKey: null, providerId: activeProvider };
}

async function getApiKey(options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  logger.debug('Retrieving API key.', { providerId });
  return readApiKey({ provider: providerId });
}

async function setApiKey(apiKey, options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  logger.info('Saving API key.', {
    providerId,
    provided: Boolean(apiKey),
  });
  return saveApiKey(apiKey, { provider: providerId });
}

async function getApiKeyDetails(options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  const details = await fetchApiKeyDetails({ provider: providerId });
  const requestedProvider = preferredProviderId
    ? preferredProviderId
    : options?.provider
      ? normaliseProviderId(options.provider, providerId)
      : providerId;
  logger.debug('Returning API key details.', { providerId, requestedProvider });
  return { ...details, provider: providerId, requestedProvider };
}

function ensureKeyAvailable(apiKey, providerId) {
  const effectiveProvider = providerId || providerConfig?.provider;
  if (!providerRequiresApiKey(effectiveProvider)) {
    return;
  }
  if (!apiKey) {
    const displayName = getProviderDisplayName(effectiveProvider) || 'Provider';
    throw new Error(`Missing ${displayName} API key.`);
  }
}

function resolveFlatCost(metadata, fallback) {
  const flatCost = metadata && typeof metadata.flatCost === 'number'
    ? metadata.flatCost
    : Number.NaN;
  if (Number.isFinite(flatCost) && flatCost >= 0) {
    return flatCost;
  }
  return fallback;
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function getCostMetadata(adapter) {
  if (!adapter || typeof adapter.getCostMetadata !== 'function') {
    return {};
  }
  return adapter.getCostMetadata() || {};
}

async function requestSummary({ url, segment, language, provider }) {
  const router = await ensureRouter();
  logger.debug('Requesting summary from router.', {
    url,
    segmentId: segment.id,
    language,
    provider,
  });
  const result = await router.generate({
    text: segment.text,
    language,
    providerPreference: provider,
    metadata: { url, segmentId: segment.id, type: 'summary' },
  });
  await persistUsage();
  logger.debug('Summary generated.', {
    provider: result?.provider,
    model: result?.model,
  });
  return result;
}

async function transcribeAudio({ base64, filename = 'speech.webm', mimeType = 'audio/webm', provider }) {
  logger.info('Transcription request received.', {
    filename,
    mimeType,
    provider,
  });
  const adapter = await ensureAdapter(provider);
  const costMetadata = getCostMetadata(adapter);
  const transcribeMeta = costMetadata.transcribe || {};
  const estimatedCost = resolveFlatCost(transcribeMeta, 0.005);
  if (!costTracker.canSpend(estimatedCost)) {
    logger.warn('Transcription aborted due to cost limit.', { estimatedCost });
    throw new Error('Cost limit reached for transcription.');
  }
  const { apiKey, providerId } = await resolveApiKey(provider);
  ensureKeyAvailable(apiKey, providerId);
  const result = await adapter.transcribe({
    apiKey,
    base64,
    filename,
    mimeType,
    model: transcribeMeta.model,
  });

  costTracker.recordFlat(transcribeMeta.label || 'stt', estimatedCost, { type: transcribeMeta.label || 'stt' });
  await persistUsage();
  logger.info('Transcription completed.', { provider: providerId, model: transcribeMeta.model });
  return result.text;
}

async function synthesiseSpeech({ text, voice = 'alloy', format = 'mp3', provider }) {
  logger.info('Speech synthesis request received.', {
    voice,
    format,
    provider,
  });
  const adapter = await ensureAdapter(provider);
  const costMetadata = getCostMetadata(adapter);
  const synthMeta = costMetadata.synthesise || {};
  const estimatedCost = resolveFlatCost(synthMeta, 0.01);
  if (!costTracker.canSpend(estimatedCost)) {
    logger.warn('Speech synthesis aborted due to cost limit.', { estimatedCost });
    throw new Error('Cost limit reached for speech synthesis.');
  }
  const { apiKey, providerId } = await resolveApiKey(provider);
  ensureKeyAvailable(apiKey, providerId);
  const result = await adapter.synthesise({
    apiKey,
    text,
    voice,
    format,
    model: synthMeta.model,
  });

  costTracker.recordFlat(synthMeta.label || 'tts', estimatedCost, { type: synthMeta.label || 'tts' });
  await persistUsage();
  logger.info('Speech synthesis completed.', {
    provider: providerId,
    model: synthMeta.model,
  });
  return {
    base64: toBase64(result.arrayBuffer),
    mimeType: result.mimeType || `audio/${format}`,
  };
}

async function getSummary({ url, segment, language, provider }) {
  const providerId = await getActiveProviderId(provider);
  const cacheKey = getCacheKey({
    url,
    segmentId: segment.id,
    language,
    providerId,
  });
  if (memoryCache.has(cacheKey)) {
    const cached = memoryCache.get(cacheKey);
    if (typeof cached === 'string') {
      logger.debug('Summary cache hit (string).', { segmentId: segment.id });
      return cached;
    }
    if (cached && typeof cached === 'object' && typeof cached.summary === 'string') {
      logger.debug('Summary cache hit.', { segmentId: segment.id });
      return cached.summary;
    }
  }
  logger.debug('Summary cache miss.', { segmentId: segment.id });
  const result = await requestSummary({ url, segment, language, provider });
  const summary = typeof result?.text === 'string' ? result.text : '';
  memoryCache.set(cacheKey, {
    summary,
    provider: result?.provider,
    model: result?.model,
    cost: result?.cost_estimate,
  });
  await persistCache();
  return summary;
}

async function handleSummariseRequest(message) {
  const { url, segments, language = 'en', provider } = message.payload;
  logger.info('Handling summarise request.', {
    url,
    segmentCount: segments?.length,
    language,
    provider,
  });
  await ensureInitialised(provider);
  const summaries = [];
  for (const segment of segments) {
    const summary = await getSummary({ url, segment, language, provider });
    summaries.push({ id: segment.id, summary });
  }
  logger.info('Summarise request completed.', { count: summaries.length });
  return { summaries, usage: costTracker.toJSON() };
}

async function handleTranscriptionRequest(message) {
  logger.info('Handling transcription request.', {
    provider: message.payload?.provider,
    mimeType: message.payload?.mimeType,
  });
  await ensureInitialised(message.payload?.provider);
  const result = await transcribeAudio(message.payload);
  return { text: result, usage: costTracker.toJSON() };
}

async function handleSpeechRequest(message) {
  logger.info('Handling speech synthesis request.', {
    provider: message.payload?.provider,
    voice: message.payload?.voice,
  });
  await ensureInitialised(message.payload?.provider);
  const result = await synthesiseSpeech(message.payload);
  return { audio: result, usage: costTracker.toJSON() };
}

async function handleUsageRequest() {
  logger.debug('Handling usage request.');
  await ensureInitialised();
  return costTracker.toJSON();
}

async function handleResetUsage() {
  logger.info('Handling usage reset request.');
  await ensureInitialised();
  costTracker.reset();
  await persistUsage();
  return costTracker.toJSON();
}

async function handleSegmentsUpdated(message) {
  const { url, segments } = message.payload;
  logger.debug('Handling segments updated event.', {
    url,
    segmentCount: segments?.length,
  });
  const validSegmentIds = new Set((segments || []).map(segment => segment.id));

  for (const key of memoryCache.keys()) {
    const entry = parseCacheKey(key);
    if (!entry || entry.url !== url) {
      continue;
    }

    if (!validSegmentIds.has(entry.segmentId)) {
      memoryCache.delete(key);
    }
  }
  await persistCache();
  return true;
}

const handlers = {
  'comet:setApiKey': ({ payload }) => setApiKey(payload.apiKey, { provider: payload?.provider }),
  'comet:getApiKey': ({ payload }) => getApiKey({ provider: payload?.provider }),
  'comet:getApiKeyDetails': ({ payload }) => getApiKeyDetails({ provider: payload?.provider }),
  'comet:setProvider': ({ payload }) => setActiveProvider(payload?.provider),
  'comet:summarise': handleSummariseRequest,
  'comet:transcribe': handleTranscriptionRequest,
  'comet:synthesise': handleSpeechRequest,
  'comet:getUsage': handleUsageRequest,
  'comet:resetUsage': handleResetUsage,
  'comet:segmentsUpdated': handleSegmentsUpdated,
};

runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type || !handlers[message.type]) {
    logger.warn('Received unsupported message.', { messageType: message?.type });
    return false;
  }

  const correlationId = createCorrelationId('bg-handler');
  logger.debug('Received background message.', {
    type: message.type,
    correlationId,
  });
  const handler = handlers[message.type];
  Promise.resolve(handler(message, sender))
    .then(result => {
      logger.debug('Background message handled successfully.', {
        type: message.type,
        correlationId,
      });
      sendResponse({ ok: true, result });
    })
    .catch(error => {
      logger.error('Background message handler failed.', {
        type: message.type,
        correlationId,
        error,
      });
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

function __setTestAdapterOverride(providerId, adapter) {
  if (typeof providerId !== 'string') {
    throw new Error('providerId must be a string');
  }
  testAdapterOverrides.set(providerId, adapter);
  if (activeProviderId === providerId) {
    adapterInstance = adapter;
  }
}

function __setTestCostTrackerOverride(tracker) {
  testCostTrackerOverride = tracker;
  if (tracker) {
    costTracker = tracker;
  }
}

function __clearTestOverrides() {
  testAdapterOverrides.clear();
  testCostTrackerOverride = null;
  adapterInstance = null;
  adapterLoadPromise = null;
  loadingProviderId = null;
  costTracker = undefined;
  memoryCache = new Map();
  initialised = false;
  providerConfig = getFallbackProviderConfig();
  agentConfigSnapshot = null;
  preferredProviderId = null;
  routingSettings = DEFAULT_ROUTING_CONFIG;
  llmRouter = null;
}

async function __transcribeForTests(payload) {
  return transcribeAudio(payload);
}

export {
  ensureInitialised,
  getApiKeyDetails,
  handleUsageRequest,
  setActiveProvider,
  setApiKey,
  __clearTestOverrides,
  __setTestAdapterOverride,
  __setTestCostTrackerOverride,
  __transcribeForTests,
};

ensureInitialised().catch(error => {
  logger.error('Failed to initialise service worker.', { error });
});
