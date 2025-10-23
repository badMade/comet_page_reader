function createElementStub() {
  const attributes = new Map();
  const node = {
    addEventListener: () => {},
    appendChild: () => {},
    cloneNode: () => createElementStub(),
    querySelector: () => createElementStub(),
    setAttribute: (name, value) => {
      attributes.set(String(name), String(value));
    },
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: name => {
      attributes.delete(name);
    },
    removeEventListener: () => {},
    dataset: {},
    style: {},
    textContent: '',
    value: '',
    innerHTML: '',
    disabled: false,
  };

  node.content = {
    cloneNode: () => createElementStub(),
  };

  return node;
}

/**
 * Installs DOM, media, and Chrome stubs required to exercise the popup logic
 * in a Node.js test environment.
 *
 * @returns {{ chrome: Record<string, unknown>, getElement: Function }} Handles
 *   for accessing stubbed objects within tests.
 */
export function setupPopupTestEnvironment() {
  const elementCache = new Map();

  const documentStub = {
    addEventListener: () => {},
    getElementById: id => {
      if (!elementCache.has(id)) {
        elementCache.set(id, createElementStub());
      }
      return elementCache.get(id);
    },
    querySelector: selector => {
      if (typeof selector === 'string' && selector.startsWith('#')) {
        return documentStub.getElementById(selector.slice(1));
      }
      return createElementStub();
    },
  };

  globalThis.document = documentStub;
  const speechSynthesisStub = {
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = { addEventListener: () => {}, speechSynthesis: speechSynthesisStub };
  globalThis.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [],
      }),
    },
  };
  globalThis.speechSynthesis = speechSynthesisStub;

  globalThis.Audio = class {
    #handlers = new Map();

    constructor() {
      this.currentTime = 0;
      this.src = '';
      this.playbackRate = 1;
    }

    addEventListener(name, handler) {
      if (!this.#handlers.has(name)) {
        this.#handlers.set(name, new Set());
      }
      this.#handlers.get(name).add(handler);
    }

    removeEventListener(name, handler) {
      this.#handlers.get(name)?.delete(handler);
    }

    async play() {
      queueMicrotask(() => {
        const handlers = this.#handlers.get('ended');
        if (handlers) {
          handlers.forEach(listener => {
            listener();
          });
        }
      });
      return undefined;
    }

    pause() {}
  };

  globalThis.URL = {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  };

  const chromeStub = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        if (message?.type === 'comet:getVoiceCapabilities') {
          const payload = {
            provider: 'openai',
            availableVoices: ['alloy'],
            preferredVoice: 'alloy',
          };
          callback?.({ success: true, result: payload, error: null });
          return;
        }
        throw new Error('sendMessage stub not configured');
      },
    },
    tabs: {
      query: (_options, callback) => {
        if (callback) {
          callback([]);
        }
        return Promise.resolve([]);
      },
      sendMessage: () => {
        throw new Error('sendMessage stub not configured');
      },
    },
    scripting: {
      executeScript: () => {
        throw new Error('executeScript stub not configured');
      },
    },
    storage: {
      sync: {
        get: (_keys, callback) => callback({}),
        set: (_values, callback) => callback(),
      },
      local: {
        get: (_keys, callback) => callback({}),
        set: (_values, callback) => callback(),
      },
    },
  };

  globalThis.chrome = chromeStub;

  return {
    chrome: chromeStub,
    getElement(id) {
      return elementCache.get(id);
    },
  };
}

