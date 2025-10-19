import { createCostTracker, DEFAULT_LIMIT_USD } from '../utils/cost.js';
import { DEFAULT_PROVIDER, fetchApiKeyDetails, readApiKey, saveApiKey } from '../utils/apiKeyStore.js';
import { getValue, setValue, withLock, getSessionValue, setSessionValue, runtime } from '../utils/storage.js';
import { getFallbackProviderConfig, loadProviderConfig } from '../utils/providerConfig.js';
import {
  DEFAULT_PROVIDER_ID,
  getProviderDisplayName,
  normaliseProviderId,
  providerRequiresApiKey,
} from '../utils/providers.js';
import { registerAdapter, createAdapter } from './adapters/registry.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { MistralAdapter } from './adapters/mistral.js';
import { HuggingFaceAdapter } from './adapters/huggingface.js';
import { OllamaAdapter } from './adapters/ollama.js';

registerAdapter('openai', config => new OpenAIAdapter(config));
registerAdapter('anthropic', config => new AnthropicAdapter(config));
registerAdapter('mistral', config => new MistralAdapter(config));
registerAdapter('huggingface', config => new HuggingFaceAdapter(config));
registerAdapter('ollama', config => new OllamaAdapter(config));

const USAGE_STORAGE_KEY = 'comet:usage';
const CACHE_STORAGE_KEY = 'comet:cache';
const PROVIDER_STORAGE_KEY = 'comet:activeProvider';

let costTracker;
let memoryCache = new Map();
let initialised = false;
let providerConfig = getFallbackProviderConfig();
let adapterInstance = null;
let adapterLoadPromise = null;
let loadingProviderId = null;
let activeProviderId = providerConfig.provider || DEFAULT_PROVIDER;

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

async function ensureAdapter(providerId) {
  const requestedProvider = providerId
    ? normaliseProviderId(providerId, DEFAULT_PROVIDER_ID)
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
  const overrideProvider = requestedProvider || storedPreference || null;
  const fallbackProvider = normaliseProviderId(
    providerConfig?.provider || activeProviderId || DEFAULT_PROVIDER_ID,
    DEFAULT_PROVIDER_ID,
  );
  const preferredProvider = overrideProvider
    ? normaliseProviderId(overrideProvider, DEFAULT_PROVIDER_ID)
    : fallbackProvider;

  loadingProviderId = preferredProvider;
  adapterInstance = null;

  adapterLoadPromise = (async () => {
    let config;
    try {
      const loadOptions = overrideProvider ? { provider: preferredProvider } : {};
      config = await loadProviderConfig(loadOptions);
    } catch (error) {
      console.error(
        `Failed to load agent.yaml for provider "${preferredProvider}". Falling back to default.`,
        error,
      );
      config = getFallbackProviderConfig();
    }

    let adapter;
    try {
      const resolvedProvider = normaliseProviderId(config.provider, DEFAULT_PROVIDER_ID);
      adapter = createAdapter(resolvedProvider, config);
    } catch (error) {
      console.error(
        `Adapter for provider "${config.provider}" unavailable. Falling back to default.`,
        error,
      );
      config = getFallbackProviderConfig();
      adapter = createAdapter(config.provider, config);
    }

    providerConfig = config;
    activeProviderId = config.provider || DEFAULT_PROVIDER_ID;
    await setValue(PROVIDER_STORAGE_KEY, activeProviderId);
    return adapter;
  })()
    .catch(error => {
      providerConfig = getFallbackProviderConfig();
      activeProviderId = providerConfig.provider || DEFAULT_PROVIDER_ID;
      console.error('Falling back to default adapter due to unexpected error.', error);
      return createAdapter(activeProviderId, providerConfig);
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
  let limitUsd = DEFAULT_LIMIT_USD;
  let usage;

  if (storedUsage && typeof storedUsage === 'object') {
    const { limitUsd: savedLimit, ...snapshot } = storedUsage;
    if (typeof savedLimit === 'number' && Number.isFinite(savedLimit)) {
      limitUsd = savedLimit;
    }
    usage = Object.keys(snapshot).length > 0 ? snapshot : undefined;
  }

  costTracker = createCostTracker(limitUsd, usage);
  const cachedEntries = (await getSessionValue(CACHE_STORAGE_KEY)) || {};
  memoryCache = new Map(Object.entries(cachedEntries));
  initialised = true;
}

async function setActiveProvider(providerId) {
  const desiredProvider = normaliseProviderId(providerId, activeProviderId || DEFAULT_PROVIDER_ID);
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

async function resolveApiKey(providerId) {
  const activeProvider = await getActiveProviderId(providerId);
  const storedKey = await readApiKey({ provider: activeProvider });
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
  const adapter = await ensureAdapter(provider);
  const costMetadata = getCostMetadata(adapter);
  const summaryMeta = costMetadata.summarise || {};
  const model = summaryMeta.model || providerConfig.model;
  const estimatedCost = costTracker.estimateCostForText(model, segment.text);
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for summaries.');
  }
  const { apiKey, providerId } = await resolveApiKey(provider);
  ensureKeyAvailable(apiKey, providerId);
  const result = await adapter.summarise({
    apiKey,
    text: segment.text,
    url,
    segmentId: segment.id,
    language,
    model,
  });

  const summary = result?.summary || '';
  const promptTokens = typeof result?.promptTokens === 'number'
    ? result.promptTokens
    : costTracker.estimateTokensFromText(segment.text);
  const completionTokens = typeof result?.completionTokens === 'number'
    ? result.completionTokens
    : costTracker.estimateTokensFromText(summary);
  const modelUsed = result?.model || model;

  costTracker.record(modelUsed, promptTokens, completionTokens, {
    url,
    segmentId: segment.id,
    type: 'summary',
  });
  await persistUsage();
  return summary;
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
  const providerId = await getActiveProviderId(provider);
  const cacheKey = getCacheKey({
    url,
    segmentId: segment.id,
    language,
    providerId,
  });
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }
  const summary = await requestSummary({ url, segment, language, provider });
  memoryCache.set(cacheKey, summary);
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

export {
  ensureInitialised,
  getApiKeyDetails,
  getCacheKey,
  handleUsageRequest,
  parseCacheKey,
  setApiKey,
};

ensureInitialised().catch(error => {
  console.error('Failed to initialise service worker', error);
});
