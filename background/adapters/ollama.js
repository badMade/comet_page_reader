/**
 * Placeholder adapter binding for Ollama while API integration is pending.
 *
 * @module background/adapters/ollama
 */

import { PlaceholderAdapter } from './placeholder.js';

/**
 * Extends the placeholder adapter with Ollama-specific naming.
 */
export class OllamaAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('ollama', config, options);
  }

  /**
   * Overrides the default key guard so local Ollama installs can operate
   * without an API token.
   */
  ensureKey() {
    // Local Ollama instances do not require an API key.
  }
}
