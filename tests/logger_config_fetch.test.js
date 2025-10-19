import { test } from 'node:test';
import assert from 'node:assert/strict';

const createModuleSpecifier = (() => {
  let counter = 0;
  return () => `../utils/logger.js?browser-fetch-test=${counter++}`;
})();

test('loadLoggingConfig resolves extension URLs when fetch is available', async () => {
  const originalProcess = globalThis.process;
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const originalBrowser = globalThis.browser;

  let requestedUrl = null;

  try {
    globalThis.process = undefined;
    globalThis.fetch = async url => {
      requestedUrl = url;
      return {
        ok: true,
        async text() {
          return '';
        },
      };
    };

    globalThis.chrome = {
      runtime: {
        getURL(path) {
          return `chrome-extension://test/${path}`;
        },
      },
    };

    const moduleUrl = new URL(createModuleSpecifier(), import.meta.url);
    const loggerModule = await import(moduleUrl.href);

    await loggerModule.loadLoggingConfig('logging_config.yaml');

    assert.equal(requestedUrl, 'chrome-extension://test/logging_config.yaml');
  } finally {
    if (typeof originalProcess === 'undefined') {
      delete globalThis.process;
    } else {
      globalThis.process = originalProcess;
    }
    if (typeof originalFetch === 'undefined') {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    if (typeof originalChrome === 'undefined') {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
    if (typeof originalBrowser === 'undefined') {
      delete globalThis.browser;
    } else {
      globalThis.browser = originalBrowser;
    }
  }
});

test('loadLoggingConfig ignores fetch failures for default config path', async () => {
  const originalProcess = globalThis.process;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;

  const loggedErrors = [];

  try {
    globalThis.process = undefined;
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    console.error = (...args) => {
      loggedErrors.push(args);
    };

    const moduleUrl = new URL(createModuleSpecifier(), import.meta.url);
    const loggerModule = await import(moduleUrl.href);

    await loggerModule.loadLoggingConfig('logging_config.yaml');

    assert.equal(loggedErrors.length, 0, 'fetch failures for the default config should not log errors');
    assert.equal(loggerModule.getLoggerConfig().level, 'info');
  } finally {
    if (typeof originalProcess === 'undefined') {
      delete globalThis.process;
    } else {
      globalThis.process = originalProcess;
    }
    if (typeof originalFetch === 'undefined') {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    console.error = originalConsoleError;
  }
});
