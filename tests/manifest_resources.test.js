import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadManifest() {
  const manifestPath = join(__dirname, '..', 'manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

describe('manifest web accessible resources', () => {
  it('exposes dynamic import dependencies for the content script', async () => {
    const manifest = await loadManifest();
    const resources = manifest.web_accessible_resources || [];
    const entry = resources.find(item => Array.isArray(item.resources) && item.resources.includes('utils/dom.js'));
    assert.ok(entry, 'utils/dom.js should be declared as a web accessible resource');
    assert.ok(
      Array.isArray(entry.matches) && entry.matches.includes('<all_urls>'),
      'web accessible resources entry should match <all_urls>'
    );
    assert.ok(
      entry.resources.includes('utils/logger.js'),
      'utils/logger.js should be declared for logger dynamic import'
    );
    assert.ok(
      entry.resources.includes('logging_config.yaml'),
      'logging_config.yaml should be exposed for configuration fetches'
    );
  });
});
