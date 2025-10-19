import { PlaceholderAdapter } from './placeholder.js';

export class OllamaAdapter extends PlaceholderAdapter {
  constructor(config, options = {}) {
    super('ollama', config, options);
  }
}
