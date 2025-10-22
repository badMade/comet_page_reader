/**
 * Background service worker for the Comet extension.
 *
 * The worker runs in the browser's background context and orchestrates language
 * model adapters, routing, usage tracking, caching, and speech utilities. It is
 * responsible for persisting provider preferences and token usage across
 * sessions while exposing request handlers to the extension runtime.
 */
import createLogger, { loadLoggingConfig, setGlobalContext, withCorrelation } from '../utils/logger.js';
import { createCostTracker, DEFAULT_TOKEN_LIMIT, estimateTokensFromUsd } from '../utils/cost.js';
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
import { playAudioFromBase64 } from '../utils/audio.js';
import { ttsAdapters } from './tts/registry.js';
import { createLocalTtsAdapter } from './tts/local.js';
import { LLMRouter } from './llm/router.js';

const logger = createLogger({ name: 'background-service' });
setGlobalContext({ runtime: 'background-service' });

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  const logBackgroundError = logger.wrapAsync(
    async (event, correlationId) => {
      const meta = {
        ...getBackgroundContextMetadata(),
        ...withCorrelation(correlationId),
        eventType: event?.type ?? 'error',
        filename: event?.filename,
        lineno: event?.lineno,
        colno: event?.colno,
      };
      if (event?.message) {
        meta.message = event.message;
      }
      if (event?.error) {
        meta.error = event.error;
      }
      await logger.error('Uncaught error in background service worker.', meta);
    },
    (event, correlationId) => ({
      component: logger.component,
      eventType: event?.type ?? 'error',
      ...getBackgroundContextMetadata(),
      ...withCorrelation(correlationId),
      errorMessage: 'Background service worker error listener failed.',
    }),
  );

  self.addEventListener('error', event => {
    const correlationId = createCorrelationId('bg-uncaught-error');
    logBackgroundError(event, correlationId).catch(() => {});
  });

  const logBackgroundUnhandledRejection = logger.wrapAsync(
    async (event, correlationId) => {
      const meta = {
        ...getBackgroundContextMetadata(),
        ...withCorrelation(correlationId),
        eventType: event?.type ?? 'unhandledrejection',
      };
      if (event?.reason instanceof Error) {
        meta.error = event.reason;
      } else if (typeof event?.reason !== 'undefined') {
        meta.reason = event.reason;
      }
      await logger.error('Unhandled promise rejection in background service worker.', meta);
    },
    (event, correlationId) => ({
      component: logger.component,
      eventType: event?.type ?? 'unhandledrejection',
      ...getBackgroundContextMetadata(),
      ...withCorrelation(correlationId),
      errorMessage: 'Background service worker rejection listener failed.',
    }),
  );

  self.addEventListener('unhandledrejection', event => {
    const correlationId = createCorrelationId('bg-unhandled-rejection');
    logBackgroundUnhandledRejection(event, correlationId).catch(() => {});
  });
}

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

function normaliseTokenCount(value, ...fallbacks) {
  const candidates = [value, ...fallbacks];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return 0;
}

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

function ensureMessageCorrelation(message, prefix = 'bg-handler') {
  if (!message || typeof message !== 'object') {
    return createCorrelationId(prefix);
  }
  const existing = typeof message.correlationId === 'string' ? message.correlationId.trim() : '';
  if (existing) {
    message.correlationId = existing;
    return existing;
  }
  const generated = createCorrelationId(prefix);
  message.correlationId = generated;
  return generated;
}

function normaliseRuntimeMessage(rawMessage) {
  if (rawMessage && typeof rawMessage === 'object') {
    return rawMessage;
  }
  return {};
}

function formatUrlForLog(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    const base = `${parsed.origin}${parsed.pathname}`;
    return parsed.hash ? `${base}${parsed.hash}` : base;
  } catch (error) {
    return value;
  }
}

function describeSender(sender) {
  if (!sender || typeof sender !== 'object') {
    return {};
  }
  const meta = {};
  const tabId = sender?.tab?.id;
  if (typeof tabId === 'number') {
    meta.senderTabId = tabId;
  }
  const tabUrl = formatUrlForLog(sender?.tab?.url);
  if (tabUrl) {
    meta.senderTabUrl = tabUrl;
  }
  if (typeof sender?.frameId === 'number') {
    meta.senderFrameId = sender.frameId;
  }
  if (typeof sender?.documentId === 'string' && sender.documentId.trim()) {
    meta.senderDocumentId = sender.documentId.trim();
  }
  const senderUrl = formatUrlForLog(sender?.url);
  if (senderUrl) {
    meta.senderUrl = senderUrl;
  }
  if (typeof sender?.origin === 'string' && sender.origin.trim()) {
    meta.senderOrigin = sender.origin.trim();
  }
  return meta;
}

