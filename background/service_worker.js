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
import { ttsAdapters } from './tts/registry.js';
import { createLocalTtsAdapter } from './tts/local.js';
import { LLMRouter } from './llm/router.js';

const logger = createLogger({ name: 'background-service' });
setGlobalContext({ runtime: 'background-service' });

const adapterLogger = logger.child({ subsystem: 'adapter' });

ttsAdapters.register('local', createLocalTtsAdapter({ logger: adapterLogger.child({ provider: 'local-tts' }) }));
ttsAdapters.register('auto', createCloudTtsAdapter('auto'));

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

async function ensureLoggingConfiguredOnce() {
  if (loggingConfigured) {
    return;
  }
  await loadLoggingConfig().catch(() => {});
  loggingConfigured = true;
  logger.debug('Logging configuration applied in background service worker.');
}

function applyProviderLoggingContext(providerId) {
  if (!providerId) {
    return;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  const resolved = resolveAlias(normalised);
  const label = getProviderDisplayName(resolved);
  setGlobalContext({
    aiProviderId: resolved,
    aiProviderLabel: label,
  });
}

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

const SPEECH_TOKEN_LIMIT = 2000;
const SPEECH_TOKEN_BUFFER = 50;
const SPEECH_MIN_CHARS = 64;
const SPEECH_TOKEN_PATTERN = /(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\p{L}\p{N}]+|[^\s])/gu;
const SPEECH_TOKEN_PATTERN_SOURCE = SPEECH_TOKEN_PATTERN.source;
const SPEECH_TOKEN_PATTERN_FLAGS = SPEECH_TOKEN_PATTERN.flags;
const TTS_STORAGE_KEYS = Object.freeze(['ttsProvider', 'ttsVoice', 'ttsLanguage']);

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

function createSpeechTokenMatcher() {
  return new RegExp(SPEECH_TOKEN_PATTERN_SOURCE, SPEECH_TOKEN_PATTERN_FLAGS);
}

