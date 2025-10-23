import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupPopupTestEnvironment } from './fixtures/popup-environment.js';

const { getElement } = setupPopupTestEnvironment();
const hadMockFlag = Object.prototype.hasOwnProperty.call(globalThis, '__COMET_MOCK_MODE__');
const previousMockMode = globalThis.__COMET_MOCK_MODE__;
globalThis.__COMET_MOCK_MODE__ = true;

const modulePromise = import('../popup/script.js');
modulePromise.finally(() => {
  if (hadMockFlag) {
    globalThis.__COMET_MOCK_MODE__ = previousMockMode;
  } else {
    delete globalThis.__COMET_MOCK_MODE__;
  }
});

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

test('accepts pending urls for tabs that are still loading', async () => {
  const { __TESTING__ } = await modulePromise;
  const tab = { id: 12, url: undefined, pendingUrl: 'https://example.com/article' };

  assert.doesNotThrow(() => {
    __TESTING__.ensureSupportedTab(tab);
  });
});

test('normalises supported pending URLs when the active URL is unsupported', async () => {
  const { __TESTING__ } = await modulePromise;
  const tab = {
    id: 99,
    url: 'chrome://new-tab-page/',
    pendingUrl: 'https://example.com/article',
  };

  const result = __TESTING__.ensureSupportedTab(tab);

  assert.deepEqual(result, {
    ...tab,
    url: 'https://example.com/article',
  });
});

test('disables tab-dependent controls when the active tab is unsupported', async () => {
  const { __TESTING__ } = await modulePromise;
  const originalQuery = chrome.tabs.query;
  chrome.tabs.query = (_options, callback) => {
    const tabs = [{ id: 88, url: 'chrome://settings/' }];
    if (typeof callback === 'function') {
      callback(tabs);
      return undefined;
    }
    return Promise.resolve(tabs);
  };

  try {
    const support = await __TESTING__.resolveActiveTabSupport();
    assert.equal(support.supported, false);
    assert.equal(support.tab.id, 88);
    assert.equal(support.tab.url, 'chrome://settings/');

    await __TESTING__.init();

    const controlIds = [
      'summariseBtn',
      'readBtn',
      'readPageBtn',
      'playBtn',
      'pauseBtn',
      'stopBtn',
      'pushToTalkBtn',
    ];

    for (const id of controlIds) {
      const element = getElement(id);
      assert.ok(element.disabled, `${id} should be disabled`);
      assert.equal(element.getAttribute('aria-disabled'), 'true');
    }

    const statusElement = getElement('recordingStatus');
    assert.equal(statusElement.textContent, __TESTING__.UNSUPPORTED_TAB_MESSAGE);
  } finally {
    chrome.tabs.query = originalQuery;
  }
});

