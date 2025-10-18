export function extractVisibleText() {
  return ['Stub segment content'];
}

export function createSegmentMap(segments) {
  return segments.map((text, index) => ({
    id: `segment-${index + 1}`,
    text,
  }));
}

export function clearHighlights() {}

export function findTextRange() {
  return null;
}

export function observeMutations() {
  return { disconnect() {} };
}

export function throttle(fn) {
  return (...args) => fn(...args);
}