function tokeniseSpeechText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  const matcher = createSpeechTokenMatcher();
  const tokens = [];
  let match;
  while ((match = matcher.exec(text)) !== null) {
    tokens.push({ index: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function alignSpeechBoundary(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return '';
  }

  const windowStart = Math.max(0, trimmed.length - 200);
  const windowText = trimmed.slice(windowStart);
  const punctuationMarks = ['.', '!', '?'];
  let boundaryIndex = -1;

  for (const mark of punctuationMarks) {
    const relative = windowText.lastIndexOf(mark);
    if (relative !== -1) {
      const absolute = windowStart + relative + 1;
      if (absolute > boundaryIndex) {
        boundaryIndex = absolute;
      }
    }
  }

  const newlineIndex = trimmed.lastIndexOf('\n');
  if (newlineIndex !== -1 && newlineIndex >= trimmed.length - 200 && newlineIndex + 1 > boundaryIndex) {
    boundaryIndex = newlineIndex + 1;
  }

  if (boundaryIndex !== -1 && boundaryIndex > SPEECH_MIN_CHARS) {
    return trimmed.slice(0, boundaryIndex).trimEnd();
  }

  const spaceIndex = trimmed.lastIndexOf(' ');
  if (spaceIndex !== -1 && spaceIndex >= trimmed.length - 100 && spaceIndex > SPEECH_MIN_CHARS) {
    return trimmed.slice(0, spaceIndex).trimEnd();
  }

  return trimmed;
}

function clampSpeechInput(rawText) {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return {
      text: '',
      truncated: false,
      originalTokenCount: 0,
      deliveredTokenCount: 0,
      omittedTokenCount: 0,
    };
  }

  const tokens = tokeniseSpeechText(trimmed);
  const totalTokens = tokens.length;
  const safeLimit = Math.max(1, SPEECH_TOKEN_LIMIT - SPEECH_TOKEN_BUFFER);

  if (totalTokens <= safeLimit) {
    return {
      text: trimmed,
      truncated: false,
      originalTokenCount: totalTokens,
      deliveredTokenCount: totalTokens,
      omittedTokenCount: 0,
    };
  }

  const allowedIndex = Math.min(tokens.length - 1, safeLimit - 1);
  const baseEnd = tokens[allowedIndex].end;
  const baseCandidate = trimmed.slice(0, baseEnd);
  let candidate = alignSpeechBoundary(baseCandidate) || baseCandidate.trimEnd();

  if (!candidate) {
    const minimalEnd = tokens[0]?.end || Math.min(trimmed.length, SPEECH_MIN_CHARS);
    candidate = trimmed.slice(0, minimalEnd).trimEnd();
  }

  let candidateTokens = tokeniseSpeechText(candidate);
  if (candidateTokens.length > safeLimit) {
    const fallbackIndex = Math.min(candidateTokens.length - 1, safeLimit - 1);
    const fallbackEnd = candidateTokens[fallbackIndex].end;
    candidate = candidate.slice(0, fallbackEnd).trimEnd();
    candidateTokens = tokeniseSpeechText(candidate);
  }

  if (!candidate) {
    const fallbackLength = Math.min(trimmed.length, Math.max(SPEECH_MIN_CHARS, baseEnd));
    candidate = trimmed.slice(0, fallbackLength).trimEnd();
    candidateTokens = tokeniseSpeechText(candidate);
  }

  const deliveredTokenCount = candidateTokens.length;
  const omittedTokenCount = Math.max(0, totalTokens - deliveredTokenCount);

  return {
    text: candidate,
    truncated: true,
    originalTokenCount: totalTokens,
    deliveredTokenCount,
    omittedTokenCount,
  };
}

function createSpeechMetrics(rawText) {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return {
      text: '',
      truncated: false,
      originalTokenCount: 0,
      deliveredTokenCount: 0,
      omittedTokenCount: 0,
    };
  }
  const tokens = tokeniseSpeechText(trimmed);
  const totalTokens = tokens.length;
  return {
    text: trimmed,
    truncated: false,
    originalTokenCount: totalTokens,
    deliveredTokenCount: totalTokens,
    omittedTokenCount: 0,
  };
}

function normaliseTtsPreference(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickTtsPreference(stored, override) {
  const storedValue = normaliseTtsPreference(stored);
  if (storedValue) {
    return storedValue;
  }
  const overrideValue = normaliseTtsPreference(override);
  if (overrideValue) {
    return overrideValue;
  }
  return null;
}

function classifyTtsProvider(preference) {
  const normalised = normaliseTtsPreference(preference);
  if (!normalised) {
    return { type: 'cloud', providerId: 'auto' };
  }
  const lower = normalised.toLowerCase();
  if (lower === 'local' || lower === 'browser' || lower === 'system' || lower === 'chrome') {
    return { type: 'local', providerId: 'local' };
  }
  if (lower === 'auto') {
    return { type: 'cloud', providerId: 'auto' };
  }
  return { type: 'cloud', providerId: normalised };
}

async function readStoredTtsDefaults() {
  if (!chrome?.storage?.local || typeof chrome.storage.local.get !== 'function') {
    return {};
  }
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(TTS_STORAGE_KEYS, items => {
        const error = chrome?.runtime?.lastError;
        if (error) {
          logger.debug('Failed to read TTS defaults from chrome.storage.local.', { error });
          resolve({});
          return;
        }
        resolve(items || {});
      });
    } catch (error) {
      logger.debug('chrome.storage.local.get threw while reading TTS defaults.', { error });
      resolve({});
    }
  });
}

async function resolveTtsSettings(overrides = {}) {
  const stored = await readStoredTtsDefaults();
  const providerPreference = pickTtsPreference(stored.ttsProvider, overrides.provider);
  const providerDescriptor = classifyTtsProvider(providerPreference);
  const voice = pickTtsPreference(stored.ttsVoice, overrides.voice);
  const languageCode = pickTtsPreference(stored.ttsLanguage, overrides.language);
  return {
    providerId: providerDescriptor.providerId,
    type: providerDescriptor.type,
    voice,
    languageCode,
  };
}

