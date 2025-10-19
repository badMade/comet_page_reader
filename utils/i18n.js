/**
 * Lightweight internationalisation helpers powering the popup interface.
 *
 * @module utils/i18n
 */

/**
 * Static localisation messages used across the popup UI. Extend the structure
 * when adding new locales or strings.
 */
const MESSAGES = {
  en: {
    apiKeyLabel: 'OpenAI API key',
    save: 'Save',
    summarise: 'Summarise page',
    readAloud: 'Read aloud',
    readPage: 'Read full page',
    pushToTalk: 'Push to talk',
    listening: 'Listening… release to stop',
    usage: 'Usage this cycle',
    resetUsage: 'Reset usage',
    costLimitReached: 'Cost limit reached. Try again after resetting usage.',
    disclaimer:
      'Content is processed via OpenAI APIs. Review the privacy notice before using in sensitive contexts.',
  },
  es: {
    apiKeyLabel: 'Clave de API de OpenAI',
    save: 'Guardar',
    summarise: 'Resumir página',
    readAloud: 'Leer en voz alta',
    readPage: 'Leer página completa',
    pushToTalk: 'Pulsa para hablar',
    listening: 'Escuchando… suelta para detener',
    usage: 'Uso en este ciclo',
    resetUsage: 'Restablecer uso',
    costLimitReached: 'Se alcanzó el límite de coste. Restablece el uso para continuar.',
    disclaimer:
      'El contenido se procesa mediante las API de OpenAI. Consulta el aviso de privacidad antes de usarlo en contextos sensibles.',
  },
};

let activeLocale = 'en';

/**
 * Updates the active locale if translations are available.
 *
 * @param {string} locale - ISO language code.
 */
export function setLocale(locale) {
  if (MESSAGES[locale]) {
    activeLocale = locale;
  }
}

/**
 * Returns the currently active locale code.
 *
 * @returns {string} Selected locale.
 */
export function getLocale() {
  return activeLocale;
}

/**
 * Resolves the translation for the provided key, falling back to English when
 * necessary.
 *
 * @param {string} key - Translation key.
 * @returns {string} Localised string or the key when missing.
 */
export function t(key) {
  const table = MESSAGES[activeLocale] || MESSAGES.en;
  return table[key] || key;
}

/**
 * Lists all supported locale codes.
 *
 * @returns {string[]} Locale codes.
 */
export function availableLocales() {
  return Object.keys(MESSAGES);
}

/**
 * Temporarily sets a locale for the duration of the provided function.
 *
 * @param {string} locale - Locale code to apply.
 * @param {Function} fn - Function executed under the temporary locale.
 * @returns {*} Result of the provided function.
 */
export function withLocale(locale, fn) {
  const previous = activeLocale;
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale(previous);
  }
}
