import createLogger from '../../utils/logger.js';

const logger = createLogger({ name: 'adapter-local-tts' });

function ensureText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Text is required for speech synthesis.');
  }
}

function ensureSpeechSupport() {
  const synth = typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : undefined;
  const Utterance = typeof globalThis !== 'undefined' ? globalThis.SpeechSynthesisUtterance : undefined;
  if (!synth || typeof synth.speak !== 'function' || typeof synth.cancel !== 'function') {
    throw new Error('Speech synthesis is not supported in this environment.');
  }
  if (typeof Utterance !== 'function') {
    throw new Error('Speech synthesis utterances are not supported in this environment.');
  }
  return { synth, Utterance };
}

function resolveVoice(synth, voiceName) {
  if (!voiceName || typeof synth.getVoices !== 'function') {
    return null;
  }
  try {
    const voices = synth.getVoices();
    if (!Array.isArray(voices) || voices.length === 0) {
      return null;
    }
    return voices.find(voice => voice?.name === voiceName) || null;
  } catch (error) {
    logger.debug('Failed to resolve local speech voice.', { error });
    return null;
  }
}

/**
 * Synthesises speech locally using the Web Speech API.
 *
 * @param {{ text: string, voice?: string, languageCode?: string }} params - Speech request.
 * @returns {Promise<{ base64: null, mimeType: null }>} Resolves when playback completes.
 */
export async function synthesise({ text, voice, languageCode }) {
  ensureText(text);
  const { synth, Utterance } = ensureSpeechSupport();

  logger.debug('Starting local speech synthesis.', {
    hasVoice: Boolean(voice),
    hasLanguage: Boolean(languageCode),
  });

  const utterance = new Utterance(text);
  if (languageCode) {
    utterance.lang = languageCode;
  }
  const resolvedVoice = resolveVoice(synth, voice);
  if (resolvedVoice) {
    utterance.voice = resolvedVoice;
  } else if (voice) {
    logger.warn('Requested voice not available locally. Using default voice.', { voice });
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      utterance.onend = null;
      utterance.onerror = null;
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      logger.debug('Local speech synthesis completed.');
      resolve({ base64: null, mimeType: null });
    };

    const rejectOnce = error => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      logger.error('Local speech synthesis failed.', { error });
      reject(error);
    };

    utterance.onend = () => {
      resolveOnce();
    };

    utterance.onerror = event => {
      const message = event?.error || event?.message || 'Speech synthesis failed.';
      rejectOnce(new Error(message));
    };

    try {
      if (synth.speaking || synth.pending) {
        synth.cancel();
      }
      const result = synth.speak(utterance);
      if (result && typeof result.catch === 'function') {
        result.catch(rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}
