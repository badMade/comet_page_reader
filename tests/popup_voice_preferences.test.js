import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

function createVoiceOptions(values) {
  return values.map(value => ({ value }));
}

test('loadPreferences falls back to a supported voice and persists it', async () => {
  const previousGlobals = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    Audio: globalThis.Audio,
    URL: globalThis.URL,
  };

  try {
    const NativeURL = previousGlobals.URL ?? globalThis.URL;
    const { chrome, getElement } = setupPopupTestEnvironment();
    globalThis.document.readyState = 'loading';

    globalThis.document.getElementById('voiceSelect');
    const voiceSelect = getElement('voiceSelect');
    voiceSelect.options = createVoiceOptions(['alloy', 'verse', 'nova']);
    voiceSelect.value = 'verse';

    const recordedWrites = [];
    chrome.storage.sync.get = (_keys, callback) => {
      callback({ voice: 'lydia' });
    };
    chrome.storage.sync.set = (values, callback) => {
      recordedWrites.push(values);
      callback?.();
    };
    chrome.runtime.getURL = path => path;
    chrome.runtime.sendMessage = (_message, callback) => {
      callback?.({ ok: true, result: null });
    };

    const moduleUrl = new NativeURL('../popup/script.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const module = await import(moduleUrl.href);

    module.__TESTING__.assignElements();
    await module.__TESTING__.loadPreferences();

    assert.equal(voiceSelect.value, 'alloy', 'voice select should fall back to default voice');
    assert.ok(
      recordedWrites.some(entry => entry.voice === 'alloy'),
      'invalid stored voice should be overwritten with default voice'
    );
  } finally {
    if (previousGlobals.chrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousGlobals.chrome;
    }
    if (previousGlobals.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousGlobals.document;
    }
    if (previousGlobals.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousGlobals.window;
    }
    if (previousGlobals.navigator === undefined) {
      delete globalThis.navigator;
    } else {
      globalThis.navigator = previousGlobals.navigator;
    }
    if (previousGlobals.Audio === undefined) {
      delete globalThis.Audio;
    } else {
      globalThis.Audio = previousGlobals.Audio;
    }
    if (previousGlobals.URL === undefined) {
      delete globalThis.URL;
    } else {
      globalThis.URL = previousGlobals.URL;
    }
  }
});
