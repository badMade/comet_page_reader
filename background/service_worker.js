import { createCostTracker, DEFAULT_LIMIT_USD } from '../utils/cost.js';
import { fetchApiKeyDetails, readApiKey, saveApiKey } from '../utils/apiKeyStore.js';
import { getValue, setValue, withLock, getSessionValue, setSessionValue, runtime } from '../utils/storage.js';
import { getFallbackProviderConfig, loadProviderConfig } from '../utils/providerConfig.js';
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

let costTracker;
let memoryCache = new Map();
let initialised = false;
let providerConfig = getFallbackProviderConfig();
let adapterInstance = null;
let adapterLoadPromise = null;

function capitalise(value) {
  if (!value) {
    return '';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getCacheKey(url, segmentId) {
  return `${url}::${segmentId}`;
}

async function ensureAdapter() {
  if (adapterInstance) {
    return adapterInstance;
  }
  if (!adapterLoadPromise) {
    adapterLoadPromise = (async () => {
      let config;
      try {
        config = await loadProviderConfig();
      } catch (error) {
        console.error('Failed to load agent.yaml, defaulting to OpenAI', error);
        config = getFallbackProviderConfig();
      }

      let adapter;
      try {
        adapter = createAdapter(config.provider, config);
      } catch (error) {
        console.error(`Adapter for provider \"${config.provider}\" unavailable. Falling back to OpenAI.`, error);
        config = getFallbackProviderConfig();
        adapter = createAdapter(config.provider, config);
      }

      providerConfig = config;
      return adapter;
    })()
      .catch(error => {
        providerConfig = getFallbackProviderConfig();
        console.error('Falling back to default adapter due to unexpected error.', error);
        return createAdapter(providerConfig.provider, providerConfig);
      })
      .finally(() => {
        adapterLoadPromise = null;
      });
  }

  adapterInstance = await adapterLoadPromise;
  return adapterInstance;
}

async function ensureInitialised() {
  if (initialised) {
    return;
  }
  await ensureAdapter();
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

async function persistUsage() {
  await withLock(USAGE_STORAGE_KEY, async () => {
    await setValue(USAGE_STORAGE_KEY, costTracker.toJSON());
  });
}

async function persistCache() {
  const entries = Object.fromEntries(memoryCache.entries());
  await setSessionValue(CACHE_STORAGE_KEY, entries);
}

async function resolveApiKey() {
  const storedKey = await readApiKey();
  if (storedKey) {
    return storedKey;
  }
  await ensureAdapter();
  const envVar = providerConfig?.apiKeyEnvVar;
  if (envVar && typeof process !== 'undefined' && process.env && process.env[envVar]) {
    return process.env[envVar];
  }
  return null;
}

async function getApiKey() {
  return readApiKey();
}

async function setApiKey(apiKey) {
  return saveApiKey(apiKey);
}

async function getApiKeyDetails() {
  return fetchApiKeyDetails();
}

function ensureKeyAvailable(apiKey) {
  if (!apiKey) {
    const providerName = capitalise(providerConfig?.provider || '');
    const displayName = providerName || 'Provider';
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

async function requestSummary({ url, segment, language }) {
  const adapter = await ensureAdapter();
  const costMetadata = getCostMetadata(adapter);
  const summaryMeta = costMetadata.summarise || {};
  const model = summaryMeta.model || providerConfig.model;
  const estimatedCost = costTracker.estimateCostForText(model, segment.text);
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for summaries.');
  }
  const apiKey = await resolveApiKey();
  ensureKeyAvailable(apiKey);
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

async function transcribeAudio({ base64, filename = 'speech.webm', mimeType = 'audio/webm' }) {
  const adapter = await ensureAdapter();
  const costMetadata = getCostMetadata(adapter);
  const transcribeMeta = costMetadata.transcribe || {};
  const estimatedCost = typeof transcribeMeta.flatCost === 'number' && transcribeMeta.flatCost > 0
    ? transcribeMeta.flatCost
    : 0.005;
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for transcription.');
  }
  const apiKey = await resolveApiKey();
  ensureKeyAvailable(apiKey);
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

async function synthesiseSpeech({ text, voice = 'alloy', format = 'mp3' }) {
  const adapter = await ensureAdapter();
  const costMetadata = getCostMetadata(adapter);
  const synthMeta = costMetadata.synthesise || {};
  const estimatedCost = typeof synthMeta.flatCost === 'number' && synthMeta.flatCost > 0
    ? synthMeta.flatCost
    : 0.01;
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for speech synthesis.');
  }
  const apiKey = await resolveApiKey();
  ensureKeyAvailable(apiKey);
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

async function getSummary({ url, segment, language }) {
  const cacheKey = getCacheKey(url, segment.id);
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }
  const summary = await requestSummary({ url, segment, language });
  memoryCache.set(cacheKey, summary);
  await persistCache();
  return summary;
}

async function handleSummariseRequest(message) {
  const { url, segments, language = 'en' } = message.payload;
  await ensureInitialised();
  const summaries = [];
  for (const segment of segments) {
    const summary = await getSummary({ url, segment, language });
    summaries.push({ id: segment.id, summary });
  }
  return { summaries, usage: costTracker.toJSON() };
}

async function handleTranscriptionRequest(message) {
  await ensureInitialised();
  const result = await transcribeAudio(message.payload);
  return { text: result, usage: costTracker.toJSON() };
}

async function handleSpeechRequest(message) {
  await ensureInitialised();
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
  memoryCache.forEach((value, key) => {
    if (key.startsWith(`${url}::`)) {
      const exists = segments.some(segment => getCacheKey(url, segment.id) === key);
      if (!exists) {
        memoryCache.delete(key);
      }
    }
  });
  await persistCache();
  return true;
}

const handlers = {
  'comet:setApiKey': ({ payload }) => setApiKey(payload.apiKey),
  'comet:getApiKey': () => getApiKey(),
  'comet:getApiKeyDetails': () => getApiKeyDetails(),
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
