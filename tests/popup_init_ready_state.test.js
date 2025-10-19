import { test } from 'node:test';
import assert from 'node:assert/strict';

const NativeURL = URL;

function createElementStub() {
  const listeners = new Map();

  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type);
      if (!handlers) {
        return;
      }
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event.type) || [];
      handlers.forEach(handler => handler(event));
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    appendChild: () => {},
    cloneNode: () => createElementStub(),
    querySelector: () => createElementStub(),
    dataset: {},
    style: {},
    textContent: '',
    value: '',
    innerHTML: '',
    disabled: false,
    listeners,
    content: {
      cloneNode: () => createElementStub(),
    },
  };
}

test('popup initialises immediately when DOMContentLoaded already fired', async () => {
  const previousGlobals = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    Audio: globalThis.Audio,
    URL: globalThis.URL,
    fetch: globalThis.fetch,
  };

  const elementCache = new Map();
  const getElement = id => {
    if (!elementCache.has(id)) {
      elementCache.set(id, createElementStub());
    }
    return elementCache.get(id);
  };

  const recordedMessages = [];
  const recordedStorageWrites = [];
  let requestedSyncKeys;
  const runtimeStub = {
    lastError: null,
    sendMessage(message, callback) {
      recordedMessages.push(message);
      const responses = {
        'comet:getApiKeyDetails': {
          provider: 'openai',
          requestedProvider: 'auto',
          apiKey: null,
          lastUpdated: null,
        },
        'comet:getUsage': { totalCostUsd: 0, limitUsd: 5, lastReset: Date.now() },
        'comet:setProvider': { provider: 'openai', requiresApiKey: true },
        'comet:setApiKey': null,
      };
      if (callback) {
        callback({ ok: true, result: responses[message.type] ?? null });
      }
    },
    onMessage: { addListener: () => {} },
    getURL: () => new NativeURL('agent.yaml', 'https://example.test/'),
  };

  try {
    globalThis.fetch = async () => ({ ok: true, text: async () => 'provider: openai' });
    globalThis.chrome = {
      runtime: runtimeStub,
      storage: {
        sync: {
          get: (keys, cb) => {
            requestedSyncKeys = keys;
            cb({ playbackRate: 1.75 });
          },
          set: (items, cb) => {
            recordedStorageWrites.push(items);
            cb?.();
          },
        },
      },
      tabs: { query: (_opts, cb) => cb?.([]) },
      scripting: { executeScript: (_opts, cb) => cb?.([{ result: true }]) },
    };
    globalThis.window = { addEventListener: () => {} };
    globalThis.navigator = {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    };
    globalThis.Audio = class {
      constructor() {
        this.playbackRate = 1;
      }
      addEventListener() {}
      removeEventListener() {}
      async play() {}
      pause() {}
    };
    globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };

    globalThis.document = {
      readyState: 'complete',
      addEventListener: () => {},
      getElementById: getElement,
      querySelector: () => createElementStub(),
    };

    const moduleUrl = new NativeURL('../popup/script.js', import.meta.url);
    moduleUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
    const module = await import(moduleUrl.href);

    const waitForTick = () => new Promise(resolve => setTimeout(resolve, 0));
    await waitForTick();
    await waitForTick();

    const apiForm = getElement('api-form');
    const submitHandlers = apiForm.listeners.get('submit') || [];
    assert.ok(submitHandlers.length > 0, 'submit handler should be registered immediately');

    const providerSelect = getElement('providerSelect');
    assert.equal(providerSelect.value, 'auto');

    const apiKeyInput = getElement('apiKey');
    apiKeyInput.value = 'test-key';

    let prevented = false;
    await submitHandlers[0]({
      preventDefault: () => {
        prevented = true;
      },
    });

    assert.equal(prevented, true);
    const setApiKeyMessage = recordedMessages.find(message => message.type === 'comet:setApiKey');
    assert.ok(setApiKeyMessage, 'API key submission should call runtime messaging');
    assert.equal(setApiKeyMessage.payload.apiKey, 'test-key');

    assert.deepEqual(requestedSyncKeys, ['language', 'voice', 'playbackRate']);

    const playbackSelect = getElement('playbackRateSelect');
    assert.equal(playbackSelect.value, '1.75');

    const audio = module.__TESTING__.ensureAudio();
    assert.equal(audio.playbackRate, 1.75);

    playbackSelect.value = '2';
    const playbackListeners = playbackSelect.listeners.get('change') || [];
    assert.ok(playbackListeners.length > 0, 'playback rate change handler should be registered');
    await playbackListeners[0]({
      target: playbackSelect,
      preventDefault() {},
    });

    assert.equal(audio.playbackRate, 2);
    assert.ok(
      recordedStorageWrites.some(entry => entry.playbackRate === 2),
      'playback rate update should persist to storage'
    );
  } finally {
    if (previousGlobals.fetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = previousGlobals.fetch;
    }
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

