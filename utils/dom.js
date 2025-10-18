/**
 * Cache of recently evaluated element visibility checks to avoid repeated
 * layout work during DOM traversals.
 * @type {WeakMap<Element, boolean>}
 */
let VISIBILITY_CACHE = new WeakMap();

/**
 * Determines whether an element should be considered visible for the purposes
 * of summarisation. Non-element nodes are treated as visible by default.
 *
 * @param {Node} node - Node being evaluated.
 * @returns {boolean} True when the node's text content is suitable for use.
 */
function isNodeVisible(node) {
  if (!(node instanceof Element)) {
    return true;
  }

  if (VISIBILITY_CACHE.has(node)) {
    return VISIBILITY_CACHE.get(node);
  }

  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  const visible =
    style &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    parseFloat(style.opacity || '1') > 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.top <= (window.innerHeight || document.documentElement.clientHeight) * 2;

  VISIBILITY_CACHE.set(node, visible);
  return visible;
}

/**
 * Normalises whitespace in text nodes to keep segment extraction consistent.
 *
 * @param {string} text - Raw text content.
 * @returns {string} Cleaned text containing single spaces.
 */
function normaliseWhitespace(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * Traverses the DOM and yields text segments constrained by optional size
 * thresholds. Invisible nodes and script-related elements are ignored.
 *
 * @param {Element} [root=document.body] - Root element to traverse.
 * @param {{maxLength?: number, minSegmentLength?: number}} [options] -
 *   Extraction constraints.
 * @returns {string[]} Extracted text segments.
 */
export function extractVisibleText(root = document.body, options = {}) {
  const { maxLength = 4000, minSegmentLength = 500 } = options;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !normaliseWhitespace(node.textContent)) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent || !isNodeVisible(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      const tag = parent.tagName ? parent.tagName.toLowerCase() : '';
      if (['script', 'style', 'noscript', 'template'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const segments = [];
  let current = '';
  let node;

  while ((node = walker.nextNode())) {
    const text = normaliseWhitespace(node.textContent);
    if (!text) {
      continue;
    }
    if (current.length + text.length > maxLength && current.length >= minSegmentLength) {
      segments.push(current.trim());
      current = text;
    } else {
      current = `${current} ${text}`.trim();
    }
  }

  if (current) {
    segments.push(current.trim());
  }

  return segments.filter(Boolean);
}

/**
 * Wraps the provided DOM range in a <mark> element to highlight the text.
 *
 * @param {Range} range - DOM range to decorate.
 * @param {string} [className='comet-reader-highlight'] - CSS class applied.
 * @returns {HTMLElement} The created highlight element.
 */
export function highlightRange(range, className = 'comet-reader-highlight') {
  const highlight = document.createElement('mark');
  highlight.className = className;
  range.surroundContents(highlight);
  return highlight;
}

/**
 * Removes highlight wrappers from the document, restoring original text nodes.
 *
 * @param {string} [className='comet-reader-highlight'] - CSS class to target.
 */
export function clearHighlights(className = 'comet-reader-highlight') {
  document.querySelectorAll(`.${className}`).forEach(node => {
    const parent = node.parentNode;
    if (!parent) {
      return;
    }
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
  });
}

/**
 * Generates a predictable identifier for each extracted text segment.
 *
 * @param {string[]} segments - Sequential text segments.
 * @returns {{id: string, text: string}[]} Segments paired with unique IDs.
 */
export function createSegmentMap(segments) {
  return segments.map((text, index) => ({
    id: `segment-${index + 1}`,
    text,
  }));
}

/**
 * Sets up a MutationObserver that invalidates cached visibility checks and
 * triggers the supplied callback.
 *
 * @param {Function} callback - Invoked whenever the DOM changes.
 * @param {MutationObserverInit} [options={}] - Additional observer options.
 * @returns {MutationObserver} Active observer instance.
 */
export function observeMutations(callback, options = {}) {
  const observer = new MutationObserver(() => {
    VISIBILITY_CACHE = new WeakMap();
    callback();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
    ...options,
  });
  return observer;
}

/**
 * Coalesces rapid function calls into a single invocation executed at most
 * once per interval.
 *
 * @param {Function} fn - Function to throttle.
 * @param {number} delay - Delay in milliseconds.
 * @returns {Function} Wrapper that throttles execution.
 */
export function throttle(fn, delay) {
  let timeout = null;
  let pendingArgs = null;
  return (...args) => {
    pendingArgs = args;
    if (!timeout) {
      timeout = setTimeout(() => {
        timeout = null;
        if (pendingArgs) {
          fn(...pendingArgs);
          pendingArgs = null;
        }
      }, delay);
    }
  };
}
