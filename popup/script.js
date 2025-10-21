import createLogger, { loadLoggingConfig, setGlobalContext } from '../utils/logger.js';
import { DEFAULT_TOKEN_LIMIT } from '../utils/cost.js';
import { availableLocales, setLocale, t } from '../utils/i18n.js';
import { createRecorder } from '../utils/audio.js';
import {
  DEFAULT_PROVIDER_ID,
  getProviderDisplayName,
  listProviders,
  normaliseProviderId,
  providerRequiresApiKey,
} from '../utils/providers.js';

/**
 * Popup controller responsible for coordinating UI state, background messages,
 * and media capture for the Comet Page Reader extension.
 *
 * @module popup/script
 */

// Escape special HTML characters in a string to prevent XSS
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const hasBrowserApi = typeof browser !== 'undefined';
const browserApi = hasBrowserApi ? browser : undefined;
const runtime = chrome?.runtime || browserApi?.runtime;
const tabsApi = chrome?.tabs || browserApi?.tabs;
const scriptingApi = chrome?.scripting || browserApi?.scripting;
const usesBrowserPromises =
  !!browserApi && runtime === browserApi.runtime && tabsApi === browserApi.tabs;

const MOCK_MODE = (() => {
  if (typeof globalThis !== 'undefined' && Object.prototype.hasOwnProperty.call(globalThis, '__COMET_MOCK_MODE__')) {
    return Boolean(globalThis.__COMET_MOCK_MODE__);
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env.COMET_MOCK_MODE !== 'undefined') {
    const value = process.env.COMET_MOCK_MODE;
    return value === '1' || value === 'true';
  }
  return false;
})();

const logger = createLogger({
  name: 'popup-ui',
  context: {
    mockMode: MOCK_MODE,
  },
});

setGlobalContext({ runtime: 'popup' });

function createCorrelationId(prefix = 'msg') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
const mockHandlers = {
  'comet:getApiKey': () => Promise.resolve('sk-mock-1234'),
  'comet:getApiKeyDetails': () =>
    Promise.resolve({
      apiKey: 'sk-mock-1234',
      provider: DEFAULT_PROVIDER_ID,
      requestedProvider: DEFAULT_PROVIDER_ID,
      lastUpdated: Date.now() - 30 * 1000,
    }),
  'comet:setApiKey': () => Promise.resolve(null),
  'comet:setProvider': () => Promise.resolve({ provider: DEFAULT_PROVIDER_ID }),
  'comet:getUsage': () =>
    Promise.resolve(
      withTokenSummary({
        totalPromptTokens: 1200,
        totalCompletionTokens: 800,
        totalTokens: 2000,
        cumulativePromptTokens: 1500,
        cumulativeCompletionTokens: 1000,
        cumulativeTotalTokens: 2500,
        limitTokens: DEFAULT_TOKEN_LIMIT,
        lastReset: Date.now() - 3600 * 1000,
      })
    ),
  'comet:resetUsage': () =>
    Promise.resolve(
      withTokenSummary({
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        cumulativePromptTokens: 0,
        cumulativeCompletionTokens: 0,
        cumulativeTotalTokens: 0,
        limitTokens: DEFAULT_TOKEN_LIMIT,
        lastReset: Date.now(),
      })
    ),
  'comet:summarise': () =>
    Promise.resolve({
      summaries: [
        {
          id: 'segment-1',
          summary: 'This is a mock summary returned without contacting the provider.',
        },
      ],
      usage: withTokenSummary({
        totalPromptTokens: 1200,
        totalCompletionTokens: 800,
        totalTokens: 2000,
        cumulativePromptTokens: 1500,
        cumulativeCompletionTokens: 1000,
        cumulativeTotalTokens: 2500,
        limitTokens: DEFAULT_TOKEN_LIMIT,
        lastReset: Date.now() - 3600 * 1000,
      }),
    }),
  'comet:synthesise': () =>
    Promise.resolve({
      audio: { base64: '', mimeType: 'audio/mpeg' },
      usage: withTokenSummary({
        totalPromptTokens: 1500,
        totalCompletionTokens: 800,
        totalTokens: 2300,
        cumulativePromptTokens: 1900,
        cumulativeCompletionTokens: 1100,
        cumulativeTotalTokens: 3000,
        limitTokens: DEFAULT_TOKEN_LIMIT,
        lastReset: Date.now() - 3600 * 1000,
      }),
    }),
  'comet:transcribe': () =>
    Promise.resolve({
      text: 'mock summary please',
      usage: withTokenSummary({
        totalPromptTokens: 1200,
        totalCompletionTokens: 900,
        totalTokens: 2100,
        cumulativePromptTokens: 1500,
        cumulativeCompletionTokens: 1200,
        cumulativeTotalTokens: 2700,
        limitTokens: DEFAULT_TOKEN_LIMIT,
        lastReset: Date.now(),
      }),
    }),
};

const DEFAULT_VOICE = 'alloy';
const DEFAULT_TTS_PROVIDER = 'localTTS';

const TTS_PROVIDER_OPTIONS = Object.freeze([
  Object.freeze({ id: 'googleTTS', label: 'Google Cloud Text-to-Speech' }),
  Object.freeze({ id: 'amazonPolly', label: 'Amazon Polly' }),
  Object.freeze({ id: 'localTTS', label: 'Browser (Local)' }),
]);

const CLOUD_TTS_VOICE_OPTIONS = Object.freeze({
  googleTTS: Object.freeze(['en-US-Neural2-A', 'en-GB-Neural2-C', 'es-ES-Neural2-B']),
  amazonPolly: Object.freeze(['Joanna', 'Matthew', 'Lupe', 'Amy']),
});

const ttsProviderLookup = Object.freeze(
  TTS_PROVIDER_OPTIONS.reduce((acc, option) => {
    acc[option.id.toLowerCase()] = option.id;
    return acc;
  }, {})
);

let localVoiceListenerAttached = false;

function normaliseTtsProviderId(value, fallback = DEFAULT_TTS_PROVIDER) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const lookupKey = trimmed.toLowerCase();
  return ttsProviderLookup[lookupKey] || fallback;
}

function getTtsProviderLabel(providerId) {
  const normalised = normaliseTtsProviderId(providerId, providerId);
  const option = TTS_PROVIDER_OPTIONS.find(candidate => candidate.id === normalised);
  return option ? option.label : formatVoiceLabel(normalised);
}

function storageLocalGet(keys) {
  if (!chrome?.storage?.local) {
    return Promise.resolve({});
  }
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(keys, items => {
        const err = chrome?.runtime?.lastError;
        if (err) {
          logger.debug('Failed to read from chrome.storage.local.', { error: err });
          resolve({});
          return;
        }
        resolve(items || {});
      });
    } catch (error) {
      logger.debug('chrome.storage.local.get threw unexpectedly.', { error });
      resolve({});
    }
  });
}

function storageLocalSet(items) {
  if (!chrome?.storage?.local) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    try {
      chrome.storage.local.set(items, () => {
        const err = chrome?.runtime?.lastError;
        if (err) {
          logger.debug('Failed to write to chrome.storage.local.', { error: err });
        }
        resolve();
      });
    } catch (error) {
      logger.debug('chrome.storage.local.set threw unexpectedly.', { error });
      resolve();
    }
  });
}

const state = {
  summaries: [],
  audio: null,
  audioSourceUrl: null,
  language: 'en',
  voice: DEFAULT_VOICE,
  voiceOptions: [],
  voicePreferred: null,
  pendingVoicePreference: null,
  playbackRate: 1,
  provider: DEFAULT_PROVIDER_ID,
  providerLastSynced: null,
  providerOptions: listProviders().map(option => option.id),
  ttsProvider: DEFAULT_TTS_PROVIDER,
  recorder: null,
  mediaStream: null,
  playbackController: null,
  ttsProgress: null,
};

const elements = {};

/**
 * Retrieves a DOM element by ID and throws when not found to surface template
 * regressions early during development.
 *
 * @param {string} id - Element ID.
 * @returns {HTMLElement} Matched element.
 */
