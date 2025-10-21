import { estimateTokens } from './tokenizer.js';

const SENTENCE_ENDINGS = new Set(['.', '!', '?']);

/**
 * Splits text into sentences while preserving trailing punctuation.
 *
 * @param {string} text The source text.
 * @returns {string[]} An array of trimmed sentences.
 */
function splitIntoSentences(text) {
  const sentences = [];
  let buffer = '';

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    buffer += character;

    if (character === '\n' || character === '\r') {
      if (buffer.trim()) {
        sentences.push(buffer.trim());
      }
      buffer = '';
      continue;
    }

    if (SENTENCE_ENDINGS.has(character)) {
      const nextCharacter = text[index + 1];
      if (!nextCharacter || /\s/.test(nextCharacter)) {
        if (buffer.trim()) {
          sentences.push(buffer.trim());
        }
        buffer = '';
      }
    }
  }

  if (buffer.trim()) {
    sentences.push(buffer.trim());
  }

  return sentences;
}

/**
 * Splits an oversized sentence into token-bounded chunks using whitespace.
 *
 * @param {string} sentence The sentence to split.
 * @param {number} maxTokens The maximum tokens per chunk.
 * @returns {string[]} The derived chunks.
 */
function splitSentenceByWords(sentence, maxTokens) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const word of words) {
    const trimmedWord = word.trim();

    if (!trimmedWord) {
      continue;
    }

    const candidate = current ? `${current} ${trimmedWord}` : trimmedWord;

    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      pushCurrent();
    }

    if (estimateTokens(trimmedWord) <= maxTokens) {
      current = trimmedWord;
      continue;
    }

    const wordSegments = splitWordByCharacters(trimmedWord, maxTokens);

    if (wordSegments.length === 0) {
      continue;
    }

    for (let index = 0; index < wordSegments.length - 1; index += 1) {
      chunks.push(wordSegments[index]);
    }

    current = wordSegments[wordSegments.length - 1];
  }

  pushCurrent();

  return chunks;
}

/**
 * Splits an oversized word by characters to satisfy the token heuristic.
 *
 * @param {string} word The word to split.
 * @param {number} maxTokens The token limit per chunk.
 * @returns {string[]} The resulting chunks.
 */
function splitWordByCharacters(word, maxTokens) {
  if (!word) {
    return [];
  }

  const maxCharacters = Math.max(1, Math.floor(maxTokens * 4));
  const segments = [];
  let start = 0;

  while (start < word.length) {
    let end = Math.min(word.length, start + maxCharacters);
    let segment = word.slice(start, end);

    while (segment.length > 1 && estimateTokens(segment) > maxTokens) {
      end -= 1;
      segment = word.slice(start, end);
    }

    if (!segment) {
      break;
    }

    segments.push(segment);
    start = end;
  }

  return segments;
}

/**
 * Ensures the overlap buffer does not exceed the configured token ceiling.
 *
 * @param {string[]} sentences The candidate overlap sentences.
 * @param {number} maxTokens The maximum tokens per chunk.
 * @returns {{ sentences: string[]; text: string }} The normalised overlap buffer.
 */
function normaliseOverlap(sentences, maxTokens) {
  if (!sentences.length) {
    return { sentences: [], text: '' };
  }

  const normalised = [];

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const candidate = normalised.length ? `${normalised.join(' ')} ${sentence}` : sentence;

    if (estimateTokens(candidate) <= maxTokens) {
      normalised.push(sentence);
      continue;
    }

    break;
  }

  const text = normalised.join(' ');

  return { sentences: normalised, text };
}

/**
 * Splits text into token-bounded chunks.
 *
 * @param {string} text The text to chunk.
 * @param {number} maxTokens The token cap per chunk.
 * @param {{ sentenceOverlap?: number }} [options] Additional chunking options.
 * @returns {string[]} The generated chunks.
 */
export function chunkTextByTokens(text, maxTokens, options = {}) {
  if (typeof text !== 'string') {
    return [];
  }

  const trimmed = text.trim();

  if (!trimmed) {
    return [];
  }

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return [];
  }

  const { sentenceOverlap = 0 } = options;
  const overlapCount = Math.max(0, Math.floor(sentenceOverlap));
  const sentences = splitIntoSentences(trimmed);

  if (!sentences.length) {
    return [];
  }

  const chunks = [];
  let bufferSentences = [];
  let bufferText = '';
  let hasFreshContent = false;

  const setOverlap = () => {
    if (!overlapCount) {
      bufferSentences = [];
      bufferText = '';
      hasFreshContent = false;
      return;
    }

    const overlapSentences = bufferSentences.slice(-overlapCount);
    const { sentences: normalised, text } = normaliseOverlap(overlapSentences, maxTokens);
    bufferSentences = [...normalised];
    bufferText = text;
    hasFreshContent = false;
  };

  const pushBuffer = () => {
    if (!bufferSentences.length || !hasFreshContent) {
      return;
    }

    const chunk = bufferText.trim();

    if (!chunk) {
      setOverlap();
      return;
    }

    chunks.push(chunk);
    setOverlap();
  };

  const addSentenceToBuffer = (sentence) => {
    const candidateText = bufferText ? `${bufferText} ${sentence}` : sentence;

    if (estimateTokens(candidateText) > maxTokens) {
      return false;
    }

    bufferSentences.push(sentence);
    bufferText = candidateText;
    hasFreshContent = true;
    return true;
  };

  for (const sentence of sentences) {
    if (!sentence) {
      continue;
    }

    const sentenceTokens = estimateTokens(sentence);

    if (sentenceTokens > maxTokens) {
      pushBuffer();
      setOverlap();
      const wordChunks = splitSentenceByWords(sentence, maxTokens);
      const validWordChunks = [];

      for (const chunk of wordChunks) {
        if (!chunk) {
          continue;
        }
        chunks.push(chunk);
        validWordChunks.push(chunk);
      }

      if (overlapCount) {
        const overlapCandidates = validWordChunks.slice(-overlapCount);

        if (overlapCandidates.length) {
          const { sentences: normalised, text } = normaliseOverlap(overlapCandidates, maxTokens);
          bufferSentences = [...normalised];
          bufferText = text;
        } else {
          bufferSentences = [];
          bufferText = '';
        }
      } else {
        bufferSentences = [];
        bufferText = '';
      }

      hasFreshContent = false;

      continue;
    }

    if (addSentenceToBuffer(sentence)) {
      continue;
    }

    pushBuffer();

    if (addSentenceToBuffer(sentence)) {
      continue;
    }

    bufferSentences = [];
    bufferText = '';
    hasFreshContent = false;

    if (!addSentenceToBuffer(sentence)) {
      chunks.push(sentence);
      setOverlap();
    }
  }

  if (hasFreshContent && bufferSentences.length) {
    chunks.push(bufferText.trim());
  }

  return chunks;
}

export default chunkTextByTokens;
