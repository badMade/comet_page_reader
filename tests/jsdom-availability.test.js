import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('jsdom is available for DOM-dependent tests', () => {
  const dom = new JSDOM('<!DOCTYPE html><p>ready</p>');
  assert.equal(dom.window.document.querySelector('p')?.textContent, 'ready');
  dom.window.close();
});