function getBackgroundContextMetadata() {
  const meta = {};
  if (typeof activeProviderId === 'string' && activeProviderId.trim()) {
    meta.activeProviderId = activeProviderId.trim();
  }
  if (typeof loadingProviderId === 'string' && loadingProviderId.trim()) {
    meta.loadingProviderId = loadingProviderId.trim();
  }
  if (typeof preferredProviderId === 'string' && preferredProviderId.trim()) {
    meta.preferredProviderId = preferredProviderId.trim();
  }
  if (initialised) {
    meta.initialised = true;
  }
  return meta;
}

function createRuntimeHandler(messageType, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }
  return logger.wrapAsync(
    async (...args) => handler(...args),
    (message, sender) => {
      const correlationId = ensureMessageCorrelation(message);
      const resolvedType = messageType || (message && message.type) || null;
      const meta = {
        messageType: resolvedType,
        type: resolvedType,
        ...getBackgroundContextMetadata(),
        ...describeSender(sender),
      };
      return {
        component: logger.component,
        ...withCorrelation(correlationId),
        meta,
        errorMessage: 'Background message handler failed.',
      };
    },
  );
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
const TTS_PROVIDER_ALIAS_MAP = Object.freeze({
  localtts: Object.freeze({ type: 'local', providerId: 'local' }),
  googletts: Object.freeze({ type: 'cloud', providerId: 'auto' }),
  amazonpolly: Object.freeze({ type: 'cloud', providerId: 'auto' }),
});

const OPENAI_TTS_CAPABILITY = Object.freeze({
  model: 'gpt-4o-mini-tts',
  maxInputTokens: 4096,
  tokenBuffer: 64,
  sentenceOverlap: 0,
});

const TTS_PROVIDER_CAPABILITIES = Object.freeze({
  openai: OPENAI_TTS_CAPABILITY,
  openai_paid: OPENAI_TTS_CAPABILITY,
  openai_trial: OPENAI_TTS_CAPABILITY,
});

function getAdapterKey(providerId) {
  const normalised = normaliseProviderId(providerId, providerId);
  return PROVIDER_ADAPTER_KEYS[normalised] || normalised;
}

/**
 * Build a cache identifier for summarisation results.
 *
 * Args:
 *   url: The canonical URL of the page.
 *   segmentId: The identifier for the text segment.
 *   language: The target language for the summary. Defaults to 'en'.
 *   providerId: The provider ID used for summarisation. Defaults to `DEFAULT_PROVIDER_ID`.
 *
 * Returns:
 *   A JSON string used as the key for both the in-memory and session caches.
 *
 * Side Effects:
 *   None.
 */
function getCacheKey({ url, segmentId, language = 'en', providerId = DEFAULT_PROVIDER_ID }) {
  return JSON.stringify({
    url,
    segmentId,
    language: language || 'en',
    providerId: providerId || DEFAULT_PROVIDER_ID,
  });
}

/**
 * Parse a cache key generated by {@link getCacheKey}.
 *
 * Args:
 *   key: The cache key string retrieved from in-memory or persisted cache
 *     storage.
 *
 * Returns:
 *   An object describing the cached segment metadata, or null when the key
 *   cannot be parsed. Legacy cache key formats are converted to the modern
 *   object shape.
 *
 * Side Effects:
 *   None.
 */
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

function resolveTtsProviderCapabilities(providerId) {
  if (!providerId) {
    return null;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  const resolved = resolveAlias(normalised);
  return TTS_PROVIDER_CAPABILITIES[resolved] || null;
}

function normaliseSentenceOverlap(value) {
  if (value === 1 || value === '1') {
    return 1;
  }
  return 0;
}

function segmentSpeechIntoSentences(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = [];
      for (const part of segmenter.segment(trimmed)) {
        const candidate = part?.segment?.trim();
        if (candidate) {
          segments.push(candidate);
        }
      }
      if (segments.length > 0) {
        return segments;
      }
    } catch (error) {
      logger.debug('Intl.Segmenter failed while splitting sentences; falling back to regex.', { error });
    }
  }

  const fallbackPattern = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;
  const segments = [];
  let match;
  while ((match = fallbackPattern.exec(trimmed)) !== null) {
    const candidate = match[0]?.trim();
    if (candidate) {
      segments.push(candidate);
    }
  }
  if (!segments.length && trimmed) {
    segments.push(trimmed);
  }
  return segments;
}

function createSpeechSegmentFactory() {
  let nextId = 0;
  const tokenLookup = new Map();
  return {
    create(text) {
      if (typeof text !== 'string') {
        return null;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        return null;
      }
      const tokens = tokeniseSpeechText(trimmed).length;
      const id = nextId;
      nextId += 1;
      tokenLookup.set(id, tokens);
      return { id, text: trimmed, tokens };
    },
    getTokenCount(id) {
      return tokenLookup.get(id) || 0;
    },
  };
}

