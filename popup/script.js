import { availableLocales, setLocale, t } from '../utils/i18n.js';
import { createRecorder } from '../utils/audio.js';

/**
 * Popup controller responsible for coordinating UI state, background messages,
 * and media capture for the Comet Page Reader extension.
 *
 * @module popup/script
 */

const hasBrowserApi = typeof browser !== 'undefined';
const browserApi = hasBrowserApi ? browser : undefined;
const runtime = chrome?.runtime || browserApi?.runtime;
const tabsApi = chrome?.tabs || browserApi?.tabs;
const scriptingApi = chrome?.scripting || browserApi?.scripting;
const usesBrowserPromises =
  !!browserApi && runtime === browserApi.runtime && tabsApi === browserApi.tabs;

const MOCK_MODE = false;
const mockHandlers = {
  'comet:getApiKey': () => Promise.resolve('sk-mock-1234'),
  'comet:getApiKeyDetails': () =>
    Promise.resolve({ apiKey: 'sk-mock-1234', lastUpdated: Date.now() - 30 * 1000 }),
  'comet:setApiKey': () => Promise.resolve(null),
  'comet:getUsage': () =>
    Promise.resolve({ totalCostUsd: 0.0123, limitUsd: 5, lastReset: Date.now() - 3600 * 1000 }),
  'comet:resetUsage': () =>
    Promise.resolve({ totalCostUsd: 0, limitUsd: 5, lastReset: Date.now() }),
  'comet:summarise': () =>
    Promise.resolve({
      summaries: [
        {
          id: 'segment-1',
          summary: 'This is a mock summary returned without calling OpenAI.',
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

const state = {
  summaries: [],
  audio: null,
  language: 'en',
  voice: 'alloy',
  recorder: null,
  mediaStream: null,
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
  elements.apiKey = qs('apiKey');
  elements.apiKeyMeta = qs('apiKeyMeta');
  elements.language = qs('languageSelect');
  elements.voice = qs('voiceSelect');
  elements.summarise = qs('summariseBtn');
  elements.read = qs('readBtn');
  elements.pushToTalk = qs('pushToTalkBtn');
  elements.recordingStatus = qs('recordingStatus');
  elements.play = qs('playBtn');
  elements.pause = qs('pauseBtn');
  elements.stop = qs('stopBtn');
  elements.usage = qs('usageDetails');
  elements.resetUsage = qs('resetUsageBtn');
  elements.usageRowTemplate = document.getElementById('usageRowTemplate');
}

/**
 * Applies the currently selected locale to all visible UI strings.
 */
function translateUi() {
  elements.apiForm.querySelector('label').textContent = t('apiKeyLabel');
  elements.summarise.textContent = t('summarise');
  elements.read.textContent = t('readAloud');
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

/**
 * Updates the status element used for inline user feedback.
 *
 * @param {string} message - Text content to display.
 */
function setStatus(message) {
  elements.recordingStatus.textContent = message || '';
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
    (error instanceof DOMException || error?.name?.endsWith('Error'));
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
    console.debug('Failed to stringify error for status message', stringifyError);
  }

  return fallbackMessage;
}

function withErrorHandling(handler) {
  return async event => {
    event?.preventDefault?.();
    try {
      await handler(event);
    } catch (error) {
      console.error(error);
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
  if (MOCK_MODE && mockHandlers[type]) {
    return mockHandlers[type](payload);
  }
  const payloadMessage = { type, payload };
  if (usesBrowserPromises) {
    return runtime
      .sendMessage(payloadMessage)
      .then(response => {
        if (!response) {
          throw new Error('No response from background script.');
        }
        if (!response.ok) {
          throw new Error(response.error || 'Request failed.');
        }
        return response.result;
      })
      .catch(error => {
        throw normaliseError(error);
      });
  }

  return new Promise((resolve, reject) => {
    try {
      const maybePromise = runtime.sendMessage(payloadMessage, response => {
        const lastError = getRuntimeLastError();
        if (lastError) {
          reject(normaliseError(lastError));
          return;
        }
        if (!response) {
          reject(new Error('No response from background script.'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || 'Request failed.'));
          return;
        }
        resolve(response.result);
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(error => {
          reject(normaliseError(error));
        });
      }
    } catch (error) {
      reject(normaliseError(error));
    }
  });
}

/**
 * Loads the persisted API key from the background worker and updates the form.
 *
 * @returns {Promise<void>} Resolves once the value is populated.
 */
async function loadApiKey() {
  const response = await sendMessage('comet:getApiKeyDetails');
  renderApiKeyDetails(response);
}

/**
 * Persists the API key entered by the user.
 *
 * @returns {Promise<void>} Resolves after the key is saved.
 */
async function saveApiKey(event) {
  const apiKey = elements.apiKey.value.trim();
  await sendMessage('comet:setApiKey', { apiKey });
  await loadApiKey();
  setStatus('API key saved securely.');
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

  const hasKey = Boolean(normalised.apiKey);
  if (hasKey) {
    elements.apiKey.value = normalised.apiKey;
    const formatted = formatLastUpdated(normalised.lastUpdated);
    elements.apiKeyMeta.textContent = formatted
      ? `Last updated: ${formatted}`
      : 'API key saved. Last update time unavailable.';
    elements.apiKeyMeta.dataset.state = 'ready';
    return;
  }

  elements.apiKey.value = '';
  elements.apiKeyMeta.textContent = 'No API key saved.';
  elements.apiKeyMeta.dataset.state = 'empty';
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
async function getActiveTabId() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  if (!tabs.length) {
    throw new Error('No active tab detected.');
  }
  return tabs[0].id;
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
  if (MOCK_MODE) {
    const mock = await mockHandlers['comet:summarise']();
    state.summaries = mock.summaries;
    updateUsage(mock.usage);
    setStatus('Summary ready (mock).');
    return;
  }
  const tabId = await getActiveTabId();
  const { url, segments } = await fetchSegments(tabId);
  if (!segments.length) {
    setStatus('No readable content detected.');
    return;
  }
  const response = await sendMessage('comet:summarise', {
    url,
    segments,
    language: state.language,
  });
  state.summaries = response.summaries;
  updateUsage(response.usage);
  setStatus('Summary ready. Use read aloud to listen.');
}

/**
 * Lazily initialises the shared Audio element used for playback.
 *
 * @returns {HTMLAudioElement} Singleton audio element.
 */
function ensureAudio() {
  if (!state.audio) {
    state.audio = new Audio();
    state.audio.addEventListener('ended', () => {
      elements.play.disabled = false;
      elements.pause.disabled = true;
      elements.stop.disabled = true;
    });
  }
  return state.audio;
}

/**
 * Generates speech for the first summary and begins playback.
 *
 * @returns {Promise<void>} Resolves when playback has started or been skipped.
 */
async function readAloud() {
  if (!state.summaries.length) {
    await summarisePage();
  }
  if (!state.summaries.length) {
    return;
  }
  const first = state.summaries[0];
  const audioResult = await sendMessage('comet:synthesise', {
    text: first.summary,
    voice: state.voice,
    language: state.language,
  });
  updateUsage(audioResult.usage);
  const audio = ensureAudio();
  const { base64, mimeType } = audioResult.audio;
  if (!base64) {
    setStatus('Audio generated (mock).');
    elements.play.disabled = false;
    elements.pause.disabled = true;
    elements.stop.disabled = true;
    return;
  }
  const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: mimeType });
  const url = URL.createObjectURL(blob);
  audio.src = url;
  await audio.play();
  elements.play.disabled = true;
  elements.pause.disabled = false;
  elements.stop.disabled = false;
  setStatus('Playing summary.');
  audio.onended = () => {
    URL.revokeObjectURL(url);
    elements.play.disabled = false;
    elements.pause.disabled = true;
    elements.stop.disabled = true;
  };
}

/**
 * Stops the active audio playback and resets player controls.
 */
function stopPlayback() {
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  elements.play.disabled = false;
  elements.pause.disabled = true;
  elements.stop.disabled = true;
}

/**
 * Pauses audio playback without resetting the position.
 */
function pausePlayback() {
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
          console.debug('Failed to persist language preference', err);
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
  if (chrome?.storage?.sync) {
    await new Promise(resolve => {
      chrome.storage.sync.set({ voice: state.voice }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.debug('Failed to persist voice preference', err);
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
  const stored = await new Promise(resolve => {
    if (!chrome?.storage?.sync) {
      resolve({});
      return;
    }
    chrome.storage.sync.get(['language', 'voice'], items => resolve(items || {}));
  });
  if (stored.language && availableLocales().includes(stored.language)) {
    state.language = stored.language;
    elements.language.value = stored.language;
    setLocale(state.language);
  }
  if (stored.voice) {
    state.voice = stored.voice;
    elements.voice.value = stored.voice;
  }
  translateUi();
}

/**
 * Stops and cleans up the active MediaRecorder instance.
 *
 * @param {{cancel?: boolean}} [options] - Control whether to discard results.
 */
function teardownRecorder({ cancel = true } = {}) {
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
  if (state.recorder) {
    return;
  }
  if (MOCK_MODE) {
    elements.pushToTalk.setAttribute('aria-pressed', 'true');
    setStatus('Mock listening… release to stop');
    return;
  }
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recorder = createRecorder(state.mediaStream, { mimeType: 'audio/webm' });
  state.recorder.start();
  elements.pushToTalk.setAttribute('aria-pressed', 'true');
  setStatus(t('listening'));
}

/**
 * Stops recording and forwards the audio to the background worker for
 * transcription.
 *
 * @returns {Promise<void>} Resolves once transcription has been processed.
 */
async function stopRecording() {
  if (!state.recorder) {
    if (MOCK_MODE) {
      elements.pushToTalk.setAttribute('aria-pressed', 'false');
      const response = await mockHandlers['comet:transcribe']();
      updateUsage(response.usage);
      handleTranscript(response.text);
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
  });
  updateUsage(response.usage);
  handleTranscript(response.text);
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
  const usage = await sendMessage('comet:resetUsage');
  updateUsage(usage);
  setStatus('Usage has been reset.');
}

/**
 * Fetches the latest usage snapshot for display in the popup.
 *
 * @returns {Promise<void>} Resolves once the UI has been updated.
 */
async function refreshUsage() {
  const usage = await sendMessage('comet:getUsage');
  updateUsage(usage);
}

/**
 * Attaches event listeners for the popup controls.
 */
function bindEvents() {
  elements.apiForm.addEventListener('submit', withErrorHandling(saveApiKey));
  elements.summarise.addEventListener('click', withErrorHandling(summarisePage));
  elements.read.addEventListener('click', withErrorHandling(readAloud));
  elements.play.addEventListener('click', withErrorHandling(async () => {
    if (state.audio) {
      await state.audio.play();
      elements.play.disabled = true;
      elements.pause.disabled = false;
      elements.stop.disabled = false;
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
  await loadApiKey();
  await loadPreferences();
  await refreshUsage();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(error => {
    console.error('Failed to initialise popup', error);
    setStatus(error.message);
  });
});

const __TESTING__ = {
  normaliseError,
  isContextInvalidatedError,
  createContextInvalidatedError,
  resolveStatusMessage,
};

export { sendMessageToTab, sendMessage, __TESTING__ };
