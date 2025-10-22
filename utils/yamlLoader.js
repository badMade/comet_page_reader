/**
 * Lazy YAML loader that supports both Node.js and browser environments. The
 * helper chooses the optimal implementation at runtime, caching the loaded
 * module so subsequent calls remain fast.
 *
 * @module utils/yamlLoader
 */

import browserYamlModule from './vendor/yamlBrowser.js';

let cachedYamlModule;
let yamlModulePromise;

function isNodeEnvironment() {
  return (
    typeof process !== 'undefined' &&
    typeof process.release === 'object' &&
    process.release?.name === 'node'
  );
}

function getBrowserYamlModule() {
  return browserYamlModule?.default || browserYamlModule;
}

function getYamlModulePromise() {
  if (!yamlModulePromise) {
    yamlModulePromise = (async () => {
      if (isNodeEnvironment()) {
        const module = await import('yaml');
        return module.default || module;
      }

      return getBrowserYamlModule();
    })();
  }

  return yamlModulePromise;
}

/**
 * Resolves the YAML parser module appropriate for the current environment.
 * Node.js installations dynamically import the `yaml` package, while browsers
 * fall back to the lightweight bundled implementation.
 *
 * @returns {Promise<object>} Module exposing a `parse` function compatible with
 *   the `yaml` package API.
 */
export async function loadYamlModule() {
  if (cachedYamlModule) {
    return cachedYamlModule;
  }

  cachedYamlModule = await getYamlModulePromise();
  return cachedYamlModule;
}

/**
 * Clears cached state to ensure deterministic behaviour across tests. The
 * helper is intentionally exported for the test suite only.
 *
 * @returns {void}
 */
export function __resetYamlModuleForTests() {
  cachedYamlModule = undefined;
  yamlModulePromise = undefined;
}

