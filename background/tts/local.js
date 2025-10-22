import createLogger from '../../utils/logger.js';

/**
 * Creates a Chrome text-to-speech adapter that delegates synthesis to the
 * browser's built-in `chrome.tts` API.
 *
 * @param {{ logger?: object }} [options] - Optional logger override used to
 *   integrate with existing log scopes. The logger should expose `info`,
 *   `warn`, and `error` methods.
 * @returns {{ id: string, type: string, synthesise: Function }} Adapter
 *   implementation compatible with the TTS registry.
 */
export function createLocalTtsAdapter({ logger } = {}) {
  const localLogger = logger || createLogger({ name: 'tts-local' });

  return {
    id: 'local',
    type: 'local',
    async synthesise({ text, voice, languageCode }) {
      const phrase = typeof text === 'string' ? text.trim() : '';
      if (!phrase) {
        localLogger.warn('Local TTS request ignored due to empty text input.');
        return { base64: null, mimeType: null };
      }

      if (!chrome?.tts || typeof chrome.tts.speak !== 'function') {
        throw new Error('Local text-to-speech is not available in this environment.');
      }

      localLogger.info('Dispatching Chrome TTS request.', {
        voice,
        language: languageCode,
        textLength: phrase.length,
      });

      return new Promise((resolve, reject) => {
        const options = {};
        if (voice) {
          options.voiceName = voice;
        }
        if (languageCode) {
          options.lang = languageCode;
        }

        options.onEvent = event => {
          if (!event) {
            return;
          }
          if (event.type === 'error') {
            const message = event.errorMessage || 'Local text-to-speech failed.';
            localLogger.error('Chrome TTS reported an error.', { event });
            reject(new Error(message));
          } else if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'stopped') {
            localLogger.debug('Chrome TTS playback finished.', { type: event.type });
            resolve({ base64: null, mimeType: null });
          }
        };

        try {
          if (typeof chrome.tts.stop === 'function') {
            chrome.tts.stop();
          }
          chrome.tts.speak(phrase, options);
        } catch (error) {
          localLogger.error('Chrome TTS invocation failed.', { error });
          reject(error);
        }
      });
    },
  };
}

export default createLocalTtsAdapter;

