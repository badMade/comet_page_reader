import createLogger, { loadLoggingConfig, setGlobalContext } from '../utils/logger.js';
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
    Promise.resolve({ totalCostUsd: 0.0123, limitUsd: 5, lastReset: Date.now() - 3600 * 1000 }),
  'comet:resetUsage': () =>
    Promise.resolve({ totalCostUsd: 0, limitUsd: 5, lastReset: Date.now() }),
  'comet:summarise': () =>
    Promise.resolve({
      summaries: [
        {
          id: 'segment-1',
          summary: 'This is a mock summary returned without contacting the provider.',
        },
      ],
      usage: { totalCostUsd: 0.0123, limitUsd: 5, lastReset: Date.now() - 3600 * 1000 },
    }),
  'comet:synthesise': () =>
    Promise.resolve({
      audio: { base64: '', mimeType: 'audio/mpeg' },
      usage: { totalCostUsd: 0.015, limitUsd: 5, lastReset: Date.now() - 3600 * 1000 },
    }),
  'comet:transcribe': () =>
    Promise.resolve({ text: 'mock summary please', usage: { totalCostUsd: 0.02, limitUsd: 5, lastReset: Date.now() } }),
};

const DEFAULT_VOICE = 'alloy';

const state = {
  summaries: [],
  audio: null,
  audioSourceUrl: null,
  language: 'en',
  voice: DEFAULT_VOICE,
  playbackRate: 1,
  provider: DEFAULT_PROVIDER_ID,
  providerLastSynced: null,
  providerOptions: listProviders().map(option => option.id),
  recorder: null,
  mediaStream: null,
  playbackController: null,
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
  elements.voice = qs('voiceSelect');
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
  if (!elements.voice) {
    return [];
  }
  const options = elements.voice.options;
  if (!options || typeof options.length === 'undefined') {
    return [];
  }
  return Array.from(options)
    .map(option => option?.value)
    .filter(value => typeof value === 'string' && value.length > 0);
}

async function persistVoicePreference(voice) {
  if (!chrome?.storage?.sync) {
    return;
  }
  await new Promise(resolve => {
    chrome.storage.sync.set({ voice }, () => {
      const err = chrome?.runtime?.lastError;
      if (err) {
        logger.debug('Failed to persist voice preference.', { error: err });
      }
      resolve();
    });
  });
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
  await sendMessage('comet:setProvider', { provider: normalised });
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
  await setAndSyncProvider(providerId);
  await loadApiKey({ provider: providerId });
  const providerName = getProviderDisplayName(providerId);
  if (providerRequiresApiKey(providerId)) {
    setStatus(`${providerName} selected. Enter an API key to enable requests.`);
  } else {
    setStatus(`${providerName} selected. API key is optional.`);
  }
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
  if (!tab || typeof tab.id !== 'number') {
    throw new Error(UNSUPPORTED_TAB_MESSAGE);
  }

  const supportedUrl = resolveSupportedTabUrl(tab);
  if (!supportedUrl) {
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

/**
 * Renders usage statistics in the popup.
 *
 * @param {{limitUsd?: number, totalCostUsd?: number, lastReset?: number}} usage -
 *   Usage payload returned by the background worker.
 */
function updateUsage(usage) {
  if (!usage) {
    return;
  }
  elements.usage.innerHTML = '';
  const limitRow = elements.usageRowTemplate.content.cloneNode(true);
  limitRow.querySelector('dt').textContent = 'Limit';
  limitRow.querySelector('dd').textContent = `$${usage.limitUsd?.toFixed?.(2) || '5.00'}`;
  elements.usage.appendChild(limitRow);

  const totalRow = elements.usageRowTemplate.content.cloneNode(true);
  totalRow.querySelector('dt').textContent = 'Total';
  totalRow.querySelector('dd').textContent = `$${usage.totalCostUsd?.toFixed?.(4) || '0.0000'}`;
  elements.usage.appendChild(totalRow);

  const lastReset = elements.usageRowTemplate.content.cloneNode(true);
  lastReset.querySelector('dt').textContent = 'Last reset';
  lastReset.querySelector('dd').textContent = usage.lastReset
    ? new Date(usage.lastReset).toLocaleString()
    : 'Unknown';
  elements.usage.appendChild(lastReset);
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

async function playAudioPayload(audioPayload, controller) {
  logger.debug('Starting audio playback for payload.', {
    hasAudio: Boolean(audioPayload?.base64),
    mimeType: audioPayload?.mimeType,
  });
  if (!audioPayload || !audioPayload.base64) {
    return 'skipped';
  }

  const audio = ensureAudio();
  revokeAudioSource();
  const bytes = decodeBase64Audio(audioPayload.base64);
  const blob = new Blob([bytes], { type: audioPayload.mimeType || 'audio/mpeg' });
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
  });
  if (!state.summaries.length) {
    await summarisePage();
  }
  if (!state.summaries.length) {
    logger.warn('Read aloud aborted due to missing summaries.');
    return;
  }
  const first = state.summaries[0];
  const audioResult = await sendMessage('comet:synthesise', {
    text: first.summary,
    voice: state.voice,
    language: state.language,
    provider: state.provider,
  });
  updateUsage(audioResult.usage);
  const controller = createPlaybackController();
  if (state.playbackController) {
    state.playbackController.cancel();
  }
  state.playbackController = controller;
  setStatus('Playing summary.');
  try {
    const playbackResult = await playAudioPayload(audioResult.audio, controller);
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
      const response = await sendMessage('comet:synthesise', {
        text: segment.text,
        voice: state.voice,
        language: state.language,
        provider: state.provider,
      });
      updateUsage(response.usage);
      if (controller.cancelled) {
        break;
      }
      setStatus(`Playing segment ${index + 1} of ${total}.`);
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
  if (chrome?.storage?.sync) {
    await new Promise(resolve => {
      chrome.storage.sync.set({ language: state.language }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          logger.debug('Failed to persist language preference.', { error: err });
        }
        resolve();
      });
    });
  }
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
  if (chrome?.storage?.sync) {
    await new Promise(resolve => {
      chrome.storage.sync.set({ playbackRate: state.playbackRate }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          logger.debug('Failed to persist playback rate preference.', { error: err });
        }
        resolve();
      });
    });
  }
}

