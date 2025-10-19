function createElementStub() {
  const node = {
    addEventListener: () => {},
    appendChild: () => {},
    cloneNode: () => createElementStub(),
    querySelector: () => createElementStub(),
    setAttribute: () => {},
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

    addEventListener(name, handler) {
      this.#handlers.set(name, handler);
    }

    async play() {
      return undefined;
    }

    pause() {}
  };

  const chromeStub = {
    runtime: {
      lastError: null,
      sendMessage: () => {
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

  return {
    chrome: chromeStub,
    getElement(id) {
      return elementCache.get(id);
    },
  };
}

