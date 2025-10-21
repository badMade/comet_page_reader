import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../utils/tokenizer.js';

describe('estimateTokens', () => {
  const originalTokenizer = globalThis.__COMET_TOKENIZER__;

  afterEach(() => {
    globalThis.__COMET_TOKENIZER__ = originalTokenizer;
  });

  it('returns zero for falsy input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('falls back to the characters divided by four heuristic', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('prefers a custom tokenizer when available', () => {
    globalThis.__COMET_TOKENIZER__ = (value) => value.length * 2;
    expect(estimateTokens('custom')).toBe(12);
  });

  it('ignores invalid custom tokenizer results and uses the heuristic', () => {
    globalThis.__COMET_TOKENIZER__ = () => Number.NaN;
    expect(estimateTokens('fallback')).toBe(Math.ceil('fallback'.length / 4));
  });
});
