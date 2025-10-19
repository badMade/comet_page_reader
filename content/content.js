/**
 * Content script entry point that extracts readable text from the current page,
 * synchronises segment metadata with the background service worker, and
 * responds to highlight commands from the popup UI.
 *
 * @module content/content
 */
(async () => {
  const {
    extractVisibleText,
    createSegmentMap,
    clearHighlights,
    findTextRange,
    observeMutations,
    throttle,
  } = await import(chrome.runtime.getURL('utils/dom.js'));

  let segments = [];
  let observer;
  let activeHighlightId = null;
  let disposed = false;

  const runtime = (() => {
    if (typeof chrome === 'object' && chrome && chrome.runtime) {
      return chrome.runtime;
    }
    if (typeof browser === 'object' && browser && browser.runtime) {
      return browser.runtime;
    }
    return null;
  })();

  if (!runtime) {
    console.warn('Comet Page Reader: runtime API unavailable.');
    return;
  }

  const CONTEXT_INVALIDATED_PATTERN = /Extension context invalidated/i;

  function getRuntimeLastError() {
    if (typeof chrome === 'object' && chrome?.runtime?.lastError) {
      return chrome.runtime.lastError;
    }
    if (typeof browser === 'object' && browser?.runtime?.lastError) {
      return browser.runtime.lastError;
    }
    return null;
  }

  function isContextInvalidated(error) {
    if (!error) {
      return false;
    }
    const message = typeof error.message === 'string' ? error.message : String(error);
    return CONTEXT_INVALIDATED_PATTERN.test(message);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.removeEventListener('scroll', throttledUpdate);
  }

  function handleRuntimeFailure(error) {
    if (!error) {
      return;
    }
    if (isContextInvalidated(error)) {
      console.debug('Comet Page Reader: extension context invalidated, disposing content script.');
      dispose();
      return;
    }
    console.debug('Comet Page Reader: segment update failed', error);
  }

  function safeSendRuntimeMessage(message) {
    if (disposed || !runtime?.sendMessage) {
      return;
    }
    try {
      let maybePromise;
      let usedCallback = false;
      try {
        maybePromise = runtime.sendMessage(message, () => {
          const lastError = getRuntimeLastError();
          if (lastError) {
            handleRuntimeFailure(lastError);
          }
        });
        usedCallback = true;
      } catch (sendError) {
        if (sendError instanceof TypeError) {
          maybePromise = runtime.sendMessage(message);
        } else {
          throw sendError;
        }
      }

      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(handleRuntimeFailure);
      } else if (!usedCallback && typeof maybePromise === 'undefined') {
        // Nothing else to inspect; assume fire-and-forget style APIs.
      }
    } catch (error) {
      handleRuntimeFailure(error);
    }
  }

  /**
   * Rebuilds the list of text segments by traversing the document and informs
   * the background script of the latest segment metadata.
   */
  function buildSegments() {
    if (disposed) {
      return;
    }
    const texts = extractVisibleText(document.body, {
      maxLength: 4000,
      minSegmentLength: 500,
    });
    segments = createSegmentMap(texts);
    safeSendRuntimeMessage({
      type: 'comet:segmentsUpdated',
      payload: {
        url: window.location.href,
        segments: segments.map(({ id, text }) => ({ id, length: text.length })),
      },
    });
  }

  /**
   * Highlights a summarised segment in the DOM and scrolls it into view.
   *
   * @param {string} segmentId - Identifier from the segment map.
   * @returns {boolean} True when the highlight was applied.
   */
  function highlightSegment(segmentId) {
    clearHighlights();
    if (disposed) {
      return false;
    }
    const segment = segments.find(item => item.id === segmentId);
    if (!segment) {
      return false;
    }
    const snippet = segment.text.slice(0, 200);
    const words = snippet.split(' ').slice(0, 25).join(' ');
    const range = findTextRange(words);
    if (range) {
      try {
        const mark = document.createElement('mark');
        mark.className = 'comet-reader-highlight';
        range.surroundContents(mark);
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        activeHighlightId = segmentId;
        return true;
      } catch (error) {
        console.debug('Comet Page Reader: failed to highlight segment', error);
      }
    }
    return false;
  }

  const throttledUpdate = throttle(buildSegments, 2000);

  window.addEventListener('pagehide', dispose);
  window.addEventListener('beforeunload', dispose);

  /**
   * Ensures DOM mutation and scroll observers rebuild segments when the page
   * structure changes.
   */
  function ensureObservers() {
    if (disposed) {
      return;
    }
    if (observer) {
      observer.disconnect();
    }
    observer = observeMutations(() => {
      throttledUpdate();
    });
    document.addEventListener('scroll', throttledUpdate, { passive: true });
  }

  buildSegments();
  ensureObservers();

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (disposed) {
      return false;
    }
    if (!message || !message.type) {
      return false;
    }

    if (message.type === 'comet:getSegments') {
      sendResponse({
        ok: true,
        result: {
          url: window.location.href,
          segments,
        },
      });
      return true;
    }

    if (message.type === 'comet:highlightSegment') {
      const ok = highlightSegment(message.payload.segmentId);
      sendResponse({ ok, segmentId: message.payload.segmentId });
      return true;
    }

    if (message.type === 'comet:clearHighlights') {
      clearHighlights();
      activeHighlightId = null;
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'comet:refreshSegments') {
      buildSegments();
      sendResponse({
        ok: true,
        result: {
          url: window.location.href,
          segments,
        },
      });
      return true;
    }

    return false;
  });
})();
