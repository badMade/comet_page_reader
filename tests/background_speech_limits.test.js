import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, importServiceWorker } from './fixtures/chrome-stub.js';

function countWords(text) {
  if (typeof text !== 'string') {
    return 0;
  }
  return text.split(/\s+/u).filter(Boolean).length;
}

test('synthesiseSpeech leaves short text unchanged', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  persistentStore['comet:apiKey:openai_paid'] = 'test-key';

  let module;
  try {
    module = await importServiceWorker();

    const captured = [];
    const stubAdapter = {
      getCostMetadata() {
        return { synthesise: { label: 'tts', flatCost: 0.01, model: 'gpt-4o-mini-tts' } };
      },
      async synthesise({ text }) {
        captured.push(text);
        return { arrayBuffer: new Uint8Array([0, 1]).buffer, mimeType: 'audio/mp3' };
      },
    };

    module.__setTestAdapterOverride('openai_paid', stubAdapter);
    await module.ensureInitialised('openai_paid');

    const response = await module.__synthesiseForTests({
      text: 'hello world',
      voice: 'alloy',
      format: 'mp3',
      provider: 'openai_paid',
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0], 'hello world');
    assert.equal(response.adapter.type, 'cloud');
    assert.equal(response.audio.truncated, false);
    assert.equal(response.audio.originalTokenCount, 2);
    assert.equal(response.audio.deliveredTokenCount, 2);
    assert.equal(response.audio.omittedTokenCount, 0);
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    uninstall();
  }
});

test('synthesiseSpeech truncates payloads that exceed the provider limit', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  persistentStore['comet:apiKey:openai_paid'] = 'test-key';

  let module;
  try {
    module = await importServiceWorker();

    const captured = [];
    const stubAdapter = {
      getCostMetadata() {
        return { synthesise: { label: 'tts', flatCost: 0.01, model: 'gpt-4o-mini-tts' } };
      },
      async synthesise({ text }) {
        captured.push(text);
        return { arrayBuffer: new Uint8Array([2, 3]).buffer, mimeType: 'audio/mp3' };
      },
    };

    module.__setTestAdapterOverride('openai_paid', stubAdapter);
    await module.ensureInitialised('openai_paid');

    const longText = Array.from({ length: 2400 }, (_, index) => `word${index}`).join(' ');
    const response = await module.__synthesiseForTests({
      text: longText,
      voice: 'alloy',
      format: 'mp3',
      provider: 'openai_paid',
    });

    assert.equal(captured.length, 1);
    const truncatedText = captured[0];
    const truncatedTokens = countWords(truncatedText);

    assert.ok(truncatedTokens <= 1950, `expected <= 1950 tokens, received ${truncatedTokens}`);
    assert.equal(response.adapter.type, 'cloud');
    assert.equal(response.audio.truncated, true);
    assert.equal(response.audio.originalTokenCount, 2400);
    assert.equal(response.audio.deliveredTokenCount, truncatedTokens);
    assert.equal(response.audio.omittedTokenCount, 2400 - truncatedTokens);
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    uninstall();
  }
});

test('synthesiseSpeech truncates CJK text using character-aware tokenisation', async () => {
  const { uninstall, persistentStore } = installChromeStub();
  persistentStore['comet:apiKey:openai_paid'] = 'test-key';

  let module;
  try {
    module = await importServiceWorker();

    const captured = [];
    const stubAdapter = {
      getCostMetadata() {
        return { synthesise: { label: 'tts', flatCost: 0.01, model: 'gpt-4o-mini-tts' } };
      },
      async synthesise({ text }) {
        captured.push(text);
        return { arrayBuffer: new Uint8Array([4, 5]).buffer, mimeType: 'audio/mp3' };
      },
    };

    module.__setTestAdapterOverride('openai_paid', stubAdapter);
    await module.ensureInitialised('openai_paid');

    const longCjk = '你好世界'.repeat(600);
    const response = await module.__synthesiseForTests({
      text: longCjk,
      voice: 'alloy',
      format: 'mp3',
      provider: 'openai_paid',
    });

    assert.equal(captured.length, 1);
    const truncatedText = captured[0];
    assert.ok(truncatedText.length < longCjk.length);
    assert.equal(response.adapter.type, 'cloud');
    assert.equal(response.audio.truncated, true);
    assert.ok(response.audio.deliveredTokenCount <= 1950);
    assert.equal(response.audio.originalTokenCount, longCjk.length);
    assert.equal(response.audio.omittedTokenCount, response.audio.originalTokenCount - response.audio.deliveredTokenCount);
  } finally {
    if (module) {
      module.__clearTestOverrides();
    }
    uninstall();
  }
});
