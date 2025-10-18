import { availableLocales, setLocale, t } from '../utils/i18n.js';
import { createRecorder } from '../utils/audio.js';

const runtime = chrome?.runtime || browser?.runtime;
const tabsApi = chrome?.tabs || browser?.tabs;
const usesBrowserPromises =
  typeof browser !== 'undefined' && runtime === browser.runtime && tabsApi === browser.tabs;

const MOCK_MODE = false;
const mockHandlers = {
  'comet:getApiKey': () => Promise.resolve('sk-mock-1234'),
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

function qs(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing required element: ${id}`);
  }
  return node;
}

function assignElements() {
  elements.apiForm = qs('api-form');
  elements.apiKey = qs('apiKey');
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

function setStatus(message) {
  elements.recordingStatus.textContent = message || '';
}

function withErrorHandling(handler) {
  return async event => {
    event?.preventDefault?.();
    try {
      await handler(event);
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Something went wrong.');
    }
  };
}

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
        throw new Error(error.message || 'Background request failed.');
      });
  }

  return new Promise((resolve, reject) => {
    runtime.sendMessage(payloadMessage, response => {
      const lastError = chrome?.runtime?.lastError || browser?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
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
  });
}

async function loadApiKey() {
  const apiKey = await sendMessage('comet:getApiKey');
  if (apiKey) {
    elements.apiKey.value = apiKey;
  }
}

async function saveApiKey(event) {
  const apiKey = elements.apiKey.value.trim();
  await sendMessage('comet:setApiKey', { apiKey });
  setStatus('API key saved securely.');
}

function queryTabs(options) {
  if (usesBrowserPromises) {
    return tabsApi.query(options);
  }
  return new Promise((resolve, reject) => {
    try {
      tabsApi.query(options, tabs => {
        const lastError = chrome?.runtime?.lastError || browser?.runtime?.lastError;
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

function sendMessageToTab(tabId, message) {
  if (usesBrowserPromises) {
    return tabsApi.sendMessage(tabId, message);
  }
  return new Promise((resolve, reject) => {
    try {
      tabsApi.sendMessage(tabId, message, response => {
        const lastError = chrome?.runtime?.lastError || browser?.runtime?.lastError;
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

async function getActiveTabId() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  if (!tabs.length) {
    throw new Error('No active tab detected.');
  }
  return tabs[0].id;
}

async function fetchSegments(tabId) {
  const response = await sendMessageToTab(tabId, { type: 'comet:getSegments' });
  if (!response || !response.ok) {
    throw new Error('Unable to read page content.');
  }
  return response.result;
}

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

function stopPlayback() {
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  elements.play.disabled = false;
  elements.pause.disabled = true;
  elements.stop.disabled = true;
}

function pausePlayback() {
  if (state.audio) {
    state.audio.pause();
  }
  elements.play.disabled = false;
  elements.pause.disabled = true;
  elements.stop.disabled = false;
}

function updateLanguage(event) {
  state.language = event.target.value;
  setLocale(state.language);
  translateUi();
  if (chrome?.storage?.sync) {
    chrome.storage.sync.set({ language: state.language }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.debug('Failed to persist language preference', err);
      }
    });
  }
}

function updateVoice(event) {
  state.voice = event.target.value;
  if (chrome?.storage?.sync) {
    chrome.storage.sync.set({ voice: state.voice }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.debug('Failed to persist voice preference', err);
      }
    });
  }
}

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

async function resetUsage() {
  const usage = await sendMessage('comet:resetUsage');
  updateUsage(usage);
  setStatus('Usage has been reset.');
}

async function refreshUsage() {
  const usage = await sendMessage('comet:getUsage');
  updateUsage(usage);
}

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