function qs(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing required element: ${id}`);
  }
  return node;
}

/**
 * Captures the DOM nodes used by the popup to avoid repeated lookups.
 */
function assignElements() {
  elements.apiForm = qs('api-form');
  elements.providerLabel = qs('providerLabel');
  elements.provider = qs('providerSelect');
  elements.apiKeyLabel = qs('apiKeyLabel');
  elements.apiKey = qs('apiKey');
  elements.apiKeyMeta = qs('apiKeyMeta');
  elements.language = qs('languageSelect');
  elements.ttsProvider = qs('ttsProviderSelect');
  elements.voice = qs('ttsVoiceSelect');
  elements.saveSpeechSettings = qs('saveSpeechSettingsBtn');
  elements.playbackRateLabel = qs('playbackRateLabel');
  elements.playbackRate = qs('playbackRateSelect');
  elements.summarise = qs('summariseBtn');
  elements.read = qs('readBtn');
  elements.readPage = qs('readPageBtn');
  elements.pushToTalk = qs('pushToTalkBtn');
  elements.recordingStatus = qs('recordingStatus');
  elements.play = qs('playBtn');
  elements.pause = qs('pauseBtn');
  elements.stop = qs('stopBtn');
  elements.usage = qs('usageDetails');
  elements.resetUsage = qs('resetUsageBtn');
  elements.usageRowTemplate = document.getElementById('usageRowTemplate');
  if (elements.playbackRate) {
    elements.playbackRate.value = String(state.playbackRate);
  }
  if (elements.voice) {
    elements.voice.value = state.voice;
  }
}

function getVoiceOptions() {
  return state.voiceOptions.slice();
}

async function persistVoicePreference(voice) {
  await storageLocalSet({ ttsVoice: voice });
}

function normaliseVoiceValues(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(values
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)));
}

function formatVoiceLabel(voice) {
  const spaced = voice.replace(/[_-]+/g, ' ');
  return spaced.replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

function renderVoiceSelectOptions(voices) {
  if (!elements.voice) {
    return;
  }
  const voiceSelect = elements.voice;
  if (!Array.isArray(voices) || voices.length === 0) {
    voiceSelect.innerHTML = '';
    voiceSelect.value = '';
    voiceSelect.disabled = true;
    return;
  }
  voiceSelect.disabled = false;
  const markup = voices
    .map(voice => `<option value="${escapeHtml(voice)}">${escapeHtml(formatVoiceLabel(voice))}</option>`)
    .join('');
  voiceSelect.innerHTML = markup;
}

function renderTtsProviderOptions(selectedId = state.ttsProvider) {
  if (!elements.ttsProvider) {
    return;
  }
  const markup = TTS_PROVIDER_OPTIONS.map(option => {
    const value = escapeHtml(option.id);
    const label = escapeHtml(option.label);
    return `<option value="${value}">${label}</option>`;
  }).join('');
  elements.ttsProvider.innerHTML = markup;
  const chosen = normaliseTtsProviderId(selectedId);
  elements.ttsProvider.value = chosen;
  state.ttsProvider = chosen;
}

function getLocalSpeechVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return [];
  }
  try {
    const voices = window.speechSynthesis.getVoices?.() || [];
    if (!Array.isArray(voices)) {
      return [];
    }
    return normaliseVoiceValues(
      voices
        .map(entry => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
        .filter(Boolean)
    );
  } catch (error) {
    logger.debug('Failed to read local speech synthesis voices.', { error });
    return [];
  }
}

async function resolveVoicesForProvider(providerId = state.ttsProvider) {
  const normalised = normaliseTtsProviderId(providerId);
  if (normalised === 'localTTS') {
    return getLocalSpeechVoices();
  }
  const catalogue = CLOUD_TTS_VOICE_OPTIONS[normalised];
  if (Array.isArray(catalogue)) {
    return normaliseVoiceValues(catalogue);
  }
  return [];
}

function ensureLocalVoiceListener() {
  if (localVoiceListenerAttached) {
    return;
  }
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return;
  }
  const handler = () => {
    if (state.ttsProvider === 'localTTS') {
      refreshVoiceOptions('localTTS', { persistFallback: true });
    }
  };
  try {
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', handler);
    } else {
      window.speechSynthesis.onvoiceschanged = handler;
    }
    localVoiceListenerAttached = true;
  } catch (error) {
    logger.debug('Failed to attach voiceschanged listener.', { error });
  }
}

function resolveSpeechProviderForBackground(providerId = state.ttsProvider) {
  const normalised = normaliseTtsProviderId(providerId);
  if (normalised === 'localTTS') {
    return 'local';
  }
  if (normalised === 'googleTTS') {
    return 'googleTTS';
  }
  if (normalised === 'amazonPolly') {
    return 'amazonPolly';
  }
  return 'auto';
}

async function applyVoiceCapabilities(metadata = null, options = {}) {
  const persistFallback = options.persistFallback !== false;
  const voiceData = metadata || {
    availableVoices: state.voiceOptions,
    preferredVoice: state.voicePreferred,
  };
  const availableVoices = normaliseVoiceValues(voiceData?.availableVoices);
  const preferredVoice = typeof voiceData?.preferredVoice === 'string'
    && availableVoices.includes(voiceData.preferredVoice)
    ? voiceData.preferredVoice
    : null;
  state.voiceOptions = availableVoices;
  state.voicePreferred = preferredVoice;
  renderVoiceSelectOptions(availableVoices);

  if (availableVoices.length === 0) {
    if (elements.voice) {
      elements.voice.value = '';
    }
    state.pendingVoicePreference = null;
    return '';
  }

  const pending = typeof state.pendingVoicePreference === 'string'
    ? state.pendingVoicePreference
    : null;
  let resolvedVoice = null;
  if (pending && availableVoices.includes(pending)) {
    resolvedVoice = pending;
  } else if (state.voice && availableVoices.includes(state.voice)) {
    resolvedVoice = state.voice;
  } else if (preferredVoice) {
    resolvedVoice = preferredVoice;
  } else {
    resolvedVoice = availableVoices[0];
  }

  state.voice = resolvedVoice;
  if (elements.voice) {
    elements.voice.value = resolvedVoice;
  }

  if (pending && persistFallback && pending !== resolvedVoice) {
    await persistVoicePreference(resolvedVoice);
  }
  if (pending !== null) {
    state.pendingVoicePreference = null;
  }
  return resolvedVoice;
}

async function refreshVoiceOptions(providerId = state.ttsProvider, options = {}) {
  const normalised = normaliseTtsProviderId(providerId);
  state.ttsProvider = normalised;
  logger.debug('Refreshing TTS voice catalogue.', { provider: normalised });
  try {
    const availableVoices = await resolveVoicesForProvider(normalised);
    await applyVoiceCapabilities({ availableVoices, preferredVoice: state.voice }, options);
  } catch (error) {
    logger.warn('Failed to refresh TTS voice catalogue.', { error, provider: normalised });
    await applyVoiceCapabilities({ availableVoices: [], preferredVoice: null }, options);
  }
}

/**
 * Applies the currently selected locale to all visible UI strings.
 */
function translateUi() {
  if (elements.providerLabel) {
    elements.providerLabel.textContent = t('providerLabel');
  }
  if (elements.apiKeyLabel) {
    elements.apiKeyLabel.textContent = t('apiKeyLabel');
  }
  if (elements.playbackRateLabel) {
    elements.playbackRateLabel.textContent = t('playbackSpeedLabel');
  }
  elements.summarise.textContent = t('summarise');
  elements.read.textContent = t('readAloud');
  elements.readPage.textContent = t('readPage');
  elements.pushToTalk.textContent = t('pushToTalk');
  elements.resetUsage.textContent = t('resetUsage');
  const usageHeading = document.querySelector('#usage-section');
  if (usageHeading) {
    usageHeading.textContent = t('usage');
  }
  const disclaimer = document.querySelector('.disclaimer p');
  if (disclaimer) {
    disclaimer.textContent = t('disclaimer');
  }
}

function applyApiKeyRequirement() {
  if (!elements.apiKey) {
    return;
  }
  const requiresKey = providerRequiresApiKey(state.provider);
  if (requiresKey) {
    if (typeof elements.apiKey.setAttribute === 'function') {
      elements.apiKey.setAttribute('required', '');
      elements.apiKey.setAttribute('aria-required', 'true');
    }
  } else {
    if (typeof elements.apiKey.removeAttribute === 'function') {
      elements.apiKey.removeAttribute('required');
    }
    if (typeof elements.apiKey.setAttribute === 'function') {
      elements.apiKey.setAttribute('aria-required', 'false');
    }
  }
  if ('required' in elements.apiKey) {
    elements.apiKey.required = requiresKey;
  }
}

function readSupportedProvidersFromComment(source) {
  if (typeof source !== 'string') {
    return [];
  }
  const commentMatch = source.match(/#\s*Supported providers:\s*([^\n]+)/i);
  if (!commentMatch) {
    return [];
  }
  return commentMatch[1]
    .split(',')
    .map(value => normaliseProviderId(value))
    .filter((value, index, array) => value && array.indexOf(value) === index);
}

async function readAgentProviderMetadata() {
  if (!runtime?.getURL || typeof fetch !== 'function') {
    return {};
  }
  try {
    logger.debug('Loading provider metadata from agent.yaml.');
    const response = await fetch(runtime.getURL('agent.yaml'));
    if (!response.ok) {
      logger.warn('agent.yaml request did not return a successful response.', {
        status: response.status,
      });
      return {};
    }
    const text = await response.text();
    const providerMatch = text.match(/^\s*provider:\s*([^\s#]+)/mi);
    const defaultProvider = providerMatch ? normaliseProviderId(providerMatch[1]) : undefined;
    const supportedProviders = readSupportedProvidersFromComment(text);
    return { defaultProvider, supportedProviders };
  } catch (error) {
    logger.debug('Failed to load provider metadata from agent.yaml.', { error });
    return {};
  }
}

function renderProviderOptions(optionIds, selectedId) {
  if (!elements.provider) {
    return;
  }
  const uniqueIds = optionIds
    .map(id => normaliseProviderId(id))
    .filter((id, index, array) => id && array.indexOf(id) === index);
  if (uniqueIds.length === 0) {
    uniqueIds.push(DEFAULT_PROVIDER_ID);
  }
  // Escape both id (for attribute) and display name (for text content)
  const markup = uniqueIds
    .map(id => `<option value="${escapeHtml(id)}">${escapeHtml(getProviderDisplayName(id))}</option>`)
    .join('');
  elements.provider.innerHTML = markup;
  const chosen = uniqueIds.includes(selectedId) ? selectedId : uniqueIds[0];
  elements.provider.value = chosen;
  state.providerOptions = uniqueIds;
  state.provider = chosen;
  applyApiKeyRequirement();
}

function ensureProviderOption(providerId) {
  const normalised = normaliseProviderId(providerId, state.provider);
  if (state.providerOptions.includes(normalised)) {
    return;
  }
  const updated = [...state.providerOptions, normalised];
  renderProviderOptions(updated, normalised);
}

async function setAndSyncProvider(providerId) {
  const normalised = normaliseProviderId(providerId, state.provider);
  if (!normalised || state.providerLastSynced === normalised) {
    return;
  }
  logger.debug('Synchronising provider selection with background.', {
    nextProvider: normalised,
    previousProvider: state.providerLastSynced,
  });
  if (state.pendingVoicePreference === null && typeof state.voice === 'string' && state.voice.length > 0) {
    state.pendingVoicePreference = state.voice;
  }
  const response = await sendMessage('comet:setProvider', { provider: normalised });
  if (response?.voice) {
    await applyVoiceCapabilities(response.voice, { persistFallback: true });
  } else {
    await refreshVoiceOptions(normalised, { persistFallback: true });
  }
  state.providerLastSynced = normalised;
}

async function hydrateProviderSelector() {
  if (!elements.provider) {
    return;
  }
  logger.debug('Hydrating provider selector options.');
  const { defaultProvider, supportedProviders } = await readAgentProviderMetadata();
  const knownProviders = listProviders().map(provider => provider.id);
  let optionIds = knownProviders;
  if (supportedProviders && supportedProviders.length > 0) {
    const filtered = knownProviders.filter(providerId => supportedProviders.includes(providerId));
    if (filtered.length > 0) {
      optionIds = filtered;
    }
  }
  const initialSelection = optionIds.includes(state.provider)
    ? state.provider
    : defaultProvider && optionIds.includes(defaultProvider)
      ? defaultProvider
      : optionIds[0];
  renderProviderOptions(optionIds, initialSelection || DEFAULT_PROVIDER_ID);
  const nextProvider = elements.provider.value;
  if (state.providerLastSynced !== nextProvider) {
    try {
      await setAndSyncProvider(nextProvider);
    } catch (error) {
      logger.warn('Failed to synchronise provider selection during hydration.', { error });
    }
  }
  logger.debug('Provider selector hydrated.', {
    optionCount: optionIds.length,
    initialSelection: initialSelection || DEFAULT_PROVIDER_ID,
  });
}

/**
 * Updates the status element used for inline user feedback.
 *
 * @param {string} message - Text content to display.
 */
function setStatus(message) {
  elements.recordingStatus.textContent = message || '';
}

function setPlaybackReady() {
  elements.play.disabled = false;
  elements.pause.disabled = true;
  elements.stop.disabled = true;
}

function setPlaybackActive() {
  elements.play.disabled = true;
  elements.pause.disabled = false;
  elements.stop.disabled = false;
}

function setPlaybackLoading() {
  elements.play.disabled = true;
  elements.pause.disabled = true;
  elements.stop.disabled = false;
}

function createPlaybackController() {
  let cancelled = false;
  const listeners = new Set();

  return {
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      listeners.forEach(listener => {
        try {
          listener();
        } catch (error) {
          logger.debug('Playback cancellation handler failed.', { error });
        }
      });
      listeners.clear();
    },
    onCancel(listener) {
      if (cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get cancelled() {
      return cancelled;
    },
  };
}

const TTS_PROGRESS_MESSAGE_TYPES = new Set(['comet:tts_progress', 'comet:tts:progress']);

if (runtime?.onMessage && typeof runtime.onMessage.addListener === 'function') {
  runtime.onMessage.addListener(message => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (TTS_PROGRESS_MESSAGE_TYPES.has(message.type)) {
      try {
        handleTtsProgressMessage(message.payload);
      } catch (error) {
        logger.debug('Failed to process TTS progress message.', { error });
      }
    }
  });
}

function clearTtsProgress() {
  state.ttsProgress = null;
}

function beginTtsProgress(context, details = {}) {
  state.ttsProgress = {
    context,
    segmentIndex: Number.isFinite(details.segmentIndex) ? details.segmentIndex : null,
    segmentTotal:
      Number.isFinite(details.segmentTotal) && details.segmentTotal > 0
        ? details.segmentTotal
        : null,
  };
  setStatus(formatTtsProgressStatusMessage());
}

function formatTtsProgressStatusMessage(chunkIndex = null, chunkCount = null) {
  let message = 'Generating audio…';
  if (Number.isFinite(chunkIndex) && Number.isFinite(chunkCount) && chunkCount > 0) {
    const current = Math.min(chunkCount, Math.max(0, chunkIndex)) + 1;
    message = `Generating audio ${current}/${chunkCount}…`;
  }

  const progress = state.ttsProgress;
  if (
    progress?.context === 'full-page' &&
    Number.isFinite(progress.segmentIndex) &&
    Number.isFinite(progress.segmentTotal) &&
    progress.segmentTotal > 0
  ) {
    const currentSegment = Math.min(progress.segmentTotal, Math.max(0, progress.segmentIndex)) + 1;
    message = `Segment ${currentSegment}/${progress.segmentTotal}: ${message}`;
  }

  return message;
}

function handleTtsProgressMessage(payload) {
  if (!state.ttsProgress) {
    return;
  }
  if (!payload || typeof payload !== 'object') {
    setStatus(formatTtsProgressStatusMessage());
    return;
  }
  const chunkIndex = Number.isFinite(payload.chunkIndex) ? payload.chunkIndex : null;
  const chunkCount = Number.isFinite(payload.chunkCount) ? payload.chunkCount : null;
  setStatus(formatTtsProgressStatusMessage(chunkIndex, chunkCount));
}

function revokeAudioSource() {
  if (
    state.audioSourceUrl &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    try {
      URL.revokeObjectURL(state.audioSourceUrl);
    } catch (error) {
      logger.debug('Failed to revoke audio URL.', { error });
    }
  }
  state.audioSourceUrl = null;
}

function decodeBase64Audio(base64) {
  if (!base64) {
    return new Uint8Array();
  }
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('Base64 decoding is not supported in this environment.');
}

/**
 * Wraps event handlers to provide consistent error handling and prevent
 * repetitive boilerplate.
 *
 * @template T
 * @param {Function} handler - Async handler invoked in response to an event.
 * @returns {Function} Decorated handler that reports errors via setStatus.
 */
const DOM_EXCEPTION_FRIENDLY_MESSAGES = {
  NotAllowedError: 'Microphone access was blocked. Allow microphone access and try again.',
  NotFoundError: 'No microphone was found. Check your input device and try again.',
  NotReadableError:
    'The microphone is already in use. Close other applications that might be using it and try again.',
  AbortError: 'Recording was interrupted before it could finish. Try again.',
  SecurityError: 'Microphone access is blocked by your browser. Update the permission settings and retry.',
};

function resolveStatusMessage(error, fallbackMessage = 'Something went wrong.') {
  if (!error) {
    return fallbackMessage;
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : fallbackMessage;
  }

  const rawMessage = typeof error.message === 'string' ? error.message.trim() : '';
  if (rawMessage && rawMessage !== '[object DOMException]') {
    return rawMessage;
  }

  const isDomException =
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException;
  if (isDomException) {
    const friendly = DOM_EXCEPTION_FRIENDLY_MESSAGES[error.name];
    if (friendly) {
      return friendly;
    }
    if (typeof error.name === 'string') {
      const trimmedName = error.name.trim();
      if (trimmedName.length > 0 && trimmedName !== 'Error') {
        return `Request failed: ${trimmedName}`;
      }
    }
  }

  if (typeof error.name === 'string') {
    const trimmedName = error.name.trim();
    if (trimmedName.length > 0 && trimmedName !== 'Error') {
      return trimmedName;
    }
  }

  try {
    const stringified = String(error);
    const trimmed = stringified.trim();
    if (
      trimmed &&
      trimmed !== '[object Object]' &&
      trimmed !== '[object DOMException]' &&
      trimmed !== 'Error'
    ) {
      return trimmed;
    }
  } catch (stringifyError) {
    logger.debug('Failed to stringify error for status message.', { error: stringifyError });
  }

  return fallbackMessage;
}

function withErrorHandling(handler) {
  return async event => {
    event?.preventDefault?.();
    try {
      await handler(event);
    } catch (error) {
      logger.error('Popup handler failed.', {
        error,
        handler: typeof handler === 'function' ? handler.name : undefined,
      });
      setStatus(resolveStatusMessage(error));
    }
  };
}

function getRuntimeLastError() {
  const chromeLastError = chrome?.runtime?.lastError;
  if (chromeLastError) {
    return chromeLastError;
  }
  if (!hasBrowserApi) {
    return undefined;
  }
  return browserApi?.runtime?.lastError;
}

const CONTEXT_INVALIDATED_PATTERN = /Extension context invalidated/i;

function isContextInvalidatedError(error) {
  if (!error) {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : String(error);
  return CONTEXT_INVALIDATED_PATTERN.test(message);
}

function createContextInvalidatedError() {
  return new Error('The extension was reloaded. Close and reopen the popup to continue.');
}

function normaliseError(error, fallbackMessage = 'Background request failed.') {
  if (isContextInvalidatedError(error)) {
    return createContextInvalidatedError();
  }
  const message = typeof error?.message === 'string' && error.message.trim().length > 0
    ? error.message
    : fallbackMessage;
  return new Error(message);
}

function responseIndicatesSuccess(response) {
  if (!response || typeof response !== 'object') {
    return false;
  }
  if (typeof response.success === 'boolean') {
    return response.success;
  }
  if (typeof response.ok === 'boolean') {
    return response.ok;
  }
  return Boolean(response.success);
}

/**
 * Sends a message to the background service worker, supporting both Chrome
 * callbacks and Firefox promises. Falls back to local mocks when MOCK_MODE is
 * enabled.
 *
 * @param {string} type - Message type handled by the background worker.
 * @param {Object} [payload] - Payload forwarded to the worker.
 * @returns {Promise<*>} Background response result.
 */
function sendMessage(type, payload) {
  const correlationId = createCorrelationId('bg');
  const metadata = {
    type,
    hasPayload: Boolean(payload),
    correlationId,
  };
  logger.debug('Dispatching message to background worker.', metadata);
  if (MOCK_MODE && mockHandlers[type]) {
    try {
      const result = mockHandlers[type](payload);
      if (result && typeof result.then === 'function') {
        return result
          .then(value => {
            logger.debug('Mock background message resolved.', { ...metadata });
            return value;
          })
          .catch(error => {
            logger.error('Mock background message rejected.', { ...metadata, error });
            throw normaliseError(error);
          });
      }
      logger.debug('Mock background message resolved synchronously.', { ...metadata });
      return result;
    } catch (error) {
      logger.error('Mock background message threw synchronously.', { ...metadata, error });
      throw normaliseError(error);
    }
  }
  const payloadMessage = { type, payload };
  if (usesBrowserPromises) {
    return runtime
      .sendMessage(payloadMessage)
      .then(response => {
        if (!response) {
          throw new Error('No response from background script.');
        }
        if (!responseIndicatesSuccess(response)) {
          throw new Error(response.error || 'Request failed.');
        }
        logger.debug('Background message resolved.', { ...metadata });
        return response.result;
      })
      .catch(error => {
        logger.error('Background message rejected.', { ...metadata, error });
        throw normaliseError(error);
      });
  }

  return new Promise((resolve, reject) => {
    try {
      const maybePromise = runtime.sendMessage(payloadMessage, response => {
        const lastError = getRuntimeLastError();
        if (lastError) {
          logger.error('Background message rejected via callback.', { ...metadata, error: lastError });
          reject(normaliseError(lastError));
          return;
        }
        if (!response) {
          const error = new Error('No response from background script.');
          logger.error('Background message received empty response.', { ...metadata, error });
          reject(error);
          return;
        }
        if (!responseIndicatesSuccess(response)) {
          const error = new Error(response.error || 'Request failed.');
          logger.error('Background message returned error response.', { ...metadata, error });
          reject(error);
          return;
        }
        logger.debug('Background message resolved via callback.', { ...metadata });
        resolve(response.result);
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(error => {
          logger.error('Background message promise rejected.', { ...metadata, error });
          reject(normaliseError(error));
        });
      }
    } catch (error) {
      logger.error('Background message send threw synchronously.', { ...metadata, error });
      reject(normaliseError(error));
    }
  });
}

/**
 * Loads the persisted API key from the background worker and updates the form.
 *
 * @returns {Promise<void>} Resolves once the value is populated.
 */
async function loadApiKey(options = {}) {
  const payload = {};
  if (options.provider) {
    payload.provider = options.provider;
  }
  logger.debug('Loading API key details.', {
    provider: payload.provider || state.provider,
  });
  const response = await sendMessage('comet:getApiKeyDetails', payload);
  renderApiKeyDetails(response);
  logger.debug('API key details loaded.', {
    provider: payload.provider || state.provider,
    hasKey: Boolean(response?.apiKey),
  });
}

/**
 * Persists the API key entered by the user.
 *
 * @returns {Promise<void>} Resolves after the key is saved.
 */
async function saveApiKey(event) {
  const apiKey = elements.apiKey.value.trim();
  const payload = { apiKey, provider: state.provider };
  logger.info('Persisting API key update.', {
    provider: state.provider,
    provided: Boolean(apiKey),
  });
  await sendMessage('comet:setApiKey', payload);
  await loadApiKey({ provider: state.provider });
  const providerName = getProviderDisplayName(state.provider);
  if (!apiKey) {
    if (providerRequiresApiKey(state.provider)) {
      setStatus(`${providerName} API key removed.`);
    } else {
      setStatus(`${providerName} will use local access.`);
    }
    return;
  }
  setStatus(`${providerName} API key saved securely.`);
}

async function handleProviderChange(event) {
  const providerId = normaliseProviderId(event.target?.value, state.provider);
  const previousProvider = state.provider;
  logger.info('Provider selection changed.', {
    previousProvider,
    nextProvider: providerId,
  });
  ensureProviderOption(providerId);
  if (elements.provider) {
    elements.provider.value = providerId;
  }
  if (providerId === previousProvider) {
    state.provider = providerId;
    applyApiKeyRequirement();
    return;
  }
  state.provider = providerId;
  applyApiKeyRequirement();
  state.pendingVoicePreference = state.voice;
  await setAndSyncProvider(providerId);
  await loadApiKey({ provider: providerId });
  const providerName = getProviderDisplayName(providerId);
  if (providerRequiresApiKey(providerId)) {
    setStatus(`${providerName} selected. Enter an API key to enable requests.`);
  } else {
    setStatus(`${providerName} selected. API key is optional.`);
  }
}

async function handleTtsProviderChange(event) {
  const providerId = normaliseTtsProviderId(event.target?.value, state.ttsProvider);
  const previousProvider = state.ttsProvider;
  logger.info('TTS provider selection changed.', {
    previousProvider,
    nextProvider: providerId,
  });
  state.ttsProvider = providerId;
  if (elements.ttsProvider) {
    elements.ttsProvider.value = providerId;
  }
  state.pendingVoicePreference = state.voice;
  if (providerId === previousProvider) {
    return;
  }
  await refreshVoiceOptions(providerId, { persistFallback: true });
  setStatus(`${getTtsProviderLabel(providerId)} selected.`);
}

/**
 * Formats a timestamp for display using the runtime locale.
 *
 * @param {number|null|undefined} timestamp - Millisecond timestamp.
 * @returns {string} Localised date string or empty string when unavailable.
 */
function formatLastUpdated(timestamp) {
  if (typeof timestamp !== 'number') {
    return '';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
}

/**
 * Updates the API key metadata hint based on the background response.
 *
 * @param {{apiKey?: string|null, lastUpdated?: number|null}|string} details -
 *   Persisted API key payload.
 */
function renderApiKeyDetails(details) {
  const normalised = details || {};
  const requested = normalised.requestedProvider || normalised.provider;
  const providerId = normaliseProviderId(requested, state.provider);
  ensureProviderOption(providerId);
  if (elements.provider) {
    elements.provider.value = providerId;
  }
  state.provider = providerId;
  state.providerLastSynced = providerId;
  applyApiKeyRequirement();

  const hasKey = typeof normalised.apiKey === 'string' && normalised.apiKey.trim().length > 0;
  const providerName = getProviderDisplayName(providerId);
  const requiresKey = providerRequiresApiKey(providerId);

  if (hasKey) {
    elements.apiKey.value = normalised.apiKey;
    const formatted = formatLastUpdated(normalised.lastUpdated);
    const prefix = `${providerName} API key saved`;
    elements.apiKeyMeta.textContent = formatted
      ? `${prefix}. Last updated: ${formatted}.`
      : `${prefix}. Last update time unavailable.`;
    elements.apiKeyMeta.dataset.state = 'ready';
    return;
  }

  elements.apiKey.value = '';
  if (requiresKey) {
    elements.apiKeyMeta.textContent = `No ${providerName} API key saved.`;
    elements.apiKeyMeta.dataset.state = 'empty';
  } else {
    elements.apiKeyMeta.textContent = `${providerName} does not require an API key.`;
    elements.apiKeyMeta.dataset.state = 'optional';
  }
}

/**
 * Queries the active browser window for tabs using the appropriate API style.
 *
 * @param {Object} options - Tab query parameters.
 * @returns {Promise<chrome.tabs.Tab[]>} Matched tabs.
 */
function queryTabs(options) {
  if (usesBrowserPromises) {
    return tabsApi.query(options);
  }
  return new Promise((resolve, reject) => {
    try {
      tabsApi.query(options, tabs => {
        const lastError = getRuntimeLastError();
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(tabs);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Sends a runtime message to a content script using the correct API flavour.
 *
 * @param {number} tabId - Tab identifier.
 * @param {Object} message - Message delivered to the content script.
 * @returns {Promise<*>} Content script response.
 */
const injectedContentTabs = new Set();

function dispatchTabMessage(tabId, message) {
  if (usesBrowserPromises) {
    return tabsApi.sendMessage(tabId, message);
  }
  return new Promise((resolve, reject) => {
    try {
      tabsApi.sendMessage(tabId, message, response => {
        const lastError = getRuntimeLastError();
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function shouldRetryWithInjection(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  return /Receiving end does not exist|No tab with id/i.test(error.message);
}

function isAccessDeniedError(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  return /Cannot access contents of url|The extensions gallery cannot be scripted/i.test(
    error.message
  );
}

function executeContentScript(tabId) {
  if (injectedContentTabs.has(tabId)) {
    return Promise.resolve();
  }

  const markInjected = () => {
    injectedContentTabs.add(tabId);
  };

  if (scriptingApi?.executeScript) {
    if (usesBrowserPromises) {
      return scriptingApi
        .executeScript({
          target: { tabId },
          files: ['content/content.js'],
        })
        .then(markInjected);
    }
    return new Promise((resolve, reject) => {
      try {
        scriptingApi.executeScript(
          {
            target: { tabId },
            files: ['content/content.js'],
          },
          () => {
            const lastError = getRuntimeLastError();
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            markInjected();
            resolve();
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  if (typeof tabsApi?.executeScript === 'function') {
    if (usesBrowserPromises) {
      return tabsApi
        .executeScript(tabId, {
          file: 'content/content.js',
        })
        .then(markInjected);
    }
    return new Promise((resolve, reject) => {
      try {
        tabsApi.executeScript(
          tabId,
          {
            file: 'content/content.js',
          },
          () => {
            const lastError = getRuntimeLastError();
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            markInjected();
            resolve();
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  return Promise.reject(new Error('Content script injection is not supported in this browser.'));
}

async function sendMessageToTab(tabId, message) {
  try {
    return await dispatchTabMessage(tabId, message);
  } catch (error) {
    if (!shouldRetryWithInjection(error)) {
      throw error;
    }

    try {
      await executeContentScript(tabId);
    } catch (injectionError) {
      if (isAccessDeniedError(injectionError)) {
        throw new Error('Comet Page Reader cannot run on this page. Try a different tab.');
      }
      throw injectionError;
    }

    try {
      return await dispatchTabMessage(tabId, message);
    } catch (retryError) {
      if (shouldRetryWithInjection(retryError)) {
        throw new Error('Unable to communicate with this page. Refresh and try again.');
      }
      throw retryError;
    }
  }
}

/**
 * Resolves the ID of the currently active tab.
 *
 * @returns {Promise<number>} Active tab identifier.
 */
const UNSUPPORTED_TAB_URL_PATTERN = /^(?:about|brave|chrome|chrome-extension|chrome-devtools|edge|moz-extension|opera|vivaldi):/i;
const UNSUPPORTED_TAB_MESSAGE =
  'Comet Page Reader cannot run on this page. Switch to a different tab and try again.';

function normaliseTabUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }
  return url.trim();
}

function resolveTabUrl(tab) {
  if (!tab || typeof tab !== 'object') {
    return '';
  }
  const candidates = [tab.url, tab.pendingUrl];
  for (const candidate of candidates) {
    const normalised = normaliseTabUrl(candidate);
    if (normalised) {
      return normalised;
    }
  }
  return '';
}

function isTabUrlSupported(url) {
  const normalised = normaliseTabUrl(url);
  if (!normalised) {
    return false;
  }
  return !UNSUPPORTED_TAB_URL_PATTERN.test(normalised);
}

function resolveSupportedTabUrl(tab) {
  if (!tab) {
    return '';
  }

  const candidates = [tab.url, tab.pendingUrl];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalised = normaliseTabUrl(candidate);
    if (normalised && isTabUrlSupported(normalised)) {
      return normalised;
    }
  }

  return '';
}

function ensureSupportedTab(tab) {
  const supportedUrl = resolveSupportedTabUrl(tab);
  if (!tab || typeof tab.id !== 'number' || !supportedUrl || !isTabUrlSupported(supportedUrl)) {
    throw new Error(UNSUPPORTED_TAB_MESSAGE);
  }

  if (tab.url === supportedUrl) {
    return tab;
  }

  return { ...tab, url: supportedUrl };
}

async function getActiveTabId() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  if (!tabs.length) {
    throw new Error('No active tab detected.');
  }
  const activeTab = ensureSupportedTab(tabs[0]);
  return activeTab.id;
}

/**
 * Requests pre-processed text segments from the content script.
 *
 * @param {number} tabId - Tab identifier.
 * @returns {Promise<{url: string, segments: Array}>} Segment payload.
 */
async function fetchSegments(tabId) {
  const response = await sendMessageToTab(tabId, { type: 'comet:getSegments' });
  if (!response || !response.ok) {
    throw new Error('Unable to read page content.');
  }
  return response.result;
}

function formatTokens(value, fallback = '0') {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return value.toLocaleString?.() ?? String(value);
}

function withTokenSummary(usage) {
  if (!usage || typeof usage !== 'object') {
    return usage;
  }
  const snapshot = { ...usage };
  const existing = typeof usage.tokens === 'object' && usage.tokens !== null
    ? usage.tokens
    : {};
  snapshot.tokens = {
    prompt: usage.totalPromptTokens ?? existing.prompt ?? 0,
    completion: usage.totalCompletionTokens ?? existing.completion ?? 0,
    total: usage.totalTokens ?? existing.total ?? 0,
    lastReset: usage.lastReset ?? existing.lastReset ?? null,
  };
  return snapshot;
}

/**
 * Renders usage statistics in the popup.
 *
 * @param {{limitTokens?: number, totalTokens?: number, totalPromptTokens?: number,
 *   totalCompletionTokens?: number, lastReset?: number}} usage - Usage payload
 *   returned by the background worker.
 */
function updateUsage(usage) {
  if (!usage || !elements.usage || !elements.usageRowTemplate?.content) {
    return;
  }
  const { content } = elements.usageRowTemplate;
  elements.usage.innerHTML = '';

  const snapshot = withTokenSummary(usage) || {};
  const usageTokens = typeof snapshot.tokens === 'object' && snapshot.tokens !== null
    ? snapshot.tokens
    : { prompt: 0, completion: 0, total: 0, lastReset: null };
  const resolvedLimit = Number.isFinite(snapshot.limitTokens)
    ? snapshot.limitTokens
    : DEFAULT_TOKEN_LIMIT;
  const totalTokens = usageTokens.total ?? snapshot.totalTokens ?? 0;
  const promptTokens = usageTokens.prompt
    ?? snapshot.totalPromptTokens
    ?? snapshot.promptTokens
    ?? 0;
  const completionTokens = usageTokens.completion
    ?? snapshot.totalCompletionTokens
    ?? snapshot.completionTokens
    ?? 0;
  const lastResetTimestamp = usageTokens.lastReset ?? snapshot.lastReset ?? null;

  const appendRow = (label, value) => {
    const row = content.cloneNode(true);
    const term = row.querySelector?.('dt');
    const definition = row.querySelector?.('dd');
    if (term) {
      term.textContent = label;
    }
    if (definition) {
      definition.textContent = value;
    }
    elements.usage.appendChild(row);
  };

  appendRow(t('usageLimitLabel'), formatTokens(resolvedLimit));
  appendRow(t('usageTotalLabel'), formatTokens(totalTokens));
  appendRow(t('usagePromptLabel'), formatTokens(promptTokens));
  appendRow(t('usageCompletionLabel'), formatTokens(completionTokens));

  let lastResetDisplay = t('usageLastResetUnknown');
  if (typeof lastResetTimestamp === 'number' && Number.isFinite(lastResetTimestamp)) {
    lastResetDisplay = new Date(lastResetTimestamp).toLocaleString();
  }
  appendRow(t('usageLastResetLabel'), lastResetDisplay);
}

/**
 * Requests summaries for the current tab and updates local state.
 *
 * @returns {Promise<void>} Resolves when summaries and usage are refreshed.
 */
async function summarisePage() {
  logger.info('Summarise command requested.', {
    provider: state.provider,
    language: state.language,
    mockMode: MOCK_MODE,
  });
  if (MOCK_MODE) {
    const mock = await mockHandlers['comet:summarise']();
    state.summaries = mock.summaries;
    updateUsage(mock.usage);
    setStatus('Summary ready (mock).');
    logger.info('Mock summary generated.', { segments: mock.summaries?.length || 0 });
    return;
  }
  const tabId = await getActiveTabId();
  logger.debug('Active tab resolved for summary.', { tabId });
  const { url, segments } = await fetchSegments(tabId);
  if (!segments.length) {
    setStatus('No readable content detected.');
    logger.warn('No readable segments available for summary.', { tabId });
    return;
  }
  const response = await sendMessage('comet:summarise', {
    url,
    segments,
    language: state.language,
    provider: state.provider,
  });
  state.summaries = response.summaries;
  updateUsage(response.usage);
  setStatus('Summary ready. Use read aloud to listen.');
  logger.info('Summary completed.', {
    provider: state.provider,
    segmentCount: segments.length,
  });
}

/**
 * Lazily initialises the shared Audio element used for playback.
 *
 * @returns {HTMLAudioElement} Singleton audio element.
 */
function ensureAudio() {
  if (!state.audio) {
    state.audio = new Audio();
  }
  if (typeof state.audio.playbackRate === 'number') {
    state.audio.playbackRate = state.playbackRate;
  }
  return state.audio;
}

function normaliseAudioChunks(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(chunk => chunk && typeof chunk === 'object');
  }

  if (Array.isArray(payload?.chunks)) {
    return payload.chunks.filter(chunk => chunk && typeof chunk === 'object');
  }

  if (typeof payload === 'object') {
    return [payload];
  }

  return [];
}

async function playAudioChunk(audioChunk, controller) {
  logger.debug('Starting audio playback for chunk.', {
    hasAudio: Boolean(audioChunk?.base64),
    mimeType: audioChunk?.mimeType,
  });
  if (!audioChunk || !audioChunk.base64) {
    return 'skipped';
  }

  const audio = ensureAudio();
  revokeAudioSource();
  const bytes = decodeBase64Audio(audioChunk.base64);
  const blob = new Blob([bytes], { type: audioChunk.mimeType || 'audio/mpeg' });
  if (
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    throw new Error('Audio playback is not supported in this environment.');
  }
  const url = URL.createObjectURL(blob);
  state.audioSourceUrl = url;
  audio.src = url;

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe;

    const cleanup = () => {
      if (state.audioSourceUrl === url) {
        revokeAudioSource();
      } else if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          logger.debug('Failed to revoke temporary audio URL.', { error });
        }
      }
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };

    const resolveOnce = value => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      logger.debug('Audio playback resolved.', { result: value });
      resolve(value);
    };

    const rejectOnce = error => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      logger.error('Audio playback failed.', { error });
      reject(error);
    };

    const onEnded = () => {
      resolveOnce('finished');
    };

    const onError = event => {
      const mediaError = event.target?.error;
      const message = mediaError?.message || 'Audio playback failed';
      const code = mediaError?.code;
      const error = new Error(code ? `${message} (code: ${code})` : message);
      rejectOnce(error);
    };

    const onCancel = () => {
      resolveOnce('cancelled');
    };

    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    unsubscribe = controller?.onCancel(onCancel);

    setPlaybackActive();

    try {
      if (typeof audio.playbackRate === 'number') {
        audio.playbackRate = state.playbackRate;
      }
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }

    if (controller?.cancelled) {
      onCancel();
    }
  });
}

async function playAudioPayload(audioPayload, controller) {
  const chunks = normaliseAudioChunks(audioPayload);
  logger.debug('Preparing audio playback.', { chunkCount: chunks.length });
  if (chunks.length === 0) {
    return 'skipped';
  }

  let overallResult = 'skipped';
  for (let index = 0; index < chunks.length; index += 1) {
    if (controller?.cancelled) {
      logger.debug('Playback cancelled before chunk started.', { index, chunkCount: chunks.length });
      return 'cancelled';
    }
    const result = await playAudioChunk(chunks[index], controller);
    if (result === 'cancelled') {
      return 'cancelled';
    }
    if (result === 'finished') {
      overallResult = 'finished';
    }
  }

  return overallResult;
}

/**
 * Generates speech for the first summary and begins playback.
 *
 * @returns {Promise<void>} Resolves when playback has started or been skipped.
 */
async function readAloud() {
  logger.info('Read aloud requested.', {
    summariesAvailable: state.summaries.length,
    voice: state.voice,
    language: state.language,
    ttsProvider: state.ttsProvider,
  });
  if (!state.summaries.length) {
    await summarisePage();
  }
  if (!state.summaries.length) {
    logger.warn('Read aloud aborted due to missing summaries.');
    return;
  }
  const first = state.summaries[0];
  const controller = createPlaybackController();
  if (state.playbackController) {
    state.playbackController.cancel();
  }
  state.playbackController = controller;
  setPlaybackLoading();
  beginTtsProgress('read-aloud');
  let playbackResult = 'skipped';
  try {
    const audioResult = await sendMessage('comet:synthesise', {
      text: first.summary,
      voice: state.voice,
      language: state.language,
      provider: resolveSpeechProviderForBackground(),
    });
    updateUsage(audioResult.usage);
    clearTtsProgress();
    if (controller.cancelled) {
      logger.info('Read aloud request cancelled before playback could start.');
      return;
    }
    if (audioResult.audio?.truncated) {
      logger.warn('Summary speech truncated to satisfy provider limits.', {
        originalTokens: audioResult.audio.originalTokenCount,
        deliveredTokens: audioResult.audio.deliveredTokenCount,
        omittedTokens: audioResult.audio.omittedTokenCount,
      });
    }
    setStatus(
      audioResult.audio?.truncated ? 'Playing truncated summary.' : 'Playing summary.',
    );
    playbackResult = await playAudioPayload(audioResult.audio, controller);
    if (playbackResult === 'skipped') {
      setStatus('Audio generated (mock).');
      setPlaybackReady();
      logger.info('Audio playback skipped because payload was unavailable.');
      return;
    }
    if (playbackResult !== 'cancelled') {
      setPlaybackReady();
    }
    logger.info('Read aloud completed.', { playbackResult });
  } catch (error) {
    clearTtsProgress();
    setPlaybackReady();
    throw error;
  } finally {
    if (state.playbackController === controller) {
      state.playbackController = null;
    }
  }
}

async function readFullPage() {
  logger.info('Full page narration requested.', {
    voice: state.voice,
    language: state.language,
    provider: state.provider,
    ttsProvider: state.ttsProvider,
  });
  const tabId = await getActiveTabId();
  logger.debug('Active tab resolved for full-page narration.', { tabId });
  const { segments } = await fetchSegments(tabId);
  if (!segments.length) {
    setStatus('No readable content detected.');
    logger.warn('Full-page narration aborted due to missing segments.', { tabId });
    return;
  }

  const controller = createPlaybackController();
  if (state.playbackController) {
    state.playbackController.cancel();
  }
  state.playbackController = controller;
  setStatus('Preparing full-page narration…');

  try {
    const playableSegments = segments.filter(segment => typeof segment?.text === 'string' && segment.text.trim().length > 0);
    const total = playableSegments.length;
    if (!total) {
      setStatus('No readable content detected.');
      setPlaybackReady();
      logger.warn('No playable segments found after filtering.', { tabId });
      return;
    }

    for (let index = 0; index < total; index += 1) {
      if (controller.cancelled) {
        break;
      }
      const segment = playableSegments[index];
      logger.debug('Requesting narration for segment.', {
        index,
        total,
        length: segment.text.length,
      });
      beginTtsProgress('full-page', { segmentIndex: index, segmentTotal: total });
      setPlaybackLoading();
      let response;
      try {
        response = await sendMessage('comet:synthesise', {
          text: segment.text,
          voice: state.voice,
          language: state.language,
          provider: resolveSpeechProviderForBackground(),
        });
      } finally {
        clearTtsProgress();
      }
      updateUsage(response.usage);
      if (controller.cancelled) {
        break;
      }
      if (response.audio?.truncated) {
        logger.warn('Segment speech truncated to satisfy provider limits.', {
          segmentIndex: index,
          originalTokens: response.audio.originalTokenCount,
          deliveredTokens: response.audio.deliveredTokenCount,
          omittedTokens: response.audio.omittedTokenCount,
        });
      }
      setStatus(
        response.audio?.truncated
          ? `Playing truncated segment ${index + 1} of ${total}.`
          : `Playing segment ${index + 1} of ${total}.`,
      );
      const outcome = await playAudioPayload(response.audio, controller);
      if (outcome === 'skipped') {
        setStatus(`Segment ${index + 1} is silent. Skipping.`);
        logger.debug('Segment playback skipped.', { index, reason: 'silent' });
        continue;
      }
      if (outcome === 'cancelled') {
        logger.info('Playback cancelled by user during full-page narration.', { index });
        break;
      }
    }

    if (controller.cancelled) {
      setPlaybackReady();
      setStatus('Playback stopped.');
      logger.info('Full-page narration stopped before completion.');
      return;
    }

    setPlaybackReady();
    setStatus('Finished reading page.');
    logger.info('Full-page narration completed.');
  } catch (error) {
    clearTtsProgress();
    setPlaybackReady();
    logger.error('Full-page narration failed.', { error });
    throw error;
  } finally {
    if (state.playbackController === controller) {
      state.playbackController = null;
    }
  }
}

/**
 * Stops the active audio playback and resets player controls.
 */
function stopPlayback() {
  logger.debug('Stopping playback.');
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  if (state.playbackController) {
    state.playbackController.cancel();
    state.playbackController = null;
  }
  revokeAudioSource();
  clearTtsProgress();
  setPlaybackReady();
  setStatus('Playback stopped.');
}

/**
 * Pauses audio playback without resetting the position.
 */
function pausePlayback() {
  logger.debug('Pausing playback.');
  if (state.audio) {
    state.audio.pause();
  }
  elements.play.disabled = false;
  elements.pause.disabled = true;
  elements.stop.disabled = false;
}

/**
 * Updates the active language preference and persists it for future sessions.
 *
 * @param {Event} event - Change event from the language selector.
 * @returns {Promise<void>} Resolves once the preference is stored.
 */
async function updateLanguage(event) {
  state.language = event.target.value;
  setLocale(state.language);
  translateUi();
  await storageLocalSet({ language: state.language, ttsLanguage: state.language });
}

/**
 * Updates the preferred voice for speech synthesis.
 *
 * @param {Event} event - Change event from the voice selector.
 * @returns {Promise<void>} Resolves once the preference is stored.
 */
async function updateVoice(event) {
  state.voice = event.target.value;
  await persistVoicePreference(state.voice);
}

async function saveSpeechSettings() {
  await storageLocalSet({
    ttsProvider: state.ttsProvider,
    ttsVoice: state.voice,
    ttsLanguage: state.language,
  });
  setStatus('Speech settings saved.');
}

/**
 * Updates the playback rate used for audio output and persists the choice.
 *
 * @param {Event} event - Change event from the playback rate selector.
 * @returns {Promise<void>} Resolves once the preference is stored.
 */
async function updatePlaybackRate(event) {
  const value = Number.parseFloat(event.target.value);
  if (!Number.isFinite(value) || value <= 0) {
    event.target.value = String(state.playbackRate);
    return;
  }
  state.playbackRate = value;
  if (state.audio && typeof state.audio.playbackRate === 'number') {
    state.audio.playbackRate = state.playbackRate;
  }
  await storageLocalSet({ playbackRate: state.playbackRate });
}

/**
 * Loads persisted language and voice preferences from storage.
 *
 * @returns {Promise<void>} Resolves after UI state has been updated.
 */
async function loadPreferences() {
  logger.info('Loading persisted preferences.');
  const stored = await storageLocalGet([
    'language',
    'ttsLanguage',
    'ttsProvider',
    'ttsVoice',
    'playbackRate',
  ]);
  const candidateLanguage = stored.language || stored.ttsLanguage;
  if (candidateLanguage && availableLocales().includes(candidateLanguage)) {
    state.language = candidateLanguage;
    if (elements.language) {
      elements.language.value = candidateLanguage;
    }
    setLocale(state.language);
  }
  const storedProvider = stored.ttsProvider
    ? normaliseTtsProviderId(stored.ttsProvider)
    : state.ttsProvider;
  state.ttsProvider = storedProvider;
  if (elements.ttsProvider) {
    elements.ttsProvider.value = storedProvider;
  }
  if (typeof stored.ttsVoice === 'string' && stored.ttsVoice.trim().length > 0) {
    state.pendingVoicePreference = stored.ttsVoice.trim();
  } else {
    state.pendingVoicePreference = null;
  }
  const storedRate = stored.playbackRate;
  if (storedRate !== undefined) {
    const rate = Number.parseFloat(storedRate);
    if (Number.isFinite(rate) && rate > 0 && elements.playbackRate) {
      state.playbackRate = rate;
      elements.playbackRate.value = String(rate);
      if (state.audio && typeof state.audio.playbackRate === 'number') {
        state.audio.playbackRate = state.playbackRate;
      }
    }
  } else if (elements.playbackRate) {
    elements.playbackRate.value = String(state.playbackRate);
  }
  translateUi();
  logger.info('Preferences loaded.', {
    language: state.language,
    voice: state.voice,
    playbackRate: state.playbackRate,
    ttsProvider: state.ttsProvider,
  });
}

/**
 * Stops and cleans up the active MediaRecorder instance.
 *
 * @param {{cancel?: boolean}} [options] - Control whether to discard results.
 */
function teardownRecorder({ cancel = true } = {}) {
  logger.debug('Tearing down recorder.', { cancel });
  if (state.recorder) {
    if (cancel) {
      state.recorder.cancel();
    }
    state.recorder = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  elements.pushToTalk.setAttribute('aria-pressed', 'false');
}

/**
 * Initiates microphone capture for push-to-talk actions.
 *
 * @returns {Promise<void>} Resolves when recording starts or mock mode triggers.
 */
async function startRecording() {
  logger.info('Start recording requested.', { hasRecorder: Boolean(state.recorder), mockMode: MOCK_MODE });
  if (state.recorder) {
    return;
  }
  if (MOCK_MODE) {
    elements.pushToTalk.setAttribute('aria-pressed', 'true');
    setStatus('Mock listening… release to stop');
    logger.info('Mock recording started.');
    return;
  }
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recorder = createRecorder(state.mediaStream, { mimeType: 'audio/webm' });
  state.recorder.start();
  elements.pushToTalk.setAttribute('aria-pressed', 'true');
  setStatus(t('listening'));
  logger.info('Recording started.');
}

/**
 * Stops recording and forwards the audio to the background worker for
 * transcription.
 *
 * @returns {Promise<void>} Resolves once transcription has been processed.
 */
async function stopRecording() {
  logger.info('Stop recording requested.', { hasRecorder: Boolean(state.recorder), mockMode: MOCK_MODE });
  if (!state.recorder) {
    if (MOCK_MODE) {
      elements.pushToTalk.setAttribute('aria-pressed', 'false');
      const response = await mockHandlers['comet:transcribe']();
      updateUsage(response.usage);
      handleTranscript(response.text);
      logger.info('Mock transcription completed.');
    }
    return;
  }
  const blob = await state.recorder.stop();
  teardownRecorder({ cancel: false });
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (!result) {
        reject(new Error('Unable to read audio.'));
        return;
      }
      const [, data] = result.split(',');
      resolve(data);
    };
    reader.onerror = () => reject(reader.error || new Error('Recorder failure.'));
    reader.readAsDataURL(blob);
  });
  const response = await sendMessage('comet:transcribe', {
    base64,
    mimeType: blob.type,
    filename: 'speech.webm',
    provider: state.provider,
  });
  updateUsage(response.usage);
  handleTranscript(response.text);
  logger.info('Transcription completed.', {
    language: state.language,
    provider: state.provider,
  });
}

/**
 * Reacts to completed transcripts by triggering summarise or read commands.
 *
 * @param {string} text - Transcript returned by the background worker.
 */
function handleTranscript(text) {
  if (!text) {
    setStatus('No speech detected.');
    return;
  }
  setStatus(`Heard: ${text}`);
  const lowered = text.toLowerCase();
  if (lowered.includes('summary')) {
    summarisePage();
  } else if (lowered.includes('read')) {
    readAloud();
  }
}

/**
 * Resets usage statistics via the background worker.
 *
 * @returns {Promise<void>} Resolves after the usage panel is refreshed.
 */
async function resetUsage() {
  logger.info('Reset usage requested.');
  const usage = await sendMessage('comet:resetUsage');
  updateUsage(usage);
  setStatus('Token usage has been reset.');
  logger.info('Usage reset completed.');
}

/**
 * Fetches the latest usage snapshot for display in the popup.
 *
 * @returns {Promise<void>} Resolves once the UI has been updated.
 */
async function refreshUsage() {
  logger.debug('Refreshing usage snapshot.');
  const usage = await sendMessage('comet:getUsage');
  updateUsage(usage);
  logger.debug('Usage snapshot updated.');
}

/**
 * Attaches event listeners for the popup controls.
 */
function bindEvents() {
  elements.apiForm.addEventListener('submit', withErrorHandling(saveApiKey));
  elements.provider.addEventListener('change', withErrorHandling(handleProviderChange));
  elements.ttsProvider.addEventListener('change', withErrorHandling(handleTtsProviderChange));
  elements.summarise.addEventListener('click', withErrorHandling(summarisePage));
  elements.read.addEventListener('click', withErrorHandling(readAloud));
  elements.readPage.addEventListener('click', withErrorHandling(readFullPage));
  elements.play.addEventListener('click', withErrorHandling(async () => {
    if (state.audio) {
      if (typeof state.audio.playbackRate === 'number') {
        state.audio.playbackRate = state.playbackRate;
      }
      await state.audio.play();
      setPlaybackActive();
    }
  }));
  elements.pause.addEventListener('click', withErrorHandling(async () => {
    pausePlayback();
  }));
  elements.stop.addEventListener('click', withErrorHandling(async () => {
    stopPlayback();
  }));
  elements.resetUsage.addEventListener('click', withErrorHandling(resetUsage));
  elements.language.addEventListener('change', withErrorHandling(updateLanguage));
  elements.voice.addEventListener('change', withErrorHandling(updateVoice));
  elements.saveSpeechSettings.addEventListener('click', withErrorHandling(saveSpeechSettings));
  elements.playbackRate.addEventListener('change', withErrorHandling(updatePlaybackRate));
  elements.pushToTalk.addEventListener('mousedown', withErrorHandling(startRecording));
  elements.pushToTalk.addEventListener('mouseup', withErrorHandling(stopRecording));
  elements.pushToTalk.addEventListener('mouseleave', withErrorHandling(stopRecording));
  elements.pushToTalk.addEventListener('keydown', event => {
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      withErrorHandling(startRecording)(event);
    }
  });
  elements.pushToTalk.addEventListener('keyup', event => {
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      withErrorHandling(stopRecording)(event);
    }
  });
  window.addEventListener('beforeunload', () => {
    teardownRecorder();
  });
}

/**
 * Entry point executed when the popup loads. Wires up state, preferences, and
 * event listeners.
 *
 * @returns {Promise<void>} Resolves once initialisation completes.
 */
async function init() {
  assignElements();
  setPlaybackReady();
  // Populate the provider selector immediately so the UI is interactive while
  // background configuration loads. This prevents the dropdown from appearing
  // empty when the popup opens and ensures required attributes are applied
  // before asynchronous work completes.
  renderProviderOptions(state.providerOptions, state.provider);
  renderTtsProviderOptions(state.ttsProvider);
  ensureLocalVoiceListener();
  bindEvents();
  const loggingConfigPromise = loadLoggingConfig().catch(() => {});
  logger.info('Popup initialising.');
  await loadPreferences();
  renderTtsProviderOptions(state.ttsProvider);
  await refreshVoiceOptions(state.ttsProvider, { persistFallback: true });
  const usagePromise = refreshUsage();
  let loadApiKeyError;
  try {
    await loadApiKey();
  } catch (error) {
    loadApiKeyError = error;
  }
  await hydrateProviderSelector();
  await Promise.all([loggingConfigPromise, usagePromise]);
  if (loadApiKeyError) {
    throw loadApiKeyError;
  }
  logger.info('Popup initialised.');
}

function bootstrap() {
  init().catch(error => {
    logger.error('Failed to initialise popup.', { error });
    setStatus(error.message);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

const __TESTING__ = {
  normaliseError,
  isContextInvalidatedError,
  createContextInvalidatedError,
  resolveStatusMessage,
  assignElements,
  setPlaybackReady,
  setPlaybackLoading,
  readFullPage,
  ensureAudio,
  getActiveTabId,
  resolveSupportedTabUrl,
  isTabUrlSupported,
  ensureSupportedTab,
  UNSUPPORTED_TAB_MESSAGE,
  loadPreferences,
  applyVoiceCapabilities,
  refreshVoiceOptions,
  playAudioPayload,
  createPlaybackController,
  beginTtsProgress,
  clearTtsProgress,
  handleTtsProgressMessage,
};

export { sendMessageToTab, sendMessage, __TESTING__ };