function ensureTtsAdapterRegistration(providerKey) {
  const candidate = normaliseTtsPreference(providerKey) || 'auto';
  const adapterKey = candidate.toLowerCase();
  if (ttsAdapters.has(adapterKey)) {
    return ttsAdapters.get(adapterKey);
  }
  if (adapterKey === 'local') {
    const adapter = createLocalTtsAdapter({ logger: adapterLogger.child({ provider: 'local-tts' }) });
    ttsAdapters.register('local', adapter);
    return adapter;
  }
  const adapter = createCloudTtsAdapter(adapterKey);
  ttsAdapters.register(adapterKey, adapter);
  return adapter;
}

function createCloudTtsAdapter(providerKey) {
  const resolvedKey = normaliseTtsPreference(providerKey) || 'auto';
  const adapterLoggerContext = adapterLogger.child({ provider: `tts-${resolvedKey}` });
  return {
    id: resolvedKey,
    type: 'cloud',
    async synthesise({ text, voice, languageCode }) {
      const targetProviderRaw = resolvedKey === 'auto' ? await getActiveProviderId() : resolvedKey;
      const normalisedProvider = normaliseProviderId(targetProviderRaw, targetProviderRaw);
      const resolvedProvider = resolveAlias(normalisedProvider);
      adapterLoggerContext.debug('Dispatching cloud TTS request.', {
        provider: resolvedProvider,
        hasVoice: Boolean(voice),
        hasLanguage: Boolean(languageCode),
        textLength: typeof text === 'string' ? text.length : 0,
      });
      const adapter = await ensureAdapter(resolvedProvider);
      const costMetadata = getCostMetadata(adapter);
      const synthMeta = costMetadata.synthesise || {};
      const estimatedCost = resolveFlatCost(synthMeta, 0.01);
      if (!costTracker.canSpend(estimatedCost)) {
        adapterLoggerContext.warn('Speech synthesis aborted due to cost limit.', { estimatedCost, provider: resolvedProvider });
        throw new Error('Cost limit reached for speech synthesis.');
      }

      const { apiKey, providerId } = await resolveApiKey(resolvedProvider);
      ensureKeyAvailable(apiKey, providerId);

      try {
        const response = await adapter.synthesise({
          apiKey,
          text,
          voice: voice, // Let the underlying adapter handle defaults or pass a provider-aware default
          format: 'mp3',
          model: synthMeta.model,
          languageCode,
        });
        costTracker.recordFlat(synthMeta.label || 'tts', estimatedCost, { type: synthMeta.label || 'tts' });
        await persistUsage();
        const base64 = typeof response?.base64 === 'string'
          ? response.base64
          : response?.arrayBuffer
            ? toBase64(response.arrayBuffer)
            : null;
        const mimeType = response?.mimeType || 'audio/mp3';
        adapterLoggerContext.info('Cloud TTS request completed.', {
          provider: providerId,
          mimeType,
        });
        return {
          base64,
          mimeType,
          providerId,
          model: synthMeta.model || null,
        };
      } catch (error) {
        const displayName = getProviderDisplayName(providerId) || providerId || 'Provider';
        const message = error?.message
          ? `${displayName} text-to-speech failed: ${error.message}`
          : `${displayName} text-to-speech failed.`;
        adapterLoggerContext.error('Cloud TTS adapter failed.', {
          provider: providerId,
          resolvedKey,
          error,
        });
        const wrapped = new Error(message);
        wrapped.cause = error;
        throw wrapped;
      }
    },
  };
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
    applyProviderLoggingContext(activeProviderId);
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
      applyProviderLoggingContext(activeProviderId);
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
    applyProviderLoggingContext(activeProviderId);
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
    applyProviderLoggingContext(activeProviderId);
    logger.info('Adapter initialised.', { activeProvider: activeProviderId });
    return adapter;
  })()
    .catch(error => {
      providerConfig = getFallbackProviderConfig();
      activeProviderId = providerConfig.provider || DEFAULT_PROVIDER_ID;
      logger.error('Falling back to default adapter due to unexpected error.', { error });
      const fallbackAdapterKey = getAdapterKey(activeProviderId);
      const adapter = createAdapter(fallbackAdapterKey, providerConfig);
      applyProviderLoggingContext(activeProviderId);
      return adapter;
    })
    .finally(() => {
      adapterLoadPromise = null;
      loadingProviderId = null;
      logger.debug('Adapter load complete.');
    });

  adapterInstance = await adapterLoadPromise;
  applyProviderLoggingContext(activeProviderId);
  return adapterInstance;
}

