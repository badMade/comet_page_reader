/**
 * Placeholder adapter binding for Hugging Face while API integration is under
 * development.
 *
 * @module background/adapters/huggingface
 */

import { PlaceholderAdapter } from './placeholder.js';

/**
 * Extends the placeholder adapter with Hugging Face naming conventions.
 */
export class HuggingFaceAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('huggingface', config, options);
  }
}
