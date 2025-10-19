const DEFAULT_PROVIDER_ID = 'openai';

const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai', label: 'OpenAI', requiresApiKey: true }),
  Object.freeze({ id: 'anthropic', label: 'Anthropic', requiresApiKey: true }),
  Object.freeze({ id: 'mistral', label: 'Mistral', requiresApiKey: true }),
  Object.freeze({ id: 'huggingface', label: 'Hugging Face', requiresApiKey: true }),
  Object.freeze({ id: 'ollama', label: 'Ollama (local)', requiresApiKey: false }),
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
  providerRequiresApiKey,
};
