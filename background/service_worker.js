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

registerAdapter('openai', config => new OpenAIAdapter(config));
registerAdapter('anthropic', config => new AnthropicAdapter(config));
registerAdapter('mistral', config => new MistralAdapter(config));
registerAdapter('huggingface', config => new HuggingFaceAdapter(config));
registerAdapter('ollama', config => new OllamaAdapter(config));
registerAdapter('gemini', config => new GeminiAdapter(config));

ensureNotesFile().catch(error => {
  console.warn('Comet Page Reader: unable to refresh notes.txt', error);
});

const USAGE_STORAGE_KEY = 'comet:usage';
const CACHE_STORAGE_KEY = 'comet:cache';
const PROVIDER_STORAGE_KEY = 'comet:activeProvider';

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
    return { url, segmentId };
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
  if (agentConfigSnapshot) {
    return agentConfigSnapshot;
  }
  try {
    agentConfigSnapshot = await loadAgentConfiguration();
  } catch (error) {
    console.error('Failed to load agent configuration. Using defaults.', error);
    agentConfigSnapshot = createFallbackAgentConfig();
  }
  routingSettings = agentConfigSnapshot.routing || DEFAULT_ROUTING_CONFIG;
  return agentConfigSnapshot;
}

async function ensureRouter() {
  await ensureAgentConfig();
  if (!llmRouter) {
    llmRouter = new LLMRouter({
      costTracker,
      agentConfig: agentConfigSnapshot,
      environment: typeof process !== 'undefined' ? process.env : {},
    });
  } else {
    llmRouter.setAgentConfig(agentConfigSnapshot);
    if (costTracker) {
      llmRouter.setCostTracker(costTracker);
    }
  }
  return llmRouter;
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

  if (adapterInstance && (!requestedProvider || activeProviderId === requestedProvider)) {
    return adapterInstance;
  }

  if (adapterLoadPromise) {
    if (loadingProviderId && (!requestedProvider || loadingProviderId === requestedProvider)) {
      return adapterLoadPromise;
    }
    await adapterLoadPromise;
    if (adapterInstance && (!requestedProvider || activeProviderId === requestedProvider)) {
      return adapterInstance;
    }
  }

  const storedPreference = await getValue(PROVIDER_STORAGE_KEY);
  const resolvedPreference = storedPreference === 'auto' ? null : storedPreference;
  const overrideProvider = requestedProvider || (resolvedPreference ? resolveAlias(resolvedPreference) : null);
  await ensureAgentConfig();
  const baseFallbackProvider = providerConfig?.provider || activeProviderId || DEFAULT_PROVIDER_ID;
  const fallbackProvider = baseFallbackProvider === 'auto'
    ? DEFAULT_PROVIDER_ID
    : resolveAlias(baseFallbackProvider);
  const preferredProvider = overrideProvider || fallbackProvider;

  loadingProviderId = preferredProvider;
  adapterInstance = null;

  adapterLoadPromise = (async () => {
    let config;
    try {
      config = buildProviderConfig(agentConfigSnapshot, preferredProvider);
    } catch (error) {
      console.error(
        `Failed to resolve configuration for provider "${preferredProvider}". Falling back to default.`,
        error,
      );
      config = getFallbackProviderConfig({ provider: preferredProvider });
    }

    let adapter;
    try {
      const adapterKey = getAdapterKey(config.provider);
      adapter = createAdapter(adapterKey, config);
    } catch (error) {
      console.error(
        `Adapter for provider "${config.provider}" unavailable. Falling back to default.`,
        error,
      );
      config = getFallbackProviderConfig();
      const fallbackAdapterKey = getAdapterKey(config.provider);
      adapter = createAdapter(fallbackAdapterKey, config);
    }

    providerConfig = config;
    activeProviderId = config.provider || DEFAULT_PROVIDER_ID;
    await setValue(PROVIDER_STORAGE_KEY, activeProviderId);
    if (llmRouter) {
      llmRouter.setAgentConfig(agentConfigSnapshot);
    }
    return adapter;
  })()
    .catch(error => {
      providerConfig = getFallbackProviderConfig();
      activeProviderId = providerConfig.provider || DEFAULT_PROVIDER_ID;
      console.error('Falling back to default adapter due to unexpected error.', error);
      const fallbackAdapterKey = getAdapterKey(activeProviderId);
      return createAdapter(fallbackAdapterKey, providerConfig);
    })
    .finally(() => {
      adapterLoadPromise = null;
      loadingProviderId = null;
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
  await ensureAgentConfig();
  await ensureAdapter(providerId);
  const providerChanged = previousProvider && previousProvider !== activeProviderId;

  if (initialised) {
    if (providerChanged) {
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
  if (llmRouter) {
    llmRouter.setCostTracker(costTracker);
  }
  const cachedEntries = (await getSessionValue(CACHE_STORAGE_KEY)) || {};
  memoryCache = new Map(Object.entries(cachedEntries));
  await ensureRouter();
  initialised = true;
}

async function setActiveProvider(providerId) {
  const normalised = normaliseProviderId(providerId, activeProviderId || DEFAULT_PROVIDER_ID);
  const desiredProvider = normalised === 'auto'
    ? DEFAULT_PROVIDER_ID
    : resolveAlias(normalised);
  const previousProvider = activeProviderId;
  await ensureAdapter(desiredProvider);
  if (previousProvider && previousProvider !== activeProviderId) {
    memoryCache.clear();
    await persistCache();
  }
  return {
    provider: activeProviderId,
    requiresApiKey: providerRequiresApiKey(activeProviderId),
  };
}

async function persistUsage() {
  await withLock(USAGE_STORAGE_KEY, async () => {
    await setValue(USAGE_STORAGE_KEY, costTracker.toJSON());
  });
}

async function persistCache() {
  const entries = Object.fromEntries(memoryCache.entries());
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
  return readApiKey({ provider: providerId });
}

async function setApiKey(apiKey, options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  return saveApiKey(apiKey, { provider: providerId });
}

async function getApiKeyDetails(options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  return fetchApiKeyDetails({ provider: providerId });
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
  const result = await router.generate({
    text: segment.text,
    language,
    providerPreference: provider,
    metadata: { url, segmentId: segment.id, type: 'summary' },
  });
  await persistUsage();
  return result;
}

async function transcribeAudio({ base64, filename = 'speech.webm', mimeType = 'audio/webm', provider }) {
  const adapter = await ensureAdapter(provider);
  const costMetadata = getCostMetadata(adapter);
  const transcribeMeta = costMetadata.transcribe || {};
  const estimatedCost = typeof transcribeMeta.flatCost === 'number' && transcribeMeta.flatCost > 0
    ? transcribeMeta.flatCost
    : 0.005;
  if (!costTracker.canSpend(estimatedCost)) {
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
  return result.text;
}

async function synthesiseSpeech({ text, voice = 'alloy', format = 'mp3', provider }) {
  const adapter = await ensureAdapter(provider);
  const costMetadata = getCostMetadata(adapter);
  const synthMeta = costMetadata.synthesise || {};
  const estimatedCost = typeof synthMeta.flatCost === 'number' && synthMeta.flatCost > 0
    ? synthMeta.flatCost
    : 0.01;
  if (!costTracker.canSpend(estimatedCost)) {
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
  return {
    base64: toBase64(result.arrayBuffer),
    mimeType: result.mimeType || `audio/${format}`,
  };
}

async function getSummary({ url, segment, language, provider }) {
  const router = await ensureRouter();
  const normaliseForCache = value => {
    if (!value) {
      return null;
    }
    const resolved = resolveAlias(value);
    const normalised = normaliseProviderId(resolved, resolved);
    return normalised === 'auto' ? null : normalised;
  };

  const candidateProviders = [];
  const seenCandidates = new Set();
  const addCandidate = value => {
    const normalised = normaliseForCache(value);
    if (!normalised || seenCandidates.has(normalised)) {
      return;
    }
    seenCandidates.add(normalised);
    candidateProviders.push(normalised);
  };

  if (router && typeof router.getRoutingOrder === 'function') {
    try {
      const order = router.getRoutingOrder(provider) || [];
      order.forEach(addCandidate);
    } catch (error) {
      console.warn('Failed to derive routing order for cache lookup.', error);
    }
  }

  const activeProviderRaw = await getActiveProviderId(provider);
  addCandidate(activeProviderRaw);

  const baseKeyArgs = {
    url,
    segmentId: segment?.id,
    language,
  };

  const checkedKeys = new Set();
  for (const candidate of candidateProviders) {
    const cacheKey = getCacheKey({ ...baseKeyArgs, providerId: candidate });
    if (checkedKeys.has(cacheKey)) {
      continue;
    }
    checkedKeys.add(cacheKey);
    const cached = memoryCache.get(cacheKey);
    if (!cached) {
      continue;
    }
    if (typeof cached === 'string') {
      return cached;
    }
    if (cached && typeof cached === 'object') {
      const cachedProvider = normaliseForCache(cached.provider) || candidate;
      if (cachedProvider && cachedProvider !== candidate) {
        memoryCache.delete(cacheKey);
        continue;
      }
      if (typeof cached.summary === 'string') {
        return cached.summary;
      }
    }
  }

  for (const [key, cached] of memoryCache.entries()) {
    if (checkedKeys.has(key)) {
      continue;
    }
    const parsed = parseCacheKey(key);
    if (!parsed) {
      continue;
    }
    const sameUrl = parsed.url === url;
    const sameSegment = parsed.segmentId === segment?.id;
    const sameLanguage = (parsed.language || 'en') === (language || 'en');
    if (!sameUrl || !sameSegment || !sameLanguage) {
      continue;
    }
    if (typeof cached === 'string') {
      return cached;
    }
    if (cached && typeof cached === 'object' && typeof cached.summary === 'string') {
      return cached.summary;
    }
  }

  const result = await requestSummary({ url, segment, language, provider });
  const summary = typeof result?.text === 'string' ? result.text : '';
  const routedProvider = normaliseForCache(result?.provider);
  const activeProvider = normaliseForCache(activeProviderRaw);
  const targetProvider = routedProvider || activeProvider || candidateProviders[0] || DEFAULT_PROVIDER_ID;
  const cacheKey = getCacheKey({ ...baseKeyArgs, providerId: targetProvider });

  if (activeProvider && targetProvider !== activeProvider) {
    const staleKey = getCacheKey({ ...baseKeyArgs, providerId: activeProvider });
    if (staleKey !== cacheKey) {
      memoryCache.delete(staleKey);
    }
  }

  memoryCache.set(cacheKey, {
    summary,
    provider: targetProvider,
    model: result?.model,
    cost: result?.cost_estimate,
  });
  await persistCache();
  return summary;
}

async function handleSummariseRequest(message) {
  const { url, segments, language = 'en', provider } = message.payload;
  await ensureInitialised(provider);
  const summaries = [];
  for (const segment of segments) {
    const summary = await getSummary({ url, segment, language, provider });
    summaries.push({ id: segment.id, summary });
  }
  return { summaries, usage: costTracker.toJSON() };
}

async function handleTranscriptionRequest(message) {
  await ensureInitialised(message.payload?.provider);
  const result = await transcribeAudio(message.payload);
  return { text: result, usage: costTracker.toJSON() };
}

async function handleSpeechRequest(message) {
  await ensureInitialised(message.payload?.provider);
  const result = await synthesiseSpeech(message.payload);
  return { audio: result, usage: costTracker.toJSON() };
}

async function handleUsageRequest() {
  await ensureInitialised();
  return costTracker.toJSON();
}

async function handleResetUsage() {
  await ensureInitialised();
  costTracker.reset();
  await persistUsage();
  return costTracker.toJSON();
}

async function handleSegmentsUpdated(message) {
  const { url, segments } = message.payload;
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
    return false;
  }

  const handler = handlers[message.type];
  Promise.resolve(handler(message, sender))
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => {
      console.error('Comet background error', error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

export { ensureInitialised, getApiKeyDetails, handleUsageRequest, setApiKey };

ensureInitialised().catch(error => {
  console.error('Failed to initialise service worker', error);
});
