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

function normaliseProviderId(value, fallback = DEFAULT_PROVIDER_ID) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || fallback;
}

function listProviders() {
  return PROVIDERS.map(provider => ({ ...provider }));
}

function findProvider(providerId) {
  const normalised = normaliseProviderId(providerId, providerId);
  return PROVIDERS.find(provider => provider.id === normalised) || null;
}

function resolveAlias(providerId) {
  if (!providerId) {
    return providerId;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  return PROVIDER_ALIASES[normalised] || normalised;
}

function providerRequiresApiKey(providerId) {
  const provider = findProvider(providerId);
  if (!provider) {
    return true;
  }
  return provider.requiresApiKey !== false;
}

function capitaliseWords(value) {
  return value.replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

function getProviderDisplayName(providerId) {
  if (!providerId) {
    return 'Provider';
  }
  const provider = findProvider(providerId);
  if (provider && provider.label) {
    return provider.label;
  }
  const normalised = normaliseProviderId(providerId, providerId);
  return capitaliseWords(normalised);
}

function isSupportedProvider(providerId) {
  return Boolean(findProvider(providerId));
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
