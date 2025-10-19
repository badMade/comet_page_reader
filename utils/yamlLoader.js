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

export async function loadYamlModule() {
  if (cachedYamlModule) {
    return cachedYamlModule;
  }

  cachedYamlModule = await getYamlModulePromise();
  return cachedYamlModule;
}

export function __resetYamlModuleForTests() {
  cachedYamlModule = undefined;
  yamlModulePromise = undefined;
}

