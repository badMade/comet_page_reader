export const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';
export const SAMPLE_LANGUAGE = 'en';
export const SAMPLE_VOICE = 'alloy';
export const SAMPLE_FORMAT = 'mp3';

export function createAdapterConfig(providerKey) {
  const baseUrl = `https://api.${providerKey}.example/v1`;
  return {
    model: `${providerKey}-model`,
    apiUrl: `${baseUrl}/chat`,
    transcriptionUrl: `${baseUrl}/transcribe`,
    ttsUrl: `${baseUrl}/tts`,
    temperature: 0.42,
    headers: { 'X-Test-Provider': providerKey },
  };
}

export function extractPlaceholderPayload(error) {
  const match = /Expected(?: transcription| synthesis)? request: (\{.*\})$/.exec(error.message);
  if (!match) {
    throw new Error(`Unable to extract payload from error: ${error.message}`);
  }
  return JSON.parse(match[1]);
}
