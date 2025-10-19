import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicAdapter } from '../background/adapters/anthropic.js';
import { MistralAdapter } from '../background/adapters/mistral.js';
import { HuggingFaceAdapter } from '../background/adapters/huggingface.js';
import { OllamaAdapter } from '../background/adapters/ollama.js';
import {
  SAMPLE_TEXT,
  SAMPLE_LANGUAGE,
  SAMPLE_VOICE,
  SAMPLE_FORMAT,
  createAdapterConfig,
  extractPlaceholderPayload,
} from './fixtures/provider-adapter-fixtures.js';

function assertSummarisePlaceholder(Adapter, providerKey) {
  const adapter = new Adapter(createAdapterConfig(providerKey));
  let captured;
  try {
    adapter.summarise({ apiKey: 'test-key', text: SAMPLE_TEXT, language: SAMPLE_LANGUAGE });
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.match(captured.message, /adapter placeholder/);
  const payload = extractPlaceholderPayload(captured);
  assert.equal(payload.endpoint, `https://api.${providerKey}.example/v1/chat`);
  assert.equal(payload.model, `${providerKey}-model`);
  assert.equal(payload.temperature, 0.42);
  assert.equal(payload.textLength, SAMPLE_TEXT.length);
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'You are a helpful assistant that creates short spoken summaries.' },
    { role: 'user', content: 'Provide a concise summary in en.' },
  ]);
}

function assertTranscribePlaceholder(Adapter, providerKey) {
  const adapter = new Adapter(createAdapterConfig(providerKey));
  let captured;
  try {
    adapter.transcribe({ apiKey: 'test-key', mimeType: 'audio/webm' });
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.match(captured.message, /adapter placeholder/);
  const payload = extractPlaceholderPayload(captured);
  assert.equal(payload.endpoint, `https://api.${providerKey}.example/v1/transcribe`);
  assert.equal(payload.model, `${providerKey}-transcribe`);
  assert.equal(payload.mimeType, 'audio/webm');
}

function assertSynthesisePlaceholder(Adapter, providerKey) {
  const adapter = new Adapter(createAdapterConfig(providerKey));
  let captured;
  try {
    adapter.synthesise({ apiKey: 'test-key', format: SAMPLE_FORMAT, voice: SAMPLE_VOICE });
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.match(captured.message, /adapter placeholder/);
  const payload = extractPlaceholderPayload(captured);
  assert.equal(payload.endpoint, `https://api.${providerKey}.example/v1/tts`);
  assert.equal(payload.model, `${providerKey}-tts`);
  assert.equal(payload.format, SAMPLE_FORMAT);
  assert.equal(payload.voice, SAMPLE_VOICE);
}

function assertMissingKey(Adapter, providerKey) {
  const adapter = new Adapter(createAdapterConfig(providerKey));
  assert.throws(() => adapter.summarise({ apiKey: null, text: SAMPLE_TEXT, language: SAMPLE_LANGUAGE }), error => {
    assert.equal(error.message, `Missing ${providerKey.charAt(0).toUpperCase() + providerKey.slice(1)} API key.`);
    return true;
  });
}

const adapters = [
  ['anthropic', AnthropicAdapter],
  ['mistral', MistralAdapter],
  ['huggingface', HuggingFaceAdapter],
  ['ollama', OllamaAdapter],
];

for (const [providerKey, Adapter] of adapters) {
  test(`${providerKey} adapter surfaces placeholder payloads`, () => {
    assertSummarisePlaceholder(Adapter, providerKey);
    assertTranscribePlaceholder(Adapter, providerKey);
    assertSynthesisePlaceholder(Adapter, providerKey);
    assertMissingKey(Adapter, providerKey);
  });
}
