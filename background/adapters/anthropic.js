/**
 * Placeholder adapter binding for Anthropic while the integration is pending.
 *
 * @module background/adapters/anthropic
 */

import { PlaceholderAdapter } from './placeholder.js';

/**
 * Extends the placeholder adapter with Anthropic-specific naming.
 */
export class AnthropicAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('anthropic', config, options);
  }
}