/**
 * Loads persisted language and voice preferences from storage.
 *
 * @returns {Promise<void>} Resolves after UI state has been updated.
 */
async function loadPreferences() {
  logger.info('Loading persisted preferences.');
  const stored = await new Promise(resolve => {
    if (!chrome?.storage?.sync) {
      resolve({});
      return;
    }
    chrome.storage.sync.get(['language', 'voice', 'playbackRate'], items => resolve(items || {}));
  });
  if (stored.language && availableLocales().includes(stored.language)) {
    state.language = stored.language;
    elements.language.value = stored.language;
    setLocale(state.language);
  }
  if (stored.voice) {
    const voiceOptions = getVoiceOptions();
    if (voiceOptions.includes(stored.voice)) {
      state.voice = stored.voice;
      if (elements.voice) {
        elements.voice.value = stored.voice;
      }
    } else {
      const fallback =
        voiceOptions.find(option => option === DEFAULT_VOICE) ??
        voiceOptions[0] ??
        state.voice;
      state.voice = fallback;
      if (elements.voice) {
        elements.voice.value = state.voice;
      }
      if (stored.voice !== state.voice) {
        await persistVoicePreference(state.voice);
      }
    }
  } else if (elements.voice) {
    const voiceOptions = getVoiceOptions();
    if (voiceOptions.length > 0 && !voiceOptions.includes(state.voice)) {
      const fallback =
        voiceOptions.find(option => option === DEFAULT_VOICE) ??
        voiceOptions[0] ??
        state.voice;
      state.voice = fallback;
    }
    elements.voice.value = state.voice;
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
  setStatus('Usage has been reset.');
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
  bindEvents();
  const loggingConfigPromise = loadLoggingConfig().catch(() => {});
  logger.info('Popup initialising.');
  const preferencesPromise = loadPreferences();
  const usagePromise = refreshUsage();
  let loadApiKeyError;
  try {
    await loadApiKey();
  } catch (error) {
    loadApiKeyError = error;
  }
  await hydrateProviderSelector();
  await Promise.all([loggingConfigPromise, preferencesPromise, usagePromise]);
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
  readFullPage,
  ensureAudio,
  getActiveTabId,
  resolveSupportedTabUrl,
  isTabUrlSupported,
  ensureSupportedTab,
  UNSUPPORTED_TAB_MESSAGE,
  loadPreferences,
};

export { sendMessageToTab, sendMessage, __TESTING__ };