function splitTextByTokenLimit(text, maxTokens, factory) {
  const tokens = tokeniseSpeechText(text);
  if (tokens.length === 0 || maxTokens <= 0) {
    return [];
  }
  const safeLimit = Math.max(1, Math.floor(maxTokens));
  const segments = [];
  for (let start = 0; start < tokens.length; start += safeLimit) {
    const endTokenIndex = Math.min(start + safeLimit, tokens.length) - 1;
    const startIndex = tokens[start].index;
    const endIndex = tokens[endTokenIndex].end;
    const part = text.slice(startIndex, endIndex);
    const segment = factory.create(part);
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

function resolveSpeechChunkLimit(capability) {
  const configuredMax = capability && typeof capability.maxInputTokens === 'number'
    ? capability.maxInputTokens
    : SPEECH_TOKEN_LIMIT;
  const buffer = capability && typeof capability.tokenBuffer === 'number'
    ? Math.max(0, Math.floor(capability.tokenBuffer))
    : SPEECH_TOKEN_BUFFER;
  return Math.max(1, Math.floor(configuredMax) - buffer);
}

function createSpeechChunkPlan(rawText, capability = null) {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return {
      chunks: [
        { text: '', tokenCount: 0 },
      ],
      metrics: {
        truncated: false,
        originalTokenCount: 0,
        deliveredTokenCount: 0,
        omittedTokenCount: 0,
      },
    };
  }

  const originalTokens = tokeniseSpeechText(trimmed).length;
  const limit = resolveSpeechChunkLimit(capability);
  const overlap = normaliseSentenceOverlap(capability?.sentenceOverlap);
  const factory = createSpeechSegmentFactory();
  const sentences = segmentSpeechIntoSentences(trimmed)
    .map(sentence => factory.create(sentence))
    .filter(Boolean);
  const segments = sentences.length > 0
    ? sentences
    : [factory.create(trimmed)].filter(Boolean);

  const expandedSegments = [];
  for (const segment of segments) {
    if (segment.tokens <= limit) {
      expandedSegments.push(segment);
      continue;
    }
    const splitSegments = splitTextByTokenLimit(segment.text, limit, factory);
    if (splitSegments.length === 0) {
      expandedSegments.push(segment);
      continue;
    }
    expandedSegments.push(...splitSegments);
  }

  const chunks = [];
  const seenSegmentIds = new Set();
  let index = 0;
  let truncated = false;

  while (index < expandedSegments.length) {
    let tokenCount = 0;
    let endIndex = index;
    const parts = [];

    while (endIndex < expandedSegments.length) {
      const candidate = expandedSegments[endIndex];
      if (!candidate) {
        endIndex += 1;
        continue;
      }
      const projected = tokenCount + candidate.tokens;
      if (tokenCount > 0 && projected > limit) {
        break;
      }
      if (candidate.tokens > limit && tokenCount === 0) {
        truncated = true;
        parts.push(candidate.text);
        tokenCount += candidate.tokens;
        endIndex += 1;
        break;
      }
      parts.push(candidate.text);
      tokenCount = projected;
      endIndex += 1;
      if (tokenCount >= limit) {
        break;
      }
    }

    if (!parts.length) {
      truncated = true;
      break;
    }

    const chunkText = parts.join(' ').trim();
    const chunkTokenCount = tokeniseSpeechText(chunkText).length;
    chunks.push({ text: chunkText, tokenCount: chunkTokenCount });

    for (let pointer = index; pointer < endIndex; pointer += 1) {
      const segment = expandedSegments[pointer];
      if (segment) {
        seenSegmentIds.add(segment.id);
      }
    }

    if (endIndex <= index) {
      index += 1;
    } else if (overlap > 0) {
      index = Math.max(endIndex - overlap, index + 1);
    } else {
      index = endIndex;
    }
  }

  const deliveredTokenCount = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
  const uniqueTokenCount = Array.from(seenSegmentIds)
    .reduce((sum, id) => sum + factory.getTokenCount(id), 0);
  const omittedTokenCount = Math.max(0, originalTokens - uniqueTokenCount);

  return {
    chunks: chunks.length > 0 ? chunks : [{ text: trimmed, tokenCount: originalTokens }],
    metrics: {
      truncated: truncated || uniqueTokenCount < originalTokens,
      originalTokenCount: originalTokens,
      deliveredTokenCount,
      omittedTokenCount,
    },
  };
}

function createLocalSpeechPlan(rawText) {
  const metrics = createSpeechMetrics(rawText);
  const chunk = { text: metrics.text, tokenCount: metrics.deliveredTokenCount };
  return {
    chunks: [{ ...chunk }],
    metrics,
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
  if (Object.prototype.hasOwnProperty.call(TTS_PROVIDER_ALIAS_MAP, lower)) {
    return TTS_PROVIDER_ALIAS_MAP[lower];
  }
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
    async synthesise({
      text,
      voice,
      languageCode,
      chunkIndex = 0,
      chunkCount = 1,
      maxInputTokens,
      model: modelOverride,
    }) {
      const targetProviderRaw = resolvedKey === 'auto' ? await getActiveProviderId() : resolvedKey;
      const normalisedProvider = normaliseProviderId(targetProviderRaw, targetProviderRaw);
      const resolvedProvider = resolveAlias(normalisedProvider);
      const capabilities = resolveTtsProviderCapabilities(resolvedProvider);
      adapterLoggerContext.debug('Dispatching cloud TTS request.', {
        provider: resolvedProvider,
        hasVoice: Boolean(voice),
        hasLanguage: Boolean(languageCode),
        textLength: typeof text === 'string' ? text.length : 0,
        chunkIndex,
        chunkCount,
      });
      const adapter = await ensureAdapter(resolvedProvider);
      const costMetadata = getCostMetadata(adapter);
      const synthMeta = costMetadata.synthesise || {};
      const requestedModel = modelOverride || synthMeta.model || capabilities?.model || null;
      const tokenLimit = typeof maxInputTokens === 'number' && Number.isFinite(maxInputTokens)
        ? maxInputTokens
        : capabilities?.maxInputTokens;

      const { apiKey, providerId } = await resolveApiKey(resolvedProvider);
      ensureKeyAvailable(apiKey, providerId);

      try {
        const response = await adapter.synthesise({
          apiKey,
          text,
          voice: voice, // Let the underlying adapter handle defaults or pass a provider-aware default
          format: 'mp3',
          model: requestedModel || undefined,
          languageCode,
          chunkIndex,
          chunkCount,
          maxInputTokens: tokenLimit,
        });
        const base64 = typeof response?.base64 === 'string'
          ? response.base64
          : response?.arrayBuffer
            ? toBase64(response.arrayBuffer)
            : null;
        const mimeType = response?.mimeType || 'audio/mp3';
        adapterLoggerContext.info('Cloud TTS request completed.', {
          provider: providerId,
          mimeType,
          chunkIndex,
          chunkCount,
        });
        return {
          base64,
          mimeType,
          providerId,
          model: requestedModel || synthMeta.model || null,
          usageLabel: synthMeta.label || null,
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

/**
 * Initialise shared background state for the requested provider.
 *
 * Args:
 *   providerId: Optional provider ID that should be initialised before use.
 *     When omitted, the currently active provider is used.
 *
 * Returns:
 *   A promise that resolves once logging, routing, adapters, caches, and usage
 *   tracking have been prepared for the active provider.
 *
 * Side Effects:
 *   Configures global logging, loads agent configuration, instantiates or
 *   reuses provider adapters, hydrates the session cache, and initialises the
 *   cost tracker with persisted usage. If the provider changes after the first
 *   run, the in-memory cache is cleared and persisted to maintain consistency.
 */
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
  const configuredLimit = typeof routingSettings?.maxMonthlyTokens === 'number'
    ? routingSettings.maxMonthlyTokens
    : DEFAULT_TOKEN_LIMIT;
  let limitTokens = configuredLimit;
  let usage;

  if (storedUsage && typeof storedUsage === 'object') {
    const { limitTokens: savedLimitTokens, limitUsd: legacyLimitUsd, ...snapshot } = storedUsage;
    if (typeof savedLimitTokens === 'number' && Number.isFinite(savedLimitTokens)) {
      limitTokens = Math.min(configuredLimit, savedLimitTokens);
    } else if (typeof legacyLimitUsd === 'number' && Number.isFinite(legacyLimitUsd)) {
      const converted = estimateTokensFromUsd(legacyLimitUsd);
      if (converted > 0) {
        limitTokens = Math.min(configuredLimit, converted);
      }
    }
    if (Object.keys(snapshot).length > 0) {
      const requestTotals = Array.isArray(snapshot.requests)
        ? snapshot.requests.reduce((totals, request) => {
          const prompt = normaliseTokenCount(request?.promptTokens);
          const completion = normaliseTokenCount(request?.completionTokens);
          totals.prompt += prompt;
          totals.completion += completion;
          totals.total += prompt + completion;
          return totals;
        }, { prompt: 0, completion: 0, total: 0 })
        : { prompt: 0, completion: 0, total: 0 };
      const cumulativePromptTokens = normaliseTokenCount(
        snapshot.cumulativePromptTokens,
        snapshot.totalPromptTokens,
        requestTotals.prompt,
      );
      const cumulativeCompletionTokens = normaliseTokenCount(
        snapshot.cumulativeCompletionTokens,
        snapshot.totalCompletionTokens,
        requestTotals.completion,
      );
      const cumulativeTotalTokens = normaliseTokenCount(
        snapshot.cumulativeTotalTokens,
        snapshot.totalTokens,
        requestTotals.total,
      );
      const metadata = snapshot.metadata && typeof snapshot.metadata === 'object'
        ? { ...snapshot.metadata }
        : {};
      usage = {
        ...snapshot,
        cumulativePromptTokens,
        cumulativeCompletionTokens,
        cumulativeTotalTokens,
        metadata: {
          ...metadata,
          cumulativePromptTokens,
          cumulativeCompletionTokens,
          cumulativeTotalTokens,
        },
      };
    }
  }

  costTracker = createCostTracker(limitTokens, usage);
  if (testCostTrackerOverride) {
    costTracker = testCostTrackerOverride;
  }
  if (llmRouter) {
    llmRouter.setCostTracker(costTracker);
  }
  const cachedEntries = (await getSessionValue(CACHE_STORAGE_KEY)) || {};
  memoryCache = new Map(Object.entries(cachedEntries));
  logger.info('Initialising background state.', {
    limitTokens,
    cachedEntries: memoryCache.size,
  });
  await ensureRouter();
  initialised = true;
  logger.info('Background service worker initialised.');
}

/**
 * Persist and activate a preferred AI provider.
 *
 * Args:
 *   providerId: Provider identifier requested by the caller. The value may be
 *     an alias or the literal string "auto" to restore the default routing
 *     behaviour.
 *
 * Returns:
 *   A promise resolving to an object that describes the active provider,
 *   whether an API key is required, and the resolved text-to-speech voice
 *   capabilities.
 *
 * Side Effects:
 *   Updates the persisted provider preference, ensures the matching adapter is
 *   loaded, and clears and persists cached summaries when the active provider
 *   changes.
 */
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

/**
 * Persist an API key for the active provider.
 *
 * Args:
 *   apiKey: The API key string provided by the user. Falsy values remove the
 *     stored key.
 *   options: Optional object containing a provider override.
 *
 * Returns:
 *   A promise that resolves once the key has been written to durable storage.
 *
 * Side Effects:
 *   Persists the API key in the extension's storage for the resolved provider.
 */
async function setApiKey(apiKey, options = {}) {
  const providerId = await getActiveProviderId(options?.provider);
  logger.info('Saving API key.', {
    providerId,
    provided: Boolean(apiKey),
  });
  return saveApiKey(apiKey, { provider: providerId });
}

/**
 * Retrieve metadata about the stored API key for a provider.
 *
 * Args:
 *   options: Optional object containing a provider override used to resolve
 *     aliases prior to fetching details.
 *
 * Returns:
 *   A promise that resolves to an object containing provider metadata and
 *   validation details retrieved from the backing store.
 *
 * Side Effects:
 *   None.
 */
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

function resolveFlatTokenEstimate(metadata, fallback) {
  const flatTokens = metadata && typeof metadata.flatTokens === 'number'
    ? metadata.flatTokens
    : Number.NaN;
  if (Number.isFinite(flatTokens) && flatTokens >= 0) {
    return Math.round(flatTokens);
  }
  const estimatedTokens = metadata && typeof metadata.estimatedTokens === 'number'
    ? metadata.estimatedTokens
    : Number.NaN;
  if (Number.isFinite(estimatedTokens) && estimatedTokens >= 0) {
    return Math.round(estimatedTokens);
  }
  const flatCost = metadata && typeof metadata.flatCost === 'number'
    ? metadata.flatCost
    : Number.NaN;
  if (Number.isFinite(flatCost) && flatCost >= 0) {
    return estimateTokensFromUsd(flatCost);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) {
    return Math.round(fallback);
  }
  return 0;
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  if (typeof base64 !== 'string' || !base64) {
    return new Uint8Array(0);
  }
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('Base64 conversion is not supported in this environment.');
}

function concatenateUint8Arrays(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const filtered = chunks.filter(chunk => chunk instanceof Uint8Array && chunk.length > 0);
  if (filtered.length === 0) {
    return null;
  }
  const totalLength = filtered.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of filtered) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function emitTtsProgressEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  try {
    const runtimeNamespace = runtime?.runtime;
    if (!runtimeNamespace || typeof runtimeNamespace.sendMessage !== 'function') {
      return;
    }
    runtimeNamespace.sendMessage({ type: 'comet:tts:progress', payload }, () => {
      const lastError = runtimeNamespace.lastError;
      if (lastError && lastError.message) {
        logger.trace('TTS progress message reported runtime warning.', { message: lastError.message });
      }
    });
  } catch (error) {
    logger.trace('Failed to emit TTS progress event.', { error });
  }
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
  const estimatedTokens = resolveFlatTokenEstimate(transcribeMeta, 1200);
  if (costTracker && !costTracker.canSpend(estimatedTokens)) {
    logger.warn('Transcription aborted due to token limit.', { estimatedTokens });
    throw new Error('Token limit reached for transcription.');
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

  if (costTracker) {
    const transcriptTokens = costTracker.estimateTokensFromText(result.text);
    costTracker.recordFlat(transcribeMeta.label || 'stt', {
      completionTokens: transcriptTokens,
      totalTokens: transcriptTokens,
      metadata: {
        type: transcribeMeta.label || 'stt',
        estimatedTokens,
      },
    });
    await persistUsage();
  }
  logger.info('Transcription completed.', { provider: providerId, model: transcribeMeta.model });
  return result.text;
}

async function synthesiseSpeech(payload = {}, resolvedSettings = null) {
  const { text = '', provider, voice, language } = payload;
  const settings = resolvedSettings || await resolveTtsSettings({ provider, voice, language });
  const adapter = ensureTtsAdapterRegistration(settings.providerId);
  const effectiveVoice = settings.voice || (settings.type === 'cloud' ? 'alloy' : null);
  const languageCode = settings.languageCode || null;
  let synthesiseMetadata = null;
  let synthesiseProviderId = null;
  let providerCapabilities = null;
  let plan = null;
  let estimatedTokensForLimit = 0;

  if (adapter.type === 'cloud') {
    synthesiseProviderId = await getActiveProviderId(settings.providerId);
    providerCapabilities = resolveTtsProviderCapabilities(synthesiseProviderId);
    plan = createSpeechChunkPlan(text, providerCapabilities);
    const providerAdapter = await ensureAdapter(synthesiseProviderId);
    const costMetadata = getCostMetadata(providerAdapter) || {};
    synthesiseMetadata = costMetadata.synthesise || null;
  } else {
    plan = createLocalSpeechPlan(text);
  }

  const metrics = plan?.metrics || createSpeechMetrics(text);

  if (adapter.type === 'cloud') {
    estimatedTokensForLimit = Number.isFinite(metrics.deliveredTokenCount)
      ? Math.max(0, metrics.deliveredTokenCount)
      : 0;
    const fallbackEstimate = resolveFlatTokenEstimate(
      synthesiseMetadata,
      metrics.deliveredTokenCount,
    );
    if (!Number.isFinite(estimatedTokensForLimit) || estimatedTokensForLimit <= 0) {
      estimatedTokensForLimit = Math.max(0, fallbackEstimate);
    }
    if (costTracker && estimatedTokensForLimit > 0 && !costTracker.canSpend(estimatedTokensForLimit)) {
      logger.warn('Speech synthesis aborted due to token limit.', {
        estimatedTokens: estimatedTokensForLimit,
        provider: synthesiseProviderId,
      });
      throw new Error('Token limit reached for speech synthesis.');
    }
  }

  const chunks = Array.isArray(plan?.chunks) ? plan.chunks : [];
  const chunkCount = chunks.length;

  logger.info('Speech synthesis request received.', {
    provider: settings.providerId,
    adapterType: adapter.type,
    requestedProvider: provider,
    voice: effectiveVoice,
    language: languageCode,
    truncated: metrics.truncated,
    chunkCount,
  });

  if (adapter.type === 'cloud' && metrics.truncated) {
    logger.warn('Speech input exceeded provider limits; truncating request.', {
      originalTokens: metrics.originalTokenCount,
      deliveredTokens: metrics.deliveredTokenCount,
      omittedTokens: metrics.omittedTokenCount,
    });
  }

  const aggregatedChunks = [];
  let aggregatedMimeType = null;
  let responseProviderId = null;
  let usageLabelFromResponse = null;
  let lastResponse = null;

  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = chunks[index] || {};
    const chunkText = typeof chunk.text === 'string' ? chunk.text : '';
    const response = await adapter.synthesise({
      text: chunkText,
      voice: effectiveVoice || undefined,
      languageCode,
      chunkIndex: index,
      chunkCount,
      maxInputTokens: providerCapabilities?.maxInputTokens,
      model: synthesiseMetadata?.model || providerCapabilities?.model || undefined,
    });
    lastResponse = response;

    const base64Payload = typeof response?.base64 === 'string' ? response.base64 : null;
    if (base64Payload) {
      aggregatedChunks.push(base64ToUint8Array(base64Payload));
    } else if (response?.arrayBuffer instanceof ArrayBuffer) {
      aggregatedChunks.push(new Uint8Array(response.arrayBuffer));
    }

    if (!aggregatedMimeType && response?.mimeType) {
      aggregatedMimeType = response.mimeType;
    }
    if (!responseProviderId && response?.providerId) {
      responseProviderId = response.providerId;
    }
    if (!usageLabelFromResponse && response?.usageLabel) {
      usageLabelFromResponse = response.usageLabel;
    }

    const chunkTokens = Number.isFinite(chunk.tokenCount)
      ? chunk.tokenCount
      : tokeniseSpeechText(chunkText).length;
    emitTtsProgressEvent({
      provider: synthesiseProviderId || settings.providerId || 'auto',
      chunkIndex: index,
      chunkCount,
      estimatedTokens: chunkTokens,
    });
  }

  const mergedAudio = concatenateUint8Arrays(aggregatedChunks);
  const aggregatedBase64 = mergedAudio
    ? toBase64(mergedAudio.buffer)
    : (lastResponse?.base64 || null);

  const synthesisResult = {
    base64: aggregatedBase64,
    mimeType: aggregatedMimeType || lastResponse?.mimeType || 'audio/mpeg',
    providerId: responseProviderId
      || (adapter.type === 'local' ? 'local' : synthesiseProviderId || settings.providerId || 'auto'),
    usageLabel: usageLabelFromResponse || synthesiseMetadata?.label || null,
  };

  if (synthesisResult?.base64) {
    try {
      await playAudioFromBase64(synthesisResult.base64, synthesisResult.mimeType || 'audio/mpeg');
      logger.debug('Background audio playback started from base64 payload.');
    } catch (error) {
      logger.warn('Background audio playback failed; continuing without interruption.', { error });
    }
  } else {
    logger.debug('No base64 payload returned; skipping background playback.', {
      adapterType: adapter.type,
    });
  }

  const resolvedProvider = synthesisResult?.providerId
    || (adapter.type === 'local' ? 'local' : settings.providerId || 'auto');

  if (adapter.type === 'cloud') {
    if (!synthesiseMetadata || (synthesiseProviderId && resolvedProvider !== synthesiseProviderId)) {
      const providerAdapter = await ensureAdapter(resolvedProvider);
      const costMetadata = getCostMetadata(providerAdapter) || {};
      synthesiseMetadata = costMetadata.synthesise || null;
    }
    const usageLabel = synthesisResult?.usageLabel
      || synthesiseMetadata?.label
      || 'tts';
    const recordedTokensBase = Number.isFinite(metrics.deliveredTokenCount)
      ? Math.max(0, metrics.deliveredTokenCount)
      : 0;
    const recordedTokens = recordedTokensBase > 0
      ? recordedTokensBase
      : Math.max(0, resolveFlatTokenEstimate(synthesiseMetadata, estimatedTokensForLimit));
    if (costTracker && recordedTokens >= 0) {
      costTracker.recordFlat(usageLabel, {
        promptTokens: recordedTokens,
        totalTokens: recordedTokens,
        metadata: {
          type: usageLabel,
          truncated: metrics.truncated,
          deliveredTokenCount: metrics.deliveredTokenCount,
          omittedTokenCount: metrics.omittedTokenCount,
          chunkCount,
        },
      });
      await persistUsage();
    }
  }

  return {
    audio: {
      base64: synthesisResult?.base64 || null,
      mimeType: synthesisResult?.mimeType || 'audio/mpeg',
      truncated: metrics.truncated,
      originalTokenCount: metrics.originalTokenCount,
      deliveredTokenCount: metrics.deliveredTokenCount,
      omittedTokenCount: metrics.omittedTokenCount,
      chunkCount,
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
    tokens: result?.total_tokens,
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

/**
 * Return the current token usage snapshot.
 *
 * Args:
 *   None.
 *
 * Returns:
 *   A promise resolving to the serialised cost tracker state.
 *
 * Side Effects:
 *   Ensures the service worker has been initialised, which may hydrate caches
 *   and providers on first access.
 */
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
  'comet:setApiKey': createRuntimeHandler(
    'comet:setApiKey',
    ({ payload }) => setApiKey(payload.apiKey, { provider: payload?.provider }),
  ),
  'comet:getApiKey': createRuntimeHandler(
    'comet:getApiKey',
    ({ payload }) => getApiKey({ provider: payload?.provider }),
  ),
  'comet:getApiKeyDetails': createRuntimeHandler(
    'comet:getApiKeyDetails',
    ({ payload }) => getApiKeyDetails({ provider: payload?.provider }),
  ),
  'comet:setProvider': createRuntimeHandler(
    'comet:setProvider',
    ({ payload }) => setActiveProvider(payload?.provider),
  ),
  'comet:summarise': createRuntimeHandler('comet:summarise', handleSummariseRequest),
  'comet:transcribe': createRuntimeHandler('comet:transcribe', handleTranscriptionRequest),
  'comet:synthesise': createRuntimeHandler('comet:synthesise', handleSpeechRequest),
  'comet:getUsage': createRuntimeHandler('comet:getUsage', handleUsageRequest),
  'comet:resetUsage': createRuntimeHandler('comet:resetUsage', handleResetUsage),
  'comet:segmentsUpdated': createRuntimeHandler('comet:segmentsUpdated', handleSegmentsUpdated),
  'comet:getVoiceCapabilities': createRuntimeHandler(
    'comet:getVoiceCapabilities',
    ({ payload }) => resolveVoiceCapabilities(payload?.provider),
  ),
};

const handleRuntimeMessage = logger.wrap(
  (message, sender, sendResponse) => {
    const correlationId = ensureMessageCorrelation(message);
    const senderMeta = describeSender(sender);
    const backgroundMeta = getBackgroundContextMetadata();

    if (!message.type || !handlers[message.type]) {
      logger.warn('Received unsupported message.', {
        messageType: message?.type,
        ...backgroundMeta,
        ...senderMeta,
        ...withCorrelation(correlationId),
      });
      sendResponse({ success: false, result: null, error: 'Unsupported message type.', correlationId });
      return false;
    }

    logger.debug('Received background message.', {
      type: message.type,
      ...backgroundMeta,
      ...senderMeta,
      ...withCorrelation(correlationId),
    });

    const handler = handlers[message.type];
    const handlerPromise = Promise.resolve(handler(message, sender));

    handlerPromise
      .then(result => {
        logger.debug('Background message handled successfully.', {
          type: message.type,
          ...backgroundMeta,
          ...senderMeta,
          ...withCorrelation(correlationId),
        });
        sendResponse({ success: true, result, error: null, correlationId });
      })
      .catch(error => {
        const resolvedError = error instanceof Error ? error : new Error(String(error));
        logger.debug('Background message handler rejected.', {
          type: message.type,
          error: resolvedError,
          ...backgroundMeta,
          ...senderMeta,
          ...withCorrelation(correlationId),
        });
        sendResponse({ success: false, result: null, error: resolvedError.message, correlationId });
      });

    return true;
  },
  (incomingMessage, incomingSender) => {
    const message = normaliseRuntimeMessage(incomingMessage);
    const correlationId = ensureMessageCorrelation(message);
    return {
      component: logger.component,
      ...getBackgroundContextMetadata(),
      ...describeSender(incomingSender),
      ...withCorrelation(correlationId),
      messageType: message?.type,
      errorMessage: 'Background message handler threw synchronously.',
    };
  },
);

runtime.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = normaliseRuntimeMessage(rawMessage);
  return handleRuntimeMessage(message, sender, sendResponse);
});

/**
 * Inject a test adapter implementation.
 *
 * Args:
 *   providerId: The provider identifier whose adapter should be replaced.
 *   adapter: The adapter instance to expose during tests.
 *
 * Returns:
 *   None.
 *
 * Side Effects:
 *   Stores the override in the adapter map and replaces the active adapter if
 *   the specified provider is currently selected.
 */
function __setTestAdapterOverride(providerId, adapter) {
  if (typeof providerId !== 'string') {
    throw new Error('providerId must be a string');
  }
  testAdapterOverrides.set(providerId, adapter);
  if (activeProviderId === providerId) {
    adapterInstance = adapter;
  }
}

/**
 * Override the cost tracker used for usage accounting in tests.
 *
 * Args:
 *   tracker: A cost tracker compatible object. Falsy values remove the
 *     override.
 *
 * Returns:
 *   None.
 *
 * Side Effects:
 *   Replaces the global cost tracker, affecting future usage aggregation until
 *   cleared.
 */
function __setTestCostTrackerOverride(tracker) {
  testCostTrackerOverride = tracker;
  if (tracker) {
    costTracker = tracker;
  }
}

/**
 * Reset all test-specific overrides and cached state.
 *
 * Args:
 *   None.
 *
 * Returns:
 *   None.
 *
 * Side Effects:
 *   Clears adapter and cost tracker overrides, resets caches, routing, and
 *   provider metadata, and re-registers default TTS adapters.
 */
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

/**
 * Execute the transcription pipeline without service initialisation guards.
 *
 * Args:
 *   payload: Transcription request payload forwarded directly to the adapter.
 *
 * Returns:
 *   A promise resolving to the transcription result string.
 *
 * Side Effects:
 *   Uses the current adapter configuration and records usage through the cost
 *   tracker when transcription succeeds.
 */
async function __transcribeForTests(payload) {
  return transcribeAudio(payload);
}

/**
 * Execute the speech synthesis pipeline without modifying test state.
 *
 * Args:
 *   payload: Speech synthesis payload forwarded directly to the adapter.
 *
 * Returns:
 *   A promise resolving to the adapter-specific synthesis result.
 *
 * Side Effects:
 *   May invoke cloud adapters that record usage and persist token totals.
 */
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
