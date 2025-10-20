function createElementStub() {
  const node = {
    addEventListener: () => {},
    appendChild: () => {},
    cloneNode: () => createElementStub(),
    querySelector: () => createElementStub(),
    setAttribute: () => {},
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
    querySelector: () => createElementStub(),
  };

  globalThis.document = documentStub;
  globalThis.window = { addEventListener: () => {} };
  globalThis.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [],
      }),
    },
  };

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
        if (message?.type === 'comet:setProvider') {
          const response = { ok: true, result: { provider: message.payload?.provider } };
          if (typeof callback === 'function') {
            callback(response);
            return undefined;
          }
          return Promise.resolve(response);
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
    },
  };

  globalThis.chrome = chromeStub;
  globalThis.__COMET_CHROME_OVERRIDE__ = chromeStub;

  return {
    chrome: chromeStub,
    getElement(id) {
      return elementCache.get(id);
    },
  };
}

