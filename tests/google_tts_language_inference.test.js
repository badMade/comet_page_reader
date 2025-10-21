import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesise } from '../background/adapters/googleTTS.js';

async function captureRequestPayload(params) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;

  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      async json() {
        return { audioContent: 'dGVzdA==' };
      },
      async text() {
        return JSON.stringify({ audioContent: 'dGVzdA==' });
      },
    };
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({ googleTTSApiKey: 'test-key' }),
      },
    },
    runtime: {},
  };

  try {
    await synthesise({ text: 'Hello world', ...params });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  }

  assert.equal(requests.length, 1, 'expected exactly one request to be sent');
  const request = requests[0];
  assert.ok(request?.body, 'request body should be present');
  return JSON.parse(request.body);
}

test('infers language for numeric region voice names', async () => {
  const payload = await captureRequestPayload({ voice: 'es-419-Standard-A' });
  assert.equal(payload.voice.languageCode, 'es-419');
});

test('infers language for script-qualified voice names', async () => {
  const payload = await captureRequestPayload({ voice: 'sr-Latn-RS-Standard-A' });
  assert.equal(payload.voice.languageCode, 'sr-Latn-RS');
});
