import { describe, expect, it } from 'vitest';
import { chunkTextByTokens } from '../utils/textChunker.js';
import { estimateTokens } from '../utils/tokenizer.js';

describe('chunkTextByTokens', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkTextByTokens('', 10)).toEqual([]);
    expect(chunkTextByTokens('   ', 10)).toEqual([]);
  });

  it('respects the token cap when chunking sentences', () => {
    const text = 'First sentence is brief. Second sentence is a little longer. Third one keeps it concise. Fourth wraps things up neatly.';
    const maxTokens = 8;
    const chunks = chunkTextByTokens(text, maxTokens);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(maxTokens);
    }
    expect(chunks.join(' ')).toContain('Fourth wraps things up neatly.');
  });

  it('supports sentence overlap when capacity allows', () => {
    const text = 'Short one. Another short sentence. Final note.';
    const chunks = chunkTextByTokens(text, 10, { sentenceOverlap: 1 });

    expect(chunks).toEqual([
      'Short one. Another short sentence.',
      'Another short sentence. Final note.',
    ]);
  });

  it('falls back to word-based chunks when a sentence exceeds the limit', () => {
    const text = 'This sentence contains many individual words designed to force the chunker into splitting the content at the word boundary level when the token estimation deems it too large to fit.';
    const maxTokens = 12;
    const chunks = chunkTextByTokens(text, maxTokens);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('does not duplicate prior sentences when splitting oversized sentences with overlap', () => {
    const longSentence = 'This sentence is intentionally constructed to be quite long so that it exceeds the maximum token threshold when evaluated by the heuristic splitter and therefore needs to be divided into several smaller pieces that still read coherently.';
    const text = `A. ${longSentence} B.`;
    const chunks = chunkTextByTokens(text, 40, { sentenceOverlap: 1 });

    expect(chunks[0]).toBe('A.');
    expect(chunks).not.toContain('A. B.');
    expect(chunks[chunks.length - 1]).toContain('B.');
  });

  it('splits lengthy words into character-based chunks', () => {
    const longWord = `${'supercalifragilisticexpialidocious'.repeat(5)}.`;
    const maxTokens = 10;
    const chunks = chunkTextByTokens(longWord, maxTokens);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(maxTokens);
    }
    expect(chunks.join('')).toBe(longWord);
  });
});
