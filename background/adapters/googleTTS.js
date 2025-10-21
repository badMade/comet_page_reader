import createLogger from '../../utils/logger.js';

const GOOGLE_TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

const logger = createLogger({ name: 'adapter-google-tts' });

const DEFAULT_LANGUAGE_CODE = 'en-US';

function extractLanguageFromVoiceName(voiceName) {
  if (typeof voiceName !== 'string') {
    return null;
  }
  const match = voiceName.match(/^([a-z]{2,}-[A-Z]{2})(?:-|$)/i);
  if (!match) {
    return null;
  }
  return match[1];
}

function ensureFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch API is not available in this environment.');
  }
  return globalThis.fetch.bind(globalThis);
}

async function readFromStorage(keys) {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
    throw new Error('Chrome storage API is not available.');
  }
  const getter = chrome.storage.local.get;
  if (typeof getter !== 'function') {
    throw new Error('Chrome storage API is not available.');
  }
  try {
    const maybePromise = getter.call(chrome.storage.local, keys);
    if (maybePromise && typeof maybePromise.then === 'function') {
      return await maybePromise;
    }
  } catch (error) {
    if (!/callback/i.test(error?.message || '')) {
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    try {
      getter.call(chrome.storage.local, keys, items => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'Failed to read storage.'));
          return;
        }
        resolve(items);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getGoogleApiKey() {
  const result = await readFromStorage({ googleTTSApiKey: null });
  const apiKey = result?.googleTTSApiKey;
  if (!apiKey) {
    throw new Error('Google TTS API key is not configured.');
  }
  return apiKey;
}

function buildRequestPayload(text, voice, languageCode) {
  const payload = {
    input: { text },
    audioConfig: { audioEncoding: 'MP3' },
  };
  const inferredLanguage =
    languageCode || extractLanguageFromVoiceName(voice) || DEFAULT_LANGUAGE_CODE;
  const voiceConfig = { languageCode: inferredLanguage };
  if (voice) {
    voiceConfig.name = voice;
  }
  payload.voice = voiceConfig;
  return payload;
}

function parseErrorMessage(raw) {
  if (!raw) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
    if (parsed?.message) {
      return parsed.message;
    }
    return JSON.stringify(parsed);
  } catch (error) {
    return raw;
  }
}

/**
 * Synthesises speech using Google Cloud Text-to-Speech.
 *
 * @param {{ text: string, voice?: string, languageCode?: string }} params - Speech request.
 * @returns {Promise<{ base64: string, mimeType: string }>} Encoded audio payload.
 */
export async function synthesise({ text, voice, languageCode }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Text is required for speech synthesis.');
  }
  const apiKey = await getGoogleApiKey();
  const fetchImpl = ensureFetch();
  const requestBody = buildRequestPayload(text, voice, languageCode);
  const url = `${GOOGLE_TTS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

  logger.debug('Sending Google TTS request.', {
    hasVoice: Boolean(voice),
    hasLanguage: Boolean(languageCode),
    endpoint: GOOGLE_TTS_ENDPOINT,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    let message = '';
    try {
      const raw = await response.text();
      message = parseErrorMessage(raw);
    } catch (error) {
      logger.warn('Failed to parse Google TTS error payload.', { error });
    }
    throw new Error(`Google TTS request failed (${response.status}): ${message}`.trim());
  }

  const data = await response.json();
  const base64 = data?.audioContent;
  if (typeof base64 !== 'string' || !base64) {
    throw new Error('Google TTS response did not include audio content.');
  }

  logger.debug('Google TTS request completed.', {
    hasAudio: Boolean(base64),
  });

  return { base64, mimeType: 'audio/mpeg' };
}
