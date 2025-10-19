import { PlaceholderAdapter } from './placeholder.js';

export class MistralAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('mistral', config, options);
  }
}
