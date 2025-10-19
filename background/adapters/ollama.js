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
  constructor(config) {
    super('ollama', config);
  }
}
