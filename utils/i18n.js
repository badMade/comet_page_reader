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
    apiKeyLabel: 'LLM API key',
    providerLabel: 'LLM provider',
    save: 'Save',
    summarise: 'Summarize page',
    readAloud: 'Read aloud',
    readPage: 'Read full page',
    pushToTalk: 'Push to talk',
    listening: 'Listening… release to stop',
    playbackSpeedLabel: 'Playback speed',
    usage: 'Tokens this cycle',
    resetUsage: 'Reset token usage',
    costLimitReached: 'Token limit reached. Reset usage to continue.',
    usageLimitLabel: 'Token limit',
    usageTotalLabel: 'Tokens used',
    usagePromptLabel: 'Prompt tokens',
    usageCompletionLabel: 'Completion tokens',
    usageLastResetLabel: 'Last reset',
    usageLastResetUnknown: 'Unknown',
    disclaimer:
      'Content is processed via your configured AI provider. Review the privacy notice before using in sensitive contexts.',
  },
  es: {
    apiKeyLabel: 'Clave de API de LLM',
    providerLabel: 'Proveedor de LLM',
    save: 'Guardar',
    summarise: 'Resumir página',
    readAloud: 'Leer en voz alta',
    readPage: 'Leer página completa',
    pushToTalk: 'Pulsa para hablar',
    listening: 'Escuchando… suelta para detener',
    playbackSpeedLabel: 'Velocidad de reproducción',
    usage: 'Tokens en este ciclo',
    resetUsage: 'Restablecer tokens',
    costLimitReached: 'Se alcanzó el límite de tokens. Restablece los tokens para continuar.',
    usageLimitLabel: 'Límite de tokens',
    usageTotalLabel: 'Tokens utilizados',
    usagePromptLabel: 'Tokens de entrada',
    usageCompletionLabel: 'Tokens de salida',
    usageLastResetLabel: 'Último reinicio',
    usageLastResetUnknown: 'Desconocido',
    disclaimer:
      'El contenido se procesa mediante el proveedor de IA configurado. Consulta el aviso de privacidad antes de usarlo en contextos sensibles.',
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
