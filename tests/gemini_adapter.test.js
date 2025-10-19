import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiAdapter } from '../background/adapters/gemini.js';

function createAdapter(overrides = {}, options = {}) {
  const baseConfig = {
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-1.5-flash-latest',
    temperature: 0.25,
    headers: { 'X-Test': 'true' },
    ...overrides,
  };
  return new GeminiAdapter(baseConfig, options);
}

test('summarise posts payloads with key query parameter and returns usage metadata', async () => {
  let capturedRequest;
  const fetchStub = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'models/gemini-1.5-flash-latest',
        candidates: [
          {
            content: {
              parts: [
                { text: '  Summary line one.  ' },
                { text: 'Second line.' },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 321,
          candidatesTokenCount: 45,
        },
      }),
    };
  };

  const adapter = createAdapter({}, { fetchImpl: fetchStub });
  const result = await adapter.summarise({
    apiKey: 'test-key',
    text: 'Webpage content',
    language: 'English',
  });

  assert.ok(capturedRequest, 'fetch was not called');
  assert.equal(
    capturedRequest.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=test-key',
  );
  assert.equal(capturedRequest.options.method, 'POST');
  assert.equal(capturedRequest.options.headers['Content-Type'], 'application/json');
  assert.equal(capturedRequest.options.headers['X-Test'], 'true');

  const payload = JSON.parse(capturedRequest.options.body);
  assert.equal(payload.contents[0].role, 'user');
  assert.match(payload.contents[0].parts[0].text, /Webpage content/);
  assert.equal(payload.generationConfig.temperature, 0.25);

  assert.deepEqual(result, {
    summary: 'Summary line one.\nSecond line.',
    model: 'gemini-1.5-flash-latest',
    promptTokens: 321,
    completionTokens: 45,
  });
});

test('summarise surfaces HTTP errors verbosely', async () => {
  const fetchStub = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => '{"error":{"message":"denied"}}',
  });
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  await assert.rejects(
    adapter.summarise({ apiKey: 'key', text: 'text', language: 'en' }),
    error => {
      assert.match(error.message, /Gemini error \(403 Forbidden\):/);
      assert.match(error.message, /denied/);
      return true;
    },
  );
});

test('summarise requires an API key', async () => {
  const adapter = createAdapter();
  await assert.rejects(
    adapter.summarise({ apiKey: '', text: 'content', language: 'en' }),
    error => {
      assert.equal(error.message, 'Missing Gemini API key.');
      return true;
    },
  );
});

test('transcription and speech helpers are not implemented', async () => {
  const adapter = createAdapter();
  await assert.rejects(
    adapter.transcribe({ apiKey: 'key', base64: '', mimeType: 'audio/webm' }),
    error => {
      assert.equal(error.message, 'Gemini transcription is not supported.');
      return true;
    },
  );

  await assert.rejects(
    adapter.synthesise({ apiKey: 'key', text: 'Hello world' }),
    error => {
      assert.equal(error.message, 'Gemini speech synthesis is not supported.');
      return true;
    },
  );
});

test('getCostMetadata identifies the configured model', () => {
  const adapter = createAdapter({ model: 'gemini-1.5-pro' });
  const metadata = adapter.getCostMetadata();

  assert.equal(metadata.summarise.model, 'gemini-1.5-pro');
  assert.equal(metadata.transcribe.flatCost, 0);
  assert.equal(metadata.synthesise.flatCost, 0);
});
