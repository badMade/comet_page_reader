import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { findTextRange } from '../utils/dom.js';

function withDom(html, fn) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const { window } = dom;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    Node: globalThis.Node,
  };

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.Node = window.Node;

  try {
    return fn(window.document);
  } finally {
    if (previous.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous.window;
    }
    if (previous.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous.document;
    }
    if (previous.NodeFilter === undefined) {
      delete globalThis.NodeFilter;
    } else {
      globalThis.NodeFilter = previous.NodeFilter;
    }
    if (previous.Node === undefined) {
      delete globalThis.Node;
    } else {
      globalThis.Node = previous.Node;
    }
    dom.window.close();
  }
}

test('findTextRange locates text despite irregular whitespace', () => {
  return withDom(
    `
      <article>
        <p>First line\n  second line with extra   spaces.</p>
      </article>
    `,
    document => {
      const range = findTextRange('First line second line with extra spaces.', document.body);
      assert.ok(range, 'Expected range to be found');
      const selected = range.toString().replace(/\s+/g, ' ').trim();
      assert.equal(selected, 'First line second line with extra spaces.');
    },
  );
});

test('findTextRange spans inline formatting boundaries', () => {
  return withDom(
    `
      <p>First <strong>bold</strong> word</p>
    `,
    document => {
      const range = findTextRange('First bold word', document.body);
      assert.ok(range, 'Expected range across inline elements');
      assert.equal(range.toString(), 'First bold word');
    },
  );
});

test('findTextRange tolerates leading whitespace without throwing', () => {
  return withDom(
    `
      <div>\n        \n        \n        Leading text remains highlighted correctly.
      </div>
    `,
    document => {
      const range = findTextRange('Leading text remains highlighted correctly.', document.body);
      assert.ok(range);
      assert.equal(
        range.toString().replace(/\s+/g, ' ').trim(),
        'Leading text remains highlighted correctly.',
      );
    },
  );
});

test('findTextRange returns null when snippet is absent', () => {
  return withDom('<p>Sample text</p>', document => {
    const range = findTextRange('Non-existent snippet', document.body);
    assert.equal(range, null);
  });
});
