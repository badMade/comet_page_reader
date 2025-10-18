const MESSAGES = {
  en: {
    apiKeyLabel: 'OpenAI API key',
    save: 'Save',
    summarise: 'Summarise page',
    readAloud: 'Read aloud',
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

export function setLocale(locale) {
  if (MESSAGES[locale]) {
    activeLocale = locale;
  }
}

export function getLocale() {
  return activeLocale;
}

export function t(key) {
  const table = MESSAGES[activeLocale] || MESSAGES.en;
  return table[key] || key;
}

export function availableLocales() {
  return Object.keys(MESSAGES);
}

export function withLocale(locale, fn) {
  const previous = activeLocale;
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale(previous);
  }
}
