import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

const { chrome: chromeStub } = setupPopupTestEnvironment();

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
