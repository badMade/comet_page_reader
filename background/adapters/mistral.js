/**
 * Placeholder adapter binding for Mistral while API integration is pending.
 *
 * @module background/adapters/mistral
 */

import { PlaceholderAdapter } from './placeholder.js';

/**
 * Extends the placeholder adapter with Mistral-specific naming.
 */
export class MistralAdapter extends PlaceholderAdapter {
  constructor(config) {
    super('mistral', config);
  }
}
