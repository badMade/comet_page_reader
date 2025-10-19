import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

setupPopupTestEnvironment();

const modulePromise = import('../popup/script.js');

test('resolves microphone permission errors to a helpful status message', async () => {
  const { __TESTING__ } = await modulePromise;
  const message = __TESTING__.resolveStatusMessage(new DOMException('', 'NotAllowedError'));
  assert.equal(
    message,
    'Microphone access was blocked. Allow microphone access and try again.'
  );
});

test('falls back to the default message when the error is not descriptive', async () => {
  const { __TESTING__ } = await modulePromise;
  const message = __TESTING__.resolveStatusMessage(new DOMException(''));
  assert.equal(message, 'Something went wrong.');
});

test('rejects unsupported chrome pages with a friendly message', async () => {
  const { __TESTING__ } = await modulePromise;
  const originalQuery = chrome.tabs.query;
  chrome.tabs.query = (_options, callback) => {
    const tabs = [{ id: 42, url: 'chrome://new-tab-page/' }];
    if (typeof callback === 'function') {
      callback(tabs);
      return undefined;
    }
    return Promise.resolve(tabs);
  };

  try {
    await assert.rejects(__TESTING__.getActiveTabId(), error => {
      assert.equal(error.message, __TESTING__.UNSUPPORTED_TAB_MESSAGE);
      return true;
    });
  } finally {
    chrome.tabs.query = originalQuery;
  }
});