async function getActiveProviderId(providerId) {
  await ensureAdapter(providerId);
  return activeProviderId || DEFAULT_PROVIDER;
}

async function ensureInitialised(providerId) {
  const previousProvider = activeProviderId;
  await ensureLoggingConfiguredOnce();
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
  const adapter = await ensureAdapter(desiredProvider);
  if (previousProvider && previousProvider !== activeProviderId) {
    logger.info('Active provider changed; resetting cache.', {
      previousProvider,
      activeProvider: activeProviderId,
    });
    memoryCache.clear();
    await persistCache();
  }
  const voice = await resolveVoiceCapabilities(activeProviderId, adapter);
  return {
    provider: activeProviderId,
    requiresApiKey: providerRequiresApiKey(activeProviderId),
    voice,
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

function normaliseVoiceList(voices) {
  if (!Array.isArray(voices)) {
    return [];
  }
  const cleaned = voices
    .map(voice => (typeof voice === 'string' ? voice.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function normaliseVoiceCapabilities(rawCapabilities) {
  if (!rawCapabilities || typeof rawCapabilities !== 'object') {
    return { availableVoices: [], preferredVoice: null };
  }
  const availableVoices = normaliseVoiceList(
    rawCapabilities.availableVoices
      || rawCapabilities.available
      || (rawCapabilities.voices && rawCapabilities.voices.available)
      || [],
  );
  let preferredVoice = rawCapabilities.preferredVoice
    || rawCapabilities.preferred
    || (rawCapabilities.voices && rawCapabilities.voices.preferred)
    || null;
  if (typeof preferredVoice === 'string') {
    preferredVoice = preferredVoice.trim();
  } else {
    preferredVoice = null;
  }
  if (preferredVoice && !availableVoices.includes(preferredVoice)) {
    preferredVoice = availableVoices[0] || null;
  }
  if (!preferredVoice && availableVoices.length > 0) {
    preferredVoice = availableVoices[0];
  }
  return {
    availableVoices,
    preferredVoice: preferredVoice || null,
  };
}

async function resolveVoiceCapabilities(providerId, adapterOverride) {
  let adapter = adapterOverride;
  if (!adapter) {
    adapter = await ensureAdapter(providerId);
  }
  let rawCapabilities;
  if (adapter && typeof adapter.getVoiceCapabilities === 'function') {
    try {
      rawCapabilities = await adapter.getVoiceCapabilities();
    } catch (error) {
      logger.warn('Adapter getVoiceCapabilities failed; falling back to cost metadata.', {
        providerId: activeProviderId,
        error,
      });
    }
  }
  if (!rawCapabilities) {
    const metadata = getCostMetadata(adapter);
    rawCapabilities = metadata?.synthesise?.voices || metadata?.voices || {};
  }
  const normalised = normaliseVoiceCapabilities(rawCapabilities);
  return {
    provider: activeProviderId,
    availableVoices: normalised.availableVoices,
    preferredVoice: normalised.preferredVoice,
  };
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
  const fallbackProvider = resolveAlias(
    normaliseProviderId(provider, activeProviderId || DEFAULT_PROVIDER_ID)
  );
  const resolvedProvider = result?.provider
    ? resolveAlias(normaliseProviderId(result.provider, result.provider))
    : fallbackProvider;
  const resolvedResult = { ...result, provider: resolvedProvider };
  logger.debug('Summary generated.', {
    provider: resolvedProvider,
    model: resolvedResult?.model,
  });
  return resolvedResult;
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

async function synthesiseSpeech(payload = {}, resolvedSettings = null) {
  const { text = '', provider, voice, language } = payload;
  const settings = resolvedSettings || await resolveTtsSettings({ provider, voice, language });
  const adapter = ensureTtsAdapterRegistration(settings.providerId);
  const effectiveVoice = settings.voice || (settings.type === 'cloud' ? 'alloy' : null);
  const languageCode = settings.languageCode || null;
  const metrics = settings.type === 'cloud' ? clampSpeechInput(text) : createSpeechMetrics(text);

  logger.info('Speech synthesis request received.', {
    provider: settings.providerId,
    adapterType: adapter.type,
    requestedProvider: provider,
    voice: effectiveVoice,
    language: languageCode,
    truncated: metrics.truncated,
  });

  if (adapter.type === 'cloud' && metrics.truncated) {
    logger.warn('Speech input exceeded provider limits; truncating request.', {
      originalTokens: metrics.originalTokenCount,
      deliveredTokens: metrics.deliveredTokenCount,
      omittedTokens: metrics.omittedTokenCount,
    });
  }

  const synthesisResult = await adapter.synthesise({
    text: metrics.text,
    voice: effectiveVoice || undefined,
    languageCode,
  });

  if (synthesisResult?.base64) {
    logger.debug('Audio payload returned; deferring playback to caller.', {
      adapterType: adapter.type,
    });
  } else {
    logger.debug('No base64 payload returned; skipping playback.', {
      adapterType: adapter.type,
    });
  }

  const resolvedProvider = synthesisResult?.providerId
    || (adapter.type === 'local' ? 'local' : settings.providerId || 'auto');

  return {
    audio: {
      base64: synthesisResult?.base64 || null,
      mimeType: synthesisResult?.mimeType || 'audio/mpeg',
      truncated: metrics.truncated,
      originalTokenCount: metrics.originalTokenCount,
      deliveredTokenCount: metrics.deliveredTokenCount,
      omittedTokenCount: metrics.omittedTokenCount,
    },
    adapter: {
      id: resolvedProvider,
      type: adapter.type,
    },
  };
}

async function getSummary({ url, segment, language, provider }) {
  const providerId = await getActiveProviderId(provider);
  const resolvedActiveProvider = resolveAlias(normaliseProviderId(providerId, providerId));
  const cacheKey = getCacheKey({
    url,
    segmentId: segment.id,
    language,
    providerId,
  });
  if (memoryCache.has(cacheKey)) {
    const cached = memoryCache.get(cacheKey);
    if (typeof cached === 'string') {
      logger.debug('Summary cache hit (string).', {
        segmentId: segment.id,
        provider: resolvedActiveProvider,
      });
      return {
        summary: cached,
        provider: resolvedActiveProvider,
        model: null,
        source: 'cache',
      };
    }
    if (cached && typeof cached === 'object' && typeof cached.summary === 'string') {
      const cachedProvider = cached.provider
        ? resolveAlias(normaliseProviderId(cached.provider, cached.provider))
        : resolvedActiveProvider;
      logger.debug('Summary cache hit.', {
        segmentId: segment.id,
        provider: cachedProvider,
      });
      return {
        summary: cached.summary,
        provider: cachedProvider,
        model: cached.model || null,
        source: 'cache',
      };
    }
  }
  logger.debug('Summary cache miss.', { segmentId: segment.id });
  const result = await requestSummary({ url, segment, language, provider });
  const summary = typeof result?.text === 'string'
    ? result.text
    : typeof result?.summary === 'string'
      ? result.summary
      : '';
  const providerUsed = result?.provider
    ? resolveAlias(normaliseProviderId(result.provider, result.provider))
    : resolvedActiveProvider;
  memoryCache.set(cacheKey, {
    summary,
    provider: providerUsed,
    model: result?.model,
    cost: result?.cost_estimate,
  });
  await persistCache();
  return {
    summary,
    provider: providerUsed,
    model: result?.model || null,
    source: 'network',
  };
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
  const providersUsed = new Set();
  const modelsUsed = new Set();
  for (const segment of Array.isArray(segments) ? segments : []) {
    const { summary, provider: summaryProvider, model } = await getSummary({
      url,
      segment,
      language,
      provider,
    });
    if (summaryProvider) {
      providersUsed.add(summaryProvider);
    }
    if (model) {
      modelsUsed.add(model);
    }
    summaries.push({ id: segment.id, summary });
  }
  const providerList = Array.from(providersUsed);
  const modelList = Array.from(modelsUsed);
  const completionMeta = { count: summaries.length };
  if (providerList.length > 0) {
    completionMeta.providers = providerList;
    completionMeta.providerLabels = providerList.map(id => getProviderDisplayName(id));
  }
  if (modelList.length > 0) {
    completionMeta.models = modelList;
  }
  logger.info('Summarise request completed.', completionMeta);
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
  const settings = await resolveTtsSettings({
    provider: message.payload?.provider,
    voice: message.payload?.voice,
    language: message.payload?.language,
  });
  if (settings.type === 'cloud') {
    const initProvider = settings.providerId && settings.providerId !== 'auto'
      ? settings.providerId
      : normaliseTtsPreference(message.payload?.provider);
    await ensureInitialised(initProvider === 'auto' ? undefined : initProvider);
  } else {
    await ensureLoggingConfiguredOnce();
  }
  const result = await synthesiseSpeech(message.payload, settings);
  const usage = result.adapter.type === 'cloud' && costTracker
    ? costTracker.toJSON()
    : null;
  return { audio: result.audio, usage };
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
  'comet:getVoiceCapabilities': ({ payload }) => resolveVoiceCapabilities(payload?.provider),
};

runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const correlationId = createCorrelationId('bg-handler');

  try {
    if (!message || !message.type || !handlers[message.type]) {
      logger.warn('Received unsupported message.', {
        messageType: message?.type,
        correlationId,
      });
      sendResponse({ success: false, result: null, error: 'Unsupported message type.' });
      return false;
    }

    logger.debug('Received background message.', {
      type: message.type,
      correlationId,
    });

    const handler = handlers[message.type];
    const handlerResult = handler(message, sender);

    if (handlerResult && typeof handlerResult.then === 'function') {
      handlerResult
        .then(result => {
          logger.debug('Background message handled successfully.', {
            type: message.type,
            correlationId,
          });
          sendResponse({ success: true, result, error: null });
        })
        .catch(error => {
          const resolvedError = error instanceof Error ? error : new Error(String(error));
          logger.error('Background message handler failed.', {
            type: message.type,
            correlationId,
            error: resolvedError,
          });
          sendResponse({ success: false, result: null, error: resolvedError.message });
        });
      return true;
    }

    logger.debug('Background message handled successfully.', {
      type: message.type,
      correlationId,
    });
    sendResponse({ success: true, result: handlerResult, error: null });
    return false;
  } catch (caughtError) {
    const resolvedError = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
    logger.error('Background message handler threw synchronously.', {
      type: message?.type,
      correlationId,
      error: resolvedError,
    });
    sendResponse({ success: false, result: null, error: resolvedError.message });
    return false;
  }
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
  ttsAdapters.clear();
  ttsAdapters.register('local', createLocalTtsAdapter({ logger: adapterLogger.child({ provider: 'local-tts' }) }));
  ttsAdapters.register('auto', createCloudTtsAdapter('auto'));
}

async function __transcribeForTests(payload) {
  return transcribeAudio(payload);
}

async function __synthesiseForTests(payload) {
  return synthesiseSpeech(payload);
}

export {
  ensureInitialised,
  getApiKeyDetails,
  getCacheKey,
  parseCacheKey,
  handleUsageRequest,
  setActiveProvider,
  setApiKey,
  __clearTestOverrides,
  __setTestAdapterOverride,
  __setTestCostTrackerOverride,
  __transcribeForTests,
  __synthesiseForTests,
};

ensureInitialised().catch(error => {
  logger.error('Failed to initialise service worker.', { error });
});
