let cachedYamlModule;
let yamlModulePromise;

function getYamlModulePromise() {
  if (!yamlModulePromise) {
    yamlModulePromise = (async () => {
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const module = await import('yaml');
        return module.default || module;
      }

      const module = await import('./vendor/yamlBrowser.js');
      return module.default || module;
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

