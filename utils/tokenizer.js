const CUSTOM_TOKENIZER_KEY = '__COMET_TOKENIZER__';

const globalScope = typeof globalThis !== 'undefined'
  ? globalThis
  : typeof window !== 'undefined'
    ? window
    : typeof global !== 'undefined'
      ? global
      : {};

/**
 * Attempts to resolve a custom tokenizer supplied through the global scope.
 *
 * @returns {(input: string) => number | null} The tokenizer callback when present.
 */
function resolveCustomTokenizer() {
  const candidate = globalScope[CUSTOM_TOKENIZER_KEY];

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'function') {
    return candidate;
  }

  if (typeof candidate === 'object' && typeof candidate.estimateTokens === 'function') {
    return (value) => candidate.estimateTokens(value);
  }

  return null;
}

/**
 * Normalises a numeric output from a tokenizer to an integer count.
 *
 * @param {unknown} value The raw output from a tokenizer implementation.
 * @returns {number | null} The coerced token count when valid.
 */
function normaliseTokenCount(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, Math.ceil(numericValue));
}

/**
 * Estimates the number of tokens consumed by a string.
 *
 * If a custom tokenizer is available via the global `__COMET_TOKENIZER__` hook
 * it will be used. Otherwise a heuristic approximation of characters divided by
 * four is returned.
 *
 * @param {string} input The text to evaluate.
 * @returns {number} The estimated number of tokens.
 */
export function estimateTokens(input) {
  if (!input) {
    return 0;
  }

  const text = typeof input === 'string' ? input : String(input);

  const customTokenizer = resolveCustomTokenizer();

  if (customTokenizer) {
    try {
      const customResult = customTokenizer(text);
      const tokenCount = normaliseTokenCount(customResult);

      if (tokenCount !== null) {
        return tokenCount;
      }
    } catch (error) {
      // Swallow errors and fall back to the heuristic approximation below.
    }
  }

  if (!text.length) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

export default estimateTokens;
