(async () => {
  const {
    extractVisibleText,
    createSegmentMap,
    clearHighlights,
    observeMutations,
    throttle,
  } = await import(chrome.runtime.getURL('utils/dom.js'));

  let segments = [];
  let observer;
  let activeHighlightId = null;

  const runtime = chrome?.runtime || browser?.runtime;

  if (!runtime) {
    console.warn('Comet Page Reader: runtime API unavailable.');
    return;
  }

  function buildSegments() {
    const texts = extractVisibleText(document.body, {
      maxLength: 4000,
      minSegmentLength: 500,
    });
    segments = createSegmentMap(texts);
    runtime.sendMessage({
      type: 'comet:segmentsUpdated',
      payload: {
        url: window.location.href,
        segments: segments.map(({ id, text }) => ({ id, length: text.length })),
      },
    }).catch(error => console.debug('Comet Page Reader: segment update failed', error));
  }

  function findTextRange(snippet) {
    const normalised = snippet.trim().toLowerCase();
    if (!normalised) {
      return null;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      const index = text.toLowerCase().indexOf(normalised);
      if (index !== -1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, Math.min(text.length, index + normalised.length));
        return range;
      }
    }
    return null;
  }

  function highlightSegment(segmentId) {
    clearHighlights();
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

  function ensureObservers() {
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
      sendResponse({ ok: true, segments });
      return true;
    }

    return false;
  });
})();
