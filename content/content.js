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

  let loggerModulePromise;
  let domModulePromise;

  try {
    const loggerModuleUrl = resolveRuntimeUrl('utils/logger.js');
    const domModuleUrl = resolveRuntimeUrl('utils/dom.js');
    loggerModulePromise = import(loggerModuleUrl);
    domModulePromise = import(domModuleUrl);
  } catch (error) {
    if (isContextInvalidated(error)) {
      console.debug(
        'Extension context invalidated before utilities could be resolved.',
        error,
      );
    } else {
      console.error('Failed to resolve utility module URLs.', error);
    }
    return;
  }

  let createLogger;
  let loadLoggingConfig;
  let setGlobalContext;
  let withCorrelation;
  let wrap;

  try {
    ({
      default: createLogger,
      loadLoggingConfig,
      setGlobalContext,
      withCorrelation,
      wrap,
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

  function getContentContextMetadata() {
    const meta = {};
    if (typeof window !== 'undefined' && window.location) {
      if (window.location.hostname) {
        meta.locationHost = window.location.hostname;
      }
      if (window.location.pathname) {
        meta.locationPath = window.location.pathname;
      }
      if (window.location.hash) {
        meta.locationHash = window.location.hash;
      }
    }
    if (Array.isArray(segments)) {
      meta.segmentCount = segments.length;
    }
    if (activeHighlightId) {
      meta.activeHighlightId = activeHighlightId;
    }
    if (observer) {
      meta.observerActive = true;
    }
    if (disposed) {
      meta.disposed = true;
    }
    return meta;
  }

  function createCorrelationId(prefix = 'content') {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function getRuntimeLastError() {
    if (typeof chrome === 'object' && chrome?.runtime?.lastError) {
      return chrome.runtime.lastError;
    }
    if (typeof browser === 'object' && browser?.runtime?.lastError) {
      return browser.runtime.lastError;
    }
    return null;
  }

  function extractStackTrace(value) {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && typeof value.stack === 'string' && value.stack) {
      return value.stack;
    }
    return undefined;
  }

  const logWindowError = logger.wrapAsync(
    async (event, correlationId) => {
      const stack = extractStackTrace(event?.error) ?? extractStackTrace(event?.message);
      const meta = {
        ...getContentContextMetadata(),
        ...withCorrelation(correlationId),
        message: event?.message,
        filename: event?.filename,
        lineno: event?.lineno,
        colno: event?.colno,
        eventType: event?.type ?? 'error',
      };
      if (typeof stack === 'string') {
        meta.stack = stack;
      }
      if (typeof event?.error !== 'undefined') {
        meta.error = event.error;
      }
      await logger.error('Unhandled window error captured.', meta);
    },
    (event, correlationId) => ({
      component: logger.component,
      eventType: event?.type ?? 'error',
      ...getContentContextMetadata(),
      ...withCorrelation(correlationId),
      errorMessage: 'Content script window error handler failed.',
    }),
  );

  const logUnhandledRejection = logger.wrapAsync(
    async (event, correlationId) => {
      const stack = extractStackTrace(event?.reason);
      const meta = {
        ...getContentContextMetadata(),
        ...withCorrelation(correlationId),
        reason: event?.reason,
        eventType: event?.type ?? 'unhandledrejection',
      };
      if (typeof stack === 'string') {
        meta.stack = stack;
      }
      await logger.error('Unhandled promise rejection captured in content script.', meta);
    },
    (event, correlationId) => ({
      component: logger.component,
      eventType: event?.type ?? 'unhandledrejection',
      ...getContentContextMetadata(),
      ...withCorrelation(correlationId),
      errorMessage: 'Content script unhandled rejection handler failed.',
    }),
  );

  const handleWindowError = event => {
    const correlationId = createCorrelationId('content-window-error');
    logWindowError(event, correlationId).catch(() => {});
  };

  const handleUnhandledRejection = event => {
    const correlationId = createCorrelationId('content-unhandled-rejection');
    logUnhandledRejection(event, correlationId).catch(() => {});
  };

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
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

  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
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
    const correlationId = createCorrelationId('content-msg');
    const wrapped = wrap(
      (incomingMessage, incomingSender, respond) => {
        if (!incomingMessage || !incomingMessage.type) {
          return false;
        }

        if (incomingMessage.type === 'comet:getSegments') {
          respond({
            ok: true,
            result: {
              url: window.location.href,
              segments,
            },
          });
          return true;
        }

        if (incomingMessage.type === 'comet:highlightSegment') {
          const ok = highlightSegment(incomingMessage.payload.segmentId);
          respond({ ok, segmentId: incomingMessage.payload.segmentId });
          return true;
        }

        if (incomingMessage.type === 'comet:clearHighlights') {
          clearHighlights();
          activeHighlightId = null;
          respond({ ok: true });
          return true;
        }

        if (incomingMessage.type === 'comet:refreshSegments') {
          buildSegments();
          respond({
            ok: true,
            result: {
              url: window.location.href,
              segments,
            },
          });
          return true;
        }

        return false;
      },
      incomingMessage => ({
        logger,
        component: logger.component,
        ...withCorrelation(correlationId),
        messageType: incomingMessage?.type,
        errorMessage: 'Content script runtime handler failed.',
      }),
    );

    return wrapped(message, sender, sendResponse);
  });
})();
