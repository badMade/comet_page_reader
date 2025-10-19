/**
 * Content script entry point that extracts readable text from the current page,
 * synchronises segment metadata with the background service worker, and
 * responds to highlight commands from the popup UI.
 *
 * @module content/content
 */
(async () => {
  const CONTEXT_INVALIDATED_PATTERN = /Extension context invalidated/i;

  function isContextInvalidated(error) {
    if (!error) {
      return false;
    }
    const message = typeof error.message === 'string' ? error.message : String(error);
    return CONTEXT_INVALIDATED_PATTERN.test(message);
  }

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
    console.warn('Runtime API unavailable. Aborting content script initialisation.');
    return;
  }

  const resolveRuntimeUrl = (() => {
    if (typeof runtime.getURL === 'function') {
      return resource => runtime.getURL(resource);
    }
    if (typeof chrome === 'object' && chrome?.runtime?.getURL) {
      return resource => chrome.runtime.getURL(resource);
    }
    if (typeof browser === 'object' && browser?.runtime?.getURL) {
      return resource => browser.runtime.getURL(resource);
    }
    return null;
  })();

  if (!resolveRuntimeUrl) {
    console.warn('runtime.getURL unavailable. Content script cannot continue.');
    return;
  }

  const loggerModulePromise = import(resolveRuntimeUrl('utils/logger.js'));
  const domModulePromise = import(resolveRuntimeUrl('utils/dom.js'));

  let createLogger;
  let loadLoggingConfig;
  let setGlobalContext;

  try {
    ({
      default: createLogger,
      loadLoggingConfig,
      setGlobalContext,
    } = await loggerModulePromise);
  } catch (error) {
    if (isContextInvalidated(error)) {
      console.debug('Extension context invalidated before logger initialised.', error);
      return;
    }
    console.error('Failed to load logger utilities for content script.', error);
    return;
  }

  const logger = createLogger({
    name: 'content-script',
    context: {
      location: typeof window !== 'undefined' ? window.location.href : undefined,
    },
  });
  setGlobalContext({ runtime: 'content-script' });

  loadLoggingConfig().catch(() => {});

  await logger.info('Content script initialising.');

  let extractVisibleText;
  let createSegmentMap;
  let clearHighlights;
  let findTextRange;
  let observeMutations;
  let throttle;

  try {
    ({
      extractVisibleText,
      createSegmentMap,
      clearHighlights,
      findTextRange,
      observeMutations,
      throttle,
    } = await domModulePromise);
  } catch (error) {
    if (isContextInvalidated(error)) {
      await logger.debug(
        'Extension context invalidated before content script initialised.',
        { error },
      );
      return;
    }
    await logger.error('Failed to load DOM utilities.', { error });
    return;
  }

  let segments = [];
  let observer;
  let activeHighlightId = null;
  let disposed = false;

  function getRuntimeLastError() {
    if (typeof chrome === 'object' && chrome?.runtime?.lastError) {
      return chrome.runtime.lastError;
    }
    if (typeof browser === 'object' && browser?.runtime?.lastError) {
      return browser.runtime.lastError;
    }
    return null;
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
    logger.info('Content script disposed.');
  }

  function handleRuntimeFailure(error) {
    if (!error) {
      return;
    }
    if (isContextInvalidated(error)) {
      logger.debug('Extension context invalidated, disposing content script.');
      dispose();
      return;
    }
    logger.debug('Segment update failed.', { error });
  }

  function safeSendRuntimeMessage(message) {
    if (disposed || !runtime?.sendMessage) {
      return;
    }
    try {
      const maybePromise = runtime.sendMessage(message, () => {
        const lastError = getRuntimeLastError();
        if (lastError) {
          handleRuntimeFailure(lastError);
        }
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(handleRuntimeFailure);
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
    logger.debug('Rebuilding text segments.');
    const texts = extractVisibleText(document.body, {
      maxLength: 4000,
      minSegmentLength: 500,
    });
    segments = createSegmentMap(texts);
    logger.debug('Segments rebuilt.', { count: segments.length });
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
      logger.debug('Requested segment not found.', { segmentId });
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
        logger.debug('Failed to highlight segment.', { error, segmentId });
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
