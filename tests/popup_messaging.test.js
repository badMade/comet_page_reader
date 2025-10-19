import { test } from 'node:test';
import assert from 'node:assert/strict';

const createBaseDom = () => {
  globalThis.document = {
    addEventListener: () => {},
    getElementById: () => ({
      addEventListener: () => {},
      querySelector: () => null,
      setAttribute: () => {},
      textContent: '',
      dataset: {},
    }),
    querySelector: () => null,
  };
  globalThis.window = { addEventListener: () => {} };
  globalThis.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [] }),
    },
  };
  globalThis.Audio = class {
    #handlers = new Map();
    addEventListener(name, handler) {
      this.#handlers.set(name, handler);
    }
    async play() {
      return undefined;
    }
    pause() {}
  };
};

const chromeStub = {
  runtime: {
    lastError: null,
    sendMessage: () => {
      throw new Error('sendMessage stub not configured');
    },
  },
  tabs: {
    query: (_options, callback) => {
      if (callback) {
        callback([]);
      }
      return Promise.resolve([]);
    },
    sendMessage: () => {
      throw new Error('sendMessage stub not configured');
    },
  },
  scripting: {
    executeScript: () => {
      throw new Error('executeScript stub not configured');
    },
  },
  storage: {
    sync: {
      get: (_keys, callback) => callback({}),
      set: (_values, callback) => callback(),
    },
  },
};

createBaseDom();
globalThis.chrome = chromeStub;

test('popup messaging content script recovery', async t => {
  const module = await import('../popup/script.js');
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
});
