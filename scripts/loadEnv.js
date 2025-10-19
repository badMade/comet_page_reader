import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

export function loadEnv(options = {}) {
  if (typeof process === 'undefined') {
    return {};
  }

  const cwd = options.cwd || process.cwd();
  const envPath = options.path || path.join(cwd, '.env');
  const result = dotenv.config({ path: envPath, quiet: true });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {};
    }
    throw result.error;
  }

  return result.parsed || {};
}

if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  const entryUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entryUrl && process.env.NODE_ENV !== 'production') {
    loadEnv();
  }
}
