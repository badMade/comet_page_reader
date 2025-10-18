import { createCostTracker, DEFAULT_LIMIT_USD } from '../utils/cost.js';
import {
  getValue,
  setValue,
  removeValue,
  withLock,
  getSessionValue,
  setSessionValue,
  runtime,
} from '../utils/storage.js';

const API_KEY_STORAGE_KEY = 'comet:openaiApiKey';
const USAGE_STORAGE_KEY = 'comet:usage';
const CACHE_STORAGE_KEY = 'comet:cache';

let costTracker;
let memoryCache = new Map();
let initialised = false;

function getCacheKey(url, segmentId) {
  return `${url}::${segmentId}`;
}

async function ensureInitialised() {
  if (initialised) {
    return;
  }
  const usage = await getValue(USAGE_STORAGE_KEY);
  costTracker = createCostTracker(DEFAULT_LIMIT_USD, usage);
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

async function getApiKey() {
  return getValue(API_KEY_STORAGE_KEY);
}

async function setApiKey(apiKey) {
  if (!apiKey) {
    await removeValue(API_KEY_STORAGE_KEY);
    return null;
  }
  return setValue(API_KEY_STORAGE_KEY, apiKey);
}

function ensureKeyAvailable(apiKey) {
  if (!apiKey) {
    throw new Error('Missing OpenAI API key.');
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

async function fetchWithAuth(endpoint, options = {}) {
  const apiKey = await getApiKey();
  ensureKeyAvailable(apiKey);

  const response = await fetch(`https://api.openai.com${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI error (${response.status}): ${message}`);
  }

  return response;
}

async function sendChatCompletion({ text, url, segmentId, language, model = 'gpt-4o-mini' }) {
  const prompt = `Provide a concise, listener-friendly summary of the following webpage content. Use ${language} language.\n\n${text}`;

  const response = await fetchWithAuth('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that creates short spoken summaries.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const summary = choice && choice.message && choice.message.content ? choice.message.content.trim() : '';

  const promptTokens = data.usage?.prompt_tokens || costTracker.estimateTokensFromText(text);
  const completionTokens = data.usage?.completion_tokens || costTracker.estimateTokensFromText(summary);
  costTracker.record(model, promptTokens, completionTokens, {
    url,
    segmentId,
    type: 'summary',
  });
  await persistUsage();

  return summary;
}

async function transcribeAudio({ base64, filename = 'speech.webm', mimeType = 'audio/webm' }) {
  const apiKey = await getApiKey();
  ensureKeyAvailable(apiKey);
  const estimatedCost = 0.005;
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for transcription.');
  }

  const formData = new FormData();
  const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: mimeType });
  formData.append('file', blob, filename);
  formData.append('model', 'gpt-4o-mini-transcribe');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${message}`);
  }

  const data = await response.json();
  costTracker.recordFlat('stt', estimatedCost, { type: 'stt' });
  await persistUsage();
  return data.text;
}

async function synthesiseSpeech({ text, voice = 'alloy', format = 'mp3', model = 'gpt-4o-mini-tts' }) {
  const apiKey = await getApiKey();
  ensureKeyAvailable(apiKey);
  const estimatedCost = 0.01;
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for speech synthesis.');
  }

  const response = await fetch(`https://api.openai.com/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      format,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Speech synthesis failed (${response.status}): ${message}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  costTracker.recordFlat('tts', estimatedCost, { type: 'tts' });
  await persistUsage();
  return {
    base64: toBase64(arrayBuffer),
    mimeType: response.headers.get('content-type') || `audio/${format}`,
  };
}

async function getSummary({ url, segment, language }) {
  const cacheKey = getCacheKey(url, segment.id);
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }
  const estimatedCost = costTracker.estimateCostForText('gpt-4o-mini', segment.text);
  if (!costTracker.canSpend(estimatedCost)) {
    throw new Error('Cost limit reached for summaries.');
  }
  const summary = await sendChatCompletion({
    text: segment.text,
    url,
    segmentId: segment.id,
    language,
  });
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

ensureInitialised().catch(error => {
  console.error('Failed to initialise service worker', error);
});
