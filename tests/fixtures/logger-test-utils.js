let counter = 0;

export function importFreshLoggerModule() {
  const moduleSpecifier = `../../utils/logger.js?unit=${Date.now()}-${counter++}`;
  const moduleUrl = new URL(moduleSpecifier, import.meta.url);
  return import(moduleUrl.href);
}

export function parseJson(value) {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

export function matchesMessage(entry, message) {
  return entry?.message === message || entry?.event === message || entry?.msg === message;
}

export function findEntries(calls, predicate) {
  return (calls ?? []).reduce((entries, args) => {
    if (Array.isArray(args) && args.length > 0 && typeof args[0] === 'string') {
      const parsed = parseJson(args[0]);
      if (parsed && predicate(parsed)) {
        entries.push(parsed);
      }
    }
    return entries;
  }, []);
}

export function readLevel(entry) {
  return (
    entry?.level ??
    entry?.severity ??
    entry?.levelName ??
    entry?.logLevel ??
    entry?.metadata?.level ??
    null
  );
}
