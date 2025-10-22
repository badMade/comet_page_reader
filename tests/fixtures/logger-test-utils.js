let counter = 0;

export function importFreshLoggerModule() {
  const moduleSpecifier = `../../utils/logger.js?unit=${Date.now()}-${counter++}`;
  const moduleUrl = new URL(moduleSpecifier, import.meta.url);
  return import(moduleUrl.href);
}
