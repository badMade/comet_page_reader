import { PlaceholderAdapter } from './placeholder.js';

export class OllamaAdapter extends PlaceholderAdapter {
  constructor(config) {
    super('ollama', config);
  }
}
