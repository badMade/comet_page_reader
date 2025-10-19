import { PlaceholderAdapter } from './placeholder.js';

export class HuggingFaceAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('huggingface', config, options);
  }
}
