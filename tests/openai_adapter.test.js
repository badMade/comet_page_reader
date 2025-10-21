import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIAdapter } from '../background/adapters/openai.js';

function createAdapter(overrides = {}, options = {}) {
  const baseConfig = {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    transcriptionUrl: 'https://api.openai.com/v1/audio/transcriptions',
    ttsUrl: 'https://api.openai.com/v1/audio/speech',
    model: 'gpt-4o-mini',
    temperature: 0.42,
    headers: { 'X-Test': 'true' },
    ...overrides,
  };
  return new OpenAIAdapter(baseConfig, options);
}

test('uses the global fetch with the correct binding when no override is provided', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = function serviceWorkerFetch(url, options) {
    if (this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    callCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-4o-mini',
        choices: [
          { message: { content: 'service worker summary' } },
        ],
        usage: {},
      }),
    };
  };

  const adapter = createAdapter();

  try {
    const result = await adapter.summarise({
      apiKey: 'worker-key',
      text: 'Content from worker',
      language: 'English',
    });

    assert.equal(callCount, 1, 'global fetch should be invoked exactly once');
    assert.equal(result.summary, 'service worker summary');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('summarise posts payloads with config defaults and trims the response', async () => {
  let capturedRequest;
  const fetchStub = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-4o-mini',
        choices: [
          { message: { content: '  summarised text  ' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };

  const adapter = createAdapter({}, { fetchImpl: fetchStub });
  const result = await adapter.summarise({ apiKey: 'test-key', text: 'Sample text', language: 'English' });

  assert.ok(capturedRequest, 'fetch was not called');
  assert.equal(capturedRequest.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capturedRequest.options.method, 'POST');

  const headers = capturedRequest.options.headers;
  assert.equal(headers.Authorization, 'Bearer test-key');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['X-Test'], 'true');

  const payload = JSON.parse(capturedRequest.options.body);
  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.temperature, 0.42);
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[1].content, /Sample text/);

  assert.deepEqual(result, {
    summary: 'summarised text',
    model: 'gpt-4o-mini',
    promptTokens: 10,
    completionTokens: 5,
  });
});

test('summarise surfaces API failures with the response body', async () => {
  const fetchStub = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
  });
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  await assert.rejects(
    adapter.summarise({ apiKey: 'key', text: 'text', language: 'en' }),
    error => {
      assert.match(error.message, /OpenAI error \(429\): rate limited/);
      return true;
    },
  );
});

test('summarise requires an API key', async () => {
  const adapter = createAdapter();
  await assert.rejects(
    adapter.summarise({ apiKey: '', text: 'text', language: 'en' }),
    error => {
      assert.equal(error.message, 'Missing OpenAI API key.');
      return true;
    },
  );
});

test('transcribe posts binary payloads built from base64 input', async () => {
  const originalAtob = globalThis.atob;
  globalThis.atob = undefined;
  let capturedRequest;
  const fetchStub = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: 'transcribed speech' }),
    };
  };
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  try {
    const result = await adapter.transcribe({
      apiKey: 'abc123',
      base64: Buffer.from('audio-bytes').toString('base64'),
      filename: 'input.webm',
      mimeType: 'audio/webm',
    });

    assert.ok(capturedRequest, 'fetch was not called');
    assert.equal(capturedRequest.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(capturedRequest.options.method, 'POST');

    const headers = capturedRequest.options.headers;
    assert.equal(headers.Authorization, 'Bearer abc123');
    assert.equal(headers['X-Test'], 'true');

    const formData = capturedRequest.options.body;
    assert.equal(formData.get('model'), 'gpt-4o-mini-transcribe');
    const file = formData.get('file');
    assert.equal(file.name, 'input.webm');
    assert.equal(file.type, 'audio/webm');
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    assert.equal(fileBuffer.toString(), 'audio-bytes');

    assert.deepEqual(result, { text: 'transcribed speech' });
  } finally {
    globalThis.atob = originalAtob;
  }
});

test('transcribe surfaces errors from the API', async () => {
  const fetchStub = async () => ({
    ok: false,
    status: 500,
    text: async () => 'upstream failure',
  });
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  await assert.rejects(
    adapter.transcribe({ apiKey: 'abc', base64: Buffer.from('1').toString('base64') }),
    error => {
      assert.match(error.message, /Transcription failed \(500\): upstream failure/);
      return true;
    },
  );
});

test('transcribe fails fast when base64 conversion is unsupported', async () => {
  const originalAtob = globalThis.atob;
  const originalBuffer = globalThis.Buffer;
  globalThis.atob = undefined;
  globalThis.Buffer = undefined;
  let calledFetch = false;
  const fetchStub = async () => {
    calledFetch = true;
    return { ok: true, json: async () => ({}) };
  };
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  try {
    await assert.rejects(
      adapter.transcribe({ apiKey: 'key', base64: 'aaaa' }),
      error => {
        assert.equal(error.message, 'Base64 conversion is not supported in this environment.');
        return true;
      },
    );
    assert.equal(calledFetch, false, 'fetch should not be invoked when conversion fails');
  } finally {
    globalThis.atob = originalAtob;
    globalThis.Buffer = originalBuffer;
  }
});

test('synthesise posts JSON payload and returns audio metadata', async () => {
  let capturedRequest;
  const fetchStub = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/ogg']]),
      arrayBuffer: async () => new TextEncoder().encode('binary-audio').buffer,
    };
  };
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  const result = await adapter.synthesise({ apiKey: 'key', text: 'hello world', voice: 'alloy', format: 'ogg' });

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(capturedRequest.options.method, 'POST');
  const headers = capturedRequest.options.headers;
  assert.equal(headers.Authorization, 'Bearer key');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['X-Test'], 'true');

  const payload = JSON.parse(capturedRequest.options.body);
  assert.deepEqual(payload, {
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    input: 'hello world',
    format: 'ogg',
  });

  assert.equal(result.mimeType, 'audio/ogg');
  assert.ok(result.arrayBuffer instanceof ArrayBuffer);
});

test('synthesise accepts planner-sized chunks below provider cap', async () => {
  let callCount = 0;
  const fetchStub = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/mp3']]),
      arrayBuffer: async () => new ArrayBuffer(8),
    };
  };
  const adapter = createAdapter({}, { fetchImpl: fetchStub });
  const tokenCount = 4032;
  const textInput = Array.from({ length: tokenCount }, (_, index) => `token${index}`).join(' ');

  const result = await adapter.synthesise({
    apiKey: 'key',
    text: textInput,
    voice: 'alloy',
    format: 'mp3',
    maxInputTokens: 4096,
  });

  assert.equal(callCount, 1, 'fetch should be invoked once for planner-sized chunk');
  assert.equal(result.mimeType, 'audio/mp3');
  assert.ok(result.arrayBuffer instanceof ArrayBuffer);
});

test('synthesise surfaces API errors', async () => {
  const fetchStub = async () => ({
    ok: false,
    status: 400,
    text: async () => 'bad request',
  });
  const adapter = createAdapter({}, { fetchImpl: fetchStub });

  await assert.rejects(
    adapter.synthesise({ apiKey: 'key', text: 'text' }),
    error => {
      assert.match(error.message, /Speech synthesis failed \(400\): bad request/);
      return true;
    },
  );
});
