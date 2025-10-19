import createLogger from './logger.js';

const logger = createLogger({ name: 'providers-registry' });

const DEFAULT_PROVIDER_ID = 'auto';

const PROVIDER_ALIASES = Object.freeze({
  openai: 'openai_paid',
  mistral: 'mistral_paid',
  anthropic: 'anthropic_paid',
  gemini: 'gemini_paid',
  huggingface: 'huggingface_free',
});

const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto (Free-first)', requiresApiKey: false }),
  Object.freeze({ id: 'ollama', label: 'Ollama (Local)', requiresApiKey: false }),
  Object.freeze({ id: 'huggingface_free', label: 'Hugging Face (Free/Tier)', requiresApiKey: true }),
  Object.freeze({ id: 'gemini_free', label: 'Google Gemini (AI Studio Free/Trial)', requiresApiKey: true }),
  Object.freeze({ id: 'openai_trial', label: 'OpenAI (Trial)', requiresApiKey: true }),
  Object.freeze({ id: 'mistral_trial', label: 'Mistral (Trial)', requiresApiKey: true }),
  Object.freeze({ id: 'gemini_paid', label: 'Google Gemini (Paid/Vertex)', requiresApiKey: true }),
  Object.freeze({ id: 'openai_paid', label: 'OpenAI (Paid)', requiresApiKey: true }),
  Object.freeze({ id: 'anthropic_paid', label: 'Anthropic (Paid)', requiresApiKey: true }),
  Object.freeze({ id: 'mistral_paid', label: 'Mistral (Paid)', requiresApiKey: true }),
  Object.freeze({ id: 'openai', label: 'OpenAI (Legacy)', requiresApiKey: true }),
  Object.freeze({ id: 'anthropic', label: 'Anthropic (Legacy)', requiresApiKey: true }),
  Object.freeze({ id: 'mistral', label: 'Mistral (Legacy)', requiresApiKey: true }),
  Object.freeze({ id: 'huggingface', label: 'Hugging Face (Legacy)', requiresApiKey: true }),
  Object.freeze({ id: 'gemini', label: 'Google Gemini (Legacy)', requiresApiKey: true }),
]);

/**
 * Normalises provider identifiers, trimming whitespace and lowering the case
 * while falling back to a sensible default when the input is invalid.
 *
 * @param {string} value - Candidate provider identifier.
 * @param {string} [fallback=DEFAULT_PROVIDER_ID] - Value returned when the
 *   input is missing.
 * @returns {string} Sanitised provider identifier.
 */
function normaliseProviderId(value, fallback = DEFAULT_PROVIDER_ID) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || fallback;
}

/**
 * Returns a copy of the provider catalogue describing each adapter exposed to
 * the user interface.
 *
 * @returns {Array<{id: string, label: string, requiresApiKey: boolean}>}
 *   Provider definitions ordered for display.
 */
function listProviders() {
  logger.trace('Listing providers.', { count: PROVIDERS.length });
  return PROVIDERS.map(provider => ({ ...provider }));
}

function findProvider(providerId) {
  const normalised = normaliseProviderId(providerId, providerId);
  const provider = PROVIDERS.find(candidate => candidate.id === normalised) || null;
  if (!provider) {
    logger.debug('Requested provider not found.', { providerId, normalised });
  }
  return provider;
}

/**
 * Normalises provider identifiers so legacy aliases resolve to the modern
 * provider IDs expected by the router and adapters.
 *
 * @param {string} providerId - Provider identifier or alias.
 * @returns {string} Canonical provider identifier.
 */
function resolveAlias(providerId) {
  if (!providerId) {
    return providerId;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  const resolved = PROVIDER_ALIASES[normalised] || normalised;
  if (resolved !== normalised) {
    logger.debug('Resolved provider alias.', { providerId, resolved });
  }
  return resolved;
}

/**
 * Indicates whether the selected provider requires an API key. Unknown
 * providers default to requiring authentication.
 *
 * @param {string} providerId - Provider identifier to evaluate.
 * @returns {boolean} True when an API key is mandatory.
 */
function providerRequiresApiKey(providerId) {
  const provider = findProvider(providerId);
  if (!provider) {
    logger.error('Checking API key requirement for unknown provider.', { providerId });
    return true;
  }
  return provider.requiresApiKey !== false;
}

function capitaliseWords(value) {
  return value.replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

/**
 * Generates a human-readable label for the given provider. Custom display names
 * fall back to a capitalised identifier when metadata is missing.
 *
 * @param {string} providerId - Provider identifier or alias.
 * @returns {string} Render-friendly provider label.
 */
function getProviderDisplayName(providerId) {
  if (!providerId) {
    return 'Provider';
  }
  const provider = findProvider(providerId);
  if (provider && provider.label) {
    logger.trace('Using provider display label.', { providerId: provider.id });
    return provider.label;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  logger.debug('Falling back to generated provider name.', { providerId, normalised });
  return capitaliseWords(normalised);
}

/**
 * Determines whether the supplied provider identifier is recognised by the
 * extension.
 *
 * @param {string} providerId - Provider identifier or alias.
 * @returns {boolean} True when the provider is available.
 */
function isSupportedProvider(providerId) {
  const supported = Boolean(findProvider(providerId));
  logger.trace('Provider support check.', { providerId, supported });
  return supported;
}

export {
  DEFAULT_PROVIDER_ID,
  getProviderDisplayName,
  isSupportedProvider,
  listProviders,
  normaliseProviderId,
  resolveAlias,
  providerRequiresApiKey,
};
