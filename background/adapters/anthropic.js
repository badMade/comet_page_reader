import { PlaceholderAdapter } from './placeholder.js';

export class AnthropicAdapter extends PlaceholderAdapter {
  constructor(config) {
    super('anthropic', config);
  }
}
