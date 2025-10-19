import { PlaceholderAdapter } from './placeholder.js';

export class MistralAdapter extends PlaceholderAdapter {
  constructor(config) {
    super('mistral', config);
  }
}
