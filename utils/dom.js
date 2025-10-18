let VISIBILITY_CACHE = new WeakMap();

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

function normaliseWhitespace(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

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

export function highlightRange(range, className = 'comet-reader-highlight') {
  const highlight = document.createElement('mark');
  highlight.className = className;
  range.surroundContents(highlight);
  return highlight;
}

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

export function createSegmentMap(segments) {
  return segments.map((text, index) => ({
    id: `segment-${index + 1}`,
    text,
  }));
}

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
