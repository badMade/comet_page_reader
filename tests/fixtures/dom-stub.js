/**
 * Mimics the real DOM helper by returning a deterministic text segment for
 * use in tests.
 *
 * @returns {string[]} Static segment list used for assertions.
 */
export function extractVisibleText() {
  return ['Stub segment content'];
}

/**
 * Mirrors the production `createSegmentMap` helper with predictable IDs.
 *
 * @param {string[]} segments - Segment contents supplied by tests.
 * @returns {{id: string, text: string}[]} Segments paired with generated IDs.
 */
export function createSegmentMap(segments) {
  return segments.map((text, index) => ({
    id: `segment-${index + 1}`,
    text,
  }));
}

/**
 * No-op highlight clearer retained for API compatibility with DOM utilities.
 *
 * @returns {void}
 */
export function clearHighlights() {}

/**
 * Stub implementation that never locates a DOM range.
 *
 * @returns {null} Always null because the test DOM is synthetic.
 */
export function findTextRange() {
  return null;
}

/**
 * Provides a disposable observer stub with the minimal API used in tests.
 *
 * @returns {{ disconnect: () => void }} Observer facade with a disconnect method.
 */
export function observeMutations() {
  return { disconnect() {} };
}

/**
 * Test-friendly throttle that proxies to the underlying function immediately.
 *
 * @param {Function} fn - Callback invoked with the provided arguments.
 * @returns {Function} Wrapper that forwards calls without delay.
 */
export function throttle(fn) {
  return (...args) => fn(...args);
}
