export const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';
export const SAMPLE_LANGUAGE = 'en';
export const SAMPLE_VOICE = 'alloy';
export const SAMPLE_FORMAT = 'mp3';

/**
 * Builds a representative adapter configuration for the supplied provider key.
 *
 * @param {string} providerKey - Identifier used to namespace endpoints.
 * @returns {{
 *   model: string,
 *   apiUrl: string,
 *   transcriptionUrl: string,
 *   ttsUrl: string,
 *   temperature: number,
 *   headers: Record<string, string>,
 * }} Mock configuration object consumed by adapter tests.
 */
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

/**
 * Parses the JSON payload embedded in placeholder adapter error messages.
 *
 * @param {Error} error - Error thrown by a placeholder adapter invocation.
 * @returns {Record<string, unknown>} Deserialised payload captured in the message.
 * @throws {Error} When the error message does not contain a JSON payload.
 */
export function extractPlaceholderPayload(error) {
  const match = /Expected(?: transcription| synthesis)? request: (\{.*\})$/.exec(error.message);
  if (!match) {
    throw new Error(`Unable to extract payload from error: ${error.message}`);
  }
  return JSON.parse(match[1]);
}
