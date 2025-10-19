import { PlaceholderAdapter } from './placeholder.js';

export class HuggingFaceAdapter extends PlaceholderAdapter {
  constructor(config) {
    super('huggingface', config);
  }
}
