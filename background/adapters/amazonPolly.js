import AWS from 'aws-sdk';
import createLogger from '../../utils/logger.js';

const logger = createLogger({ name: 'adapter-amazon-polly' });
const DEFAULT_VOICE_ID = 'Joanna';

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

async function getCredentials() {
  const result = await readFromStorage({
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
    awsRegion: null,
    amazonPollyAccessKeyId: null,
    amazonPollySecretAccessKey: null,
    amazonPollyRegion: null,
  });
  const accessKeyId = result?.amazonPollyAccessKeyId || result?.awsAccessKeyId;
  const secretAccessKey = result?.amazonPollySecretAccessKey || result?.awsSecretAccessKey;
  const region = result?.amazonPollyRegion || result?.awsRegion;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('Amazon Polly credentials are not fully configured.');
  }
  return { accessKeyId, secretAccessKey, region };
}

function ensureText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Text is required for speech synthesis.');
  }
}

function bufferToBase64(uint8Array) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8Array).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < uint8Array.length; index += chunkSize) {
    const chunk = uint8Array.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  throw new Error('Base64 encoding is not supported in this environment.');
}

function audioStreamToBase64(stream) {
  if (!stream) {
    throw new Error('Amazon Polly response did not include an audio stream.');
  }
  if (typeof stream === 'string') {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(stream, 'binary').toString('base64');
    }
    if (typeof btoa === 'function') {
      return btoa(stream);
    }
    throw new Error('Base64 encoding is not supported in this environment.');
  }
  if (stream instanceof ArrayBuffer) {
    return bufferToBase64(new Uint8Array(stream));
  }
  if (ArrayBuffer.isView(stream)) {
    return bufferToBase64(new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength));
  }
  if (typeof Buffer !== 'undefined' && stream instanceof Buffer) {
    return stream.toString('base64');
  }
  if (stream?.buffer instanceof ArrayBuffer) {
    return bufferToBase64(new Uint8Array(stream.buffer));
  }
  throw new Error('Unsupported audio stream type received from Amazon Polly.');
}

/**
 * Synthesises speech using Amazon Polly and returns a base64 encoded payload.
 *
 * @param {{ text: string, voice?: string, languageCode?: string }} params - Speech request.
 * @returns {Promise<{ base64: string, mimeType: string }>} Encoded audio payload.
 */
export async function synthesise({ text, voice, languageCode }) {
  ensureText(text);
  const credentials = await getCredentials();

  logger.debug('Initialising Amazon Polly client.', {
    region: credentials.region,
    hasVoice: Boolean(voice),
    hasLanguage: Boolean(languageCode),
  });

  const polly = new AWS.Polly({
    apiVersion: '2016-06-10',
    region: credentials.region,
    credentials: new AWS.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }),
  });

  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: voice || DEFAULT_VOICE_ID,
  };
  if (languageCode) {
    params.LanguageCode = languageCode;
  }

  try {
    const result = await polly.synthesizeSpeech(params).promise();
    const base64 = audioStreamToBase64(result?.AudioStream);
    logger.debug('Amazon Polly synthesis completed.', {
      hasAudio: Boolean(base64),
    });
    return { base64, mimeType: 'audio/mpeg' };
  } catch (error) {
    logger.error('Amazon Polly synthesis failed.', { error });
    throw error;
  }
}
