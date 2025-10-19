let YAMLModule;

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  YAMLModule = await import('yaml');
} else {
  YAMLModule = await import('./vendor/yamlBrowser.js');
}

const YAML = YAMLModule.default || YAMLModule;

export default YAML;
