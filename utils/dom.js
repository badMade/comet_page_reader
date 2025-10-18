/**
 * Cache of recently evaluated element visibility checks to avoid repeated
 * layout work during DOM traversals.
 * @type {WeakMap<Element, boolean>}
 */
let VISIBILITY_CACHE = new WeakMap();

const WHITESPACE_REGEX = /[\s\u00a0]/;

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
 * Normalises text for range lookups while retaining a mapping back to the
 * original character offsets. Multiple whitespace characters collapse into a
 * single space so matches remain resilient to formatting differences.
 *
 * @param {string} text - Source text to normalise.
 * @returns {{ value: string, map: number[] }} Lowercased text and offset map.
 */
function normaliseForSearch(text) {
  const map = [];
  let value = '';
  let lastWasSpace = true;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (WHITESPACE_REGEX.test(char)) {
      if (lastWasSpace) {
        continue;
      }
      value += ' ';
      map.push(index);
      lastWasSpace = true;
      continue;
    }

    value += char.toLowerCase();
    map.push(index);
    lastWasSpace = false;
  }

  if (value.endsWith(' ')) {
    value = value.slice(0, -1);
    map.pop();
  }

  return { value, map };
}

/**
 * Normalises snippets provided by cached segments for comparison against DOM
 * text nodes.
 *
 * @param {string} snippet - Snippet taken from the segment cache.
 * @returns {string} Lowercased, whitespace-collapsed snippet.
 */
function normaliseSnippet(snippet) {
  return snippet.replace(/\s+/g, ' ').trim().toLowerCase();
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
 * Locates the first DOM range matching the provided snippet. The comparison is
 * resilient to whitespace differences so cached segments can reliably map back
 * to their original locations.
 *
 * @param {string} snippet - Text sample to locate in the DOM.
 * @param {Element|null} [root=null] - Root node used for tree traversal.
 * @returns {Range|null} Matching DOM range when found.
 */
export function findTextRange(snippet, root = null) {
  const query = snippet ? normaliseSnippet(snippet) : '';
  if (!query) {
    return null;
  }

  const searchRoot = root || (typeof document !== 'undefined' ? document.body : null);
  if (!searchRoot) {
    return null;
  }

  const doc = searchRoot.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const filter = doc && (doc.defaultView?.NodeFilter || globalThis.NodeFilter);
  if (!doc || !filter) {
    return null;
  }

  const walker = doc.createTreeWalker(searchRoot, filter.SHOW_TEXT);
  let node = walker.nextNode();

  let combined = '';
  const positions = [];
  let lastWasSpace = true;
  let searchStart = 0;

  while (node) {
    const text = typeof node.textContent === 'string' ? node.textContent : '';
    if (text) {
      const beforeLength = combined.length;
      let index = 0;

      while (index < text.length) {
        const char = text[index];

        if (WHITESPACE_REGEX.test(char)) {
          let startIndex = index;
          while (index < text.length && WHITESPACE_REGEX.test(text[index])) {
            index += 1;
          }
          if (!lastWasSpace && combined) {
            combined += ' ';
            positions.push({ node, startOffset: startIndex, endOffset: index });
            lastWasSpace = true;
          }
          continue;
        }

        combined += char.toLowerCase();
        positions.push({ node, startOffset: index, endOffset: index + 1 });
        lastWasSpace = false;
        index += 1;
      }

      if (combined.length >= query.length) {
        const startSearch = Math.max(searchStart, beforeLength - query.length);
        const matchIndex = combined.indexOf(query, startSearch);

        if (matchIndex !== -1) {
          const startPosition = positions[matchIndex];
          const endPosition = positions[matchIndex + query.length - 1];

          if (startPosition && endPosition) {
            const range = doc.createRange();
            range.setStart(startPosition.node, startPosition.startOffset);
            range.setEnd(endPosition.node, endPosition.endOffset);
            return range;
          }
        }

        searchStart = Math.max(0, combined.length - query.length);
      }
    }

    node = walker.nextNode();
  }

  return null;
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
