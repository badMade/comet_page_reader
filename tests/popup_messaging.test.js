import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL as NodeURL } from 'node:url';

import { DEFAULT_TOKEN_LIMIT } from '../utils/cost.js';
import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

const { chrome: chromeStub, getElement } = setupPopupTestEnvironment();

async function importPopupModule({ mockMode = false } = {}) {
  const hadMockFlag = Object.prototype.hasOwnProperty.call(globalThis, '__COMET_MOCK_MODE__');
  const previousValue = globalThis.__COMET_MOCK_MODE__;
  if (mockMode) {
    globalThis.__COMET_MOCK_MODE__ = true;
  } else if (hadMockFlag) {
    delete globalThis.__COMET_MOCK_MODE__;
  }
  const moduleUrl = new NodeURL('../popup/script.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  try {
    return await import(moduleUrl.href);
  } finally {
    if (mockMode || hadMockFlag) {
      if (hadMockFlag) {
        globalThis.__COMET_MOCK_MODE__ = previousValue;
      } else {
        delete globalThis.__COMET_MOCK_MODE__;
      }
    }
  }
}

test('popup messaging content script recovery', async t => {
  const module = await importPopupModule();
  const { sendMessageToTab, sendMessage } = module;

  await t.test('retries after injecting the content script', async () => {
    let sendCount = 0;
    let injectionCount = 0;

    chromeStub.tabs.sendMessage = (_tabId, _message, callback) => {
      sendCount += 1;
      if (sendCount === 1) {
        chromeStub.runtime.lastError = {
          message: 'Could not establish connection. Receiving end does not exist.',
        };
        callback(undefined);
      } else {
        chromeStub.runtime.lastError = null;
        callback({ ok: true });
      }
    };

    chromeStub.scripting.executeScript = (_options, callback) => {
      injectionCount += 1;
      chromeStub.runtime.lastError = null;
      callback([{ result: true }]);
    };

    const response = await sendMessageToTab(123, { type: 'ping' });
    assert.deepEqual(response, { ok: true });
    assert.equal(sendCount, 2);
    assert.equal(injectionCount, 1);
  });

  await t.test('surfaces friendly error when injection is blocked', async () => {
    let injectionCount = 0;

    chromeStub.tabs.sendMessage = (_tabId, _message, callback) => {
      chromeStub.runtime.lastError = {
        message: 'Could not establish connection. Receiving end does not exist.',
      };
      callback(undefined);
    };

    chromeStub.scripting.executeScript = (_options, callback) => {
      injectionCount += 1;
      chromeStub.runtime.lastError = {
        message: 'Cannot access contents of url "chrome://settings"',
      };
      callback();
    };

    await assert.rejects(sendMessageToTab(456, { type: 'ping' }), error => {
      assert.equal(
        error.message,
        'Comet Page Reader cannot run on this page. Try a different tab.'
      );
      return true;
    });
    assert.equal(injectionCount, 1);
  });

  await t.test('sendMessage converts extension context invalidation into a friendly error', async () => {
    chromeStub.runtime.sendMessage = (_message, callback) => {
      chromeStub.runtime.lastError = { message: 'Extension context invalidated.' };
      callback(undefined);
    };

    await assert.rejects(sendMessage('comet:getApiKeyDetails'), error => {
      assert.equal(
        error.message,
        'The extension was reloaded. Close and reopen the popup to continue.',
      );
      return true;
    });

    chromeStub.runtime.lastError = null;
  });

  await t.test('readFullPage requests segments and synthesises audio', async () => {
    module.__TESTING__.assignElements();
    module.__TESTING__.setPlaybackReady();

    chromeStub.tabs.query = (_options, callback) => {
      const tabs = [{ id: 321, url: 'https://example.test/page' }];
      if (callback) {
        callback(tabs);
      }
      return tabs;
    };

    const segments = [
      { id: 'segment-1', text: 'First segment for playback.' },
      { id: 'segment-2', text: 'Second segment for playback.' },
    ];

    let tabMessageCount = 0;
    chromeStub.tabs.sendMessage = (_tabId, message, callback) => {
      tabMessageCount += 1;
      assert.equal(message.type, 'comet:getSegments');
      chromeStub.runtime.lastError = null;
      callback({
        ok: true,
        result: {
          url: 'https://example.test',
          segments,
        },
      });
    };

    const dispatchedTypes = [];
    chromeStub.runtime.sendMessage = (message, callback) => {
      dispatchedTypes.push(message.type);
      chromeStub.runtime.lastError = null;
      const resetAt = 1_700_000_123_000;
      callback({
        success: true,
        result: {
          audio: { base64: 'AA==', mimeType: 'audio/mpeg' },
          usage: {
            totalTokens: 10,
            totalPromptTokens: 10,
            totalCompletionTokens: 0,
            cumulativeTotalTokens: 10,
            cumulativePromptTokens: 10,
            cumulativeCompletionTokens: 0,
            limitTokens: DEFAULT_TOKEN_LIMIT,
            lastReset: resetAt,
            tokens: {
              total: 10,
              prompt: 10,
              completion: 0,
              lastReset: resetAt,
            },
          },
        },
        error: null,
      });
    };

    await module.__TESTING__.readFullPage();

    assert.equal(tabMessageCount, 1);
    assert.deepEqual(dispatchedTypes, ['comet:synthesise', 'comet:synthesise']);
  });

  await t.test('playAudioPayload handles multiple chunks sequentially', async () => {
    module.__TESTING__.assignElements();
    module.__TESTING__.setPlaybackReady();
    module.__TESTING__.ensureAudio();

    const originalURL = globalThis.URL;
    const created = [];
    const revoked = [];
    globalThis.URL = {
      createObjectURL(blob) {
        created.push(blob.type);
        return originalURL?.createObjectURL ? originalURL.createObjectURL(blob) : 'blob:test';
      },
      revokeObjectURL(url) {
        revoked.push(url);
        if (originalURL?.revokeObjectURL) {
          originalURL.revokeObjectURL(url);
        }
      },
    };

    try {
      const controller = module.__TESTING__.createPlaybackController();
      const chunks = [
        { base64: Buffer.from('first').toString('base64'), mimeType: 'audio/mpeg' },
        { base64: Buffer.from('second').toString('base64'), mimeType: 'audio/mpeg' },
      ];

      const result = await module.__TESTING__.playAudioPayload({ chunks }, controller);
      assert.equal(result, 'finished');
      assert.equal(created.length, 2);
      assert.equal(revoked.length, 2);
    } finally {
      globalThis.URL = originalURL;
    }
  });

  await t.test('tts progress updates status text for active requests', async () => {
    module.__TESTING__.assignElements();
    const statusEl = getElement('recordingStatus');

    module.__TESTING__.beginTtsProgress('read-aloud');
    assert.equal(statusEl.textContent, 'Generating audio…');

    module.__TESTING__.handleTtsProgressMessage({ chunkIndex: 1, chunkCount: 5 });
    assert.equal(statusEl.textContent, 'Generating audio 2/5…');

    module.__TESTING__.beginTtsProgress('full-page', { segmentIndex: 1, segmentTotal: 3 });
    assert.equal(statusEl.textContent, 'Segment 2/3: Generating audio…');

    module.__TESTING__.handleTtsProgressMessage({ chunkIndex: 0, chunkCount: 4 });
    assert.equal(statusEl.textContent, 'Segment 2/3: Generating audio 1/4…');

    module.__TESTING__.clearTtsProgress();
    module.__TESTING__.handleTtsProgressMessage({ chunkIndex: 0, chunkCount: 2 });
    assert.equal(statusEl.textContent, 'Segment 2/3: Generating audio 1/4…');
  });
});

test('mock mode bypasses runtime messaging and preserves provider metadata', async () => {
  chromeStub.runtime.sendMessage = () => {
    throw new Error('Runtime messaging should not be used in mock mode');
  };

  const module = await importPopupModule({ mockMode: true });
  const details = await module.sendMessage('comet:getApiKeyDetails');
  assert.equal(details.provider, 'auto');
  assert.equal(details.requestedProvider, 'auto');
  assert.equal(details.apiKey, 'sk-mock-1234');

  const usage = await module.sendMessage('comet:getUsage');
  assert.equal(usage.limitTokens, DEFAULT_TOKEN_LIMIT);
  assert.equal(usage.cumulativeTotalTokens, 2500);
  assert.equal(usage.cumulativePromptTokens, 1500);
  assert.equal(usage.cumulativeCompletionTokens, 1000);
  assert.equal(usage.tokens.total, usage.totalTokens);
  assert.equal(usage.tokens.prompt, usage.totalPromptTokens);
  assert.equal(usage.tokens.completion, usage.totalCompletionTokens);
  assert.equal(typeof usage.tokens.lastReset, 'number');
  const summary = await module.sendMessage('comet:summarise');
  assert.ok(Array.isArray(summary.summaries));
});
