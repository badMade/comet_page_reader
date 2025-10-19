import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function withContentScriptEnvironment(html, url, fn) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { url });
  const { window } = dom;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    Node: globalThis.Node,
    Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver,
    chrome: globalThis.chrome,
    windowChrome: globalThis.window?.chrome,
  };

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.MutationObserver = window.MutationObserver;

  const listeners = [];

  const domModuleUrl = new URL('./fixtures/dom-stub.js', import.meta.url).href;

  const runtime = {
    getURL(resource) {
      if (resource === 'utils/dom.js') {
        return domModuleUrl;
      }
      return new URL(`../${resource}`, import.meta.url).href;
    },
    sendMessage() {
      return Promise.resolve();
    },
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
  };

  globalThis.chrome = { runtime };
  window.chrome = globalThis.chrome;

  try {
    await fn({ window, dom, listeners, runtime });
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));

    if (previous.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous.window;
    }
    if (previous.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous.document;
    }
    if (previous.NodeFilter === undefined) {
      delete globalThis.NodeFilter;
    } else {
      globalThis.NodeFilter = previous.NodeFilter;
    }
    if (previous.Node === undefined) {
      delete globalThis.Node;
    } else {
      globalThis.Node = previous.Node;
    }
    if (previous.Element === undefined) {
      delete globalThis.Element;
    } else {
      globalThis.Element = previous.Element;
    }
    if (previous.MutationObserver === undefined) {
      delete globalThis.MutationObserver;
    } else {
      globalThis.MutationObserver = previous.MutationObserver;
    }
    if (previous.chrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previous.chrome;
    }
    if (previous.window) {
      if (previous.windowChrome === undefined) {
        delete previous.window.chrome;
      } else {
        previous.window.chrome = previous.windowChrome;
      }
    }

    delete dom.window.chrome;
    dom.window.close();
  }
}

function waitForListeners(listeners, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (listeners.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error('Timed out waiting for runtime listener registration'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

test('comet:refreshSegments responds with url and segments result wrapper', async () => {
  await withContentScriptEnvironment(
    '<article><p>Sample paragraph content for testing refresh.</p></article>',
    'https://example.com/article',
    async ({ listeners, window }) => {
      await import(`../content/content.js?refreshTest=${Date.now()}`);
      await waitForListeners(listeners);

      const listener = listeners.at(-1);
      const responses = [];
      const returnValue = listener(
        { type: 'comet:refreshSegments' },
        null,
        payload => {
          responses.push(payload);
        },
      );

      assert.equal(returnValue, true, 'Listener should indicate asynchronous response handling');
      assert.equal(responses.length, 1, 'Expected sendResponse to be invoked once');
      const response = responses[0];
      assert.equal(response.ok, true, 'Refresh response should report success');
      assert.ok(response.result, 'Refresh response should include a result payload');
      assert.equal(response.result.url, window.location.href, 'Response should include current URL');
      assert.ok(Array.isArray(response.result.segments), 'Segments should be returned as an array');
    },
  );
});

test('content script disposes observers when the extension context is invalidated', async () => {
  await withContentScriptEnvironment(
    '<p>Disposable</p>',
    'https://example.com/dispose',
    async ({ runtime, window }) => {
      let removedScrollListener = false;
      const originalRemove = window.document.removeEventListener.bind(window.document);
      window.document.removeEventListener = (type, listener, options) => {
        if (type === 'scroll') {
          removedScrollListener = true;
        }
        return originalRemove(type, listener, options);
      };

      let sendCount = 0;
      runtime.sendMessage = () => {
        sendCount += 1;
        throw new Error('Extension context invalidated.');
      };

      await import(`../content/content.js?disposeTest=${Date.now()}`);

      await new Promise(resolve => setTimeout(resolve, 0));

      assert.equal(sendCount, 1, 'Segment sync should stop after the first failure.');
      assert.equal(removedScrollListener, true, 'Scroll observers should be removed after disposal.');
    },
  );
});
