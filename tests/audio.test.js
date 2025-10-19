import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bufferToWave,
  base64ToArrayBuffer,
  playAudioFromBase64,
  createRecorder,
  ensureAudioContext,
} from '../utils/audio.js';

test('bufferToWave encodes PCM audio into a WAV blob', async () => {
  const samples = new Float32Array([1, -1, 0]);
  const fakeBuffer = {
    numberOfChannels: 1,
    length: samples.length,
    getChannelData: () => samples,
  };

  const blob = bufferToWave(fakeBuffer, 48000);
  assert.equal(blob.type, 'audio/wav');

  const buffer = Buffer.from(await blob.arrayBuffer());
  assert.equal(buffer.slice(0, 4).toString(), 'RIFF');
  assert.equal(buffer.slice(8, 12).toString(), 'WAVE');

  const pcm = buffer.slice(44);
  assert.equal(pcm.length, samples.length * 2);
  // PCM values are 16-bit signed integers.
  assert.equal(pcm.readInt16LE(0), 0x7fff);
  assert.equal(pcm.readInt16LE(2), -0x8000);
  assert.equal(pcm.readInt16LE(4), 0);
});

test('base64ToArrayBuffer decodes binary payloads', () => {
  const base64 = Buffer.from('audio').toString('base64');
  const arrayBuffer = base64ToArrayBuffer(base64);
  const decoded = Buffer.from(arrayBuffer).toString();
  assert.equal(decoded, 'audio');
});

test('playAudioFromBase64 creates an audio element and revokes object URLs', async () => {
  const createdUrls = [];
  const revokedUrls = [];
  const originalURL = globalThis.URL;
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;

  try {
    globalThis.URL = {
      createObjectURL(blob) {
        createdUrls.push(blob.type);
        return 'blob:test';
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      },
    };

    class FakeAudio {
      constructor(src) {
        this.src = src;
      }

      async play() {
        this.played = true;
      }
    }

    const scheduled = [];
    globalThis.Audio = FakeAudio;
    globalThis.setTimeout = (fn, delay) => {
      scheduled.push({ fn, delay });
      return 1;
    };

    const audio = await playAudioFromBase64(Buffer.from('sound').toString('base64'), 'audio/mp3');
    assert.ok(audio instanceof FakeAudio);
    assert.equal(audio.src, 'blob:test');
    assert.deepEqual(createdUrls, ['audio/mp3']);
    assert.equal(revokedUrls.length, 0);

    // Execute the scheduled cleanup to ensure revoke is invoked.
    scheduled.forEach(job => job.fn());
    assert.deepEqual(revokedUrls, ['blob:test']);
  } finally {
    globalThis.URL = originalURL;
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('createRecorder wraps MediaRecorder with helper controls', async () => {
  const originalWindow = globalThis.window;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const mimeType = 'audio/webm';
  class FakeMediaRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['chunk'], { type: mimeType }) });
      }
      if (this.onstop) {
        this.onstop();
      }
    }
  }
  FakeMediaRecorder.isTypeSupported = type => type === mimeType;

  globalThis.window = {
    MediaRecorder: FakeMediaRecorder,
  };
  globalThis.MediaRecorder = FakeMediaRecorder;

  try {
    const helpers = createRecorder({ id: 'stream' }, { mimeType });
    assert.ok(helpers.recorder instanceof FakeMediaRecorder);

    helpers.start();
    assert.equal(helpers.recorder.state, 'recording');

    const blob = await helpers.stop();
    assert.equal(blob.type, mimeType);

    helpers.start();
    helpers.cancel();
    assert.equal(helpers.recorder.state, 'inactive');
  } finally {
    globalThis.window = originalWindow;
    globalThis.MediaRecorder = originalMediaRecorder;
  }
});

test('createRecorder rejects unsupported mime types', () => {
  const originalWindow = globalThis.window;
  const originalMediaRecorder = globalThis.MediaRecorder;
  class FakeMediaRecorder {
    constructor() {
      this.state = 'inactive';
    }
  }
  FakeMediaRecorder.isTypeSupported = () => false;
  globalThis.window = { MediaRecorder: FakeMediaRecorder };
  globalThis.MediaRecorder = FakeMediaRecorder;

  try {
    assert.throws(
      () => createRecorder({}, { mimeType: 'audio/ogg' }),
      error => {
        assert.equal(error.message, 'Unsupported mime type: audio/ogg');
        return true;
      },
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.MediaRecorder = originalMediaRecorder;
  }
});

test('createRecorder errors when MediaRecorder is unavailable', () => {
  const originalWindow = globalThis.window;
  globalThis.window = {};
  try {
    assert.throws(
      () => createRecorder({}),
      error => {
        assert.equal(error.message, 'MediaRecorder is not supported in this browser.');
        return true;
      },
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test('ensureAudioContext returns a context when available', async () => {
  const originalWindow = globalThis.window;
  class FakeAudioContext {}
  globalThis.window = { AudioContext: FakeAudioContext };

  try {
    const context = await ensureAudioContext();
    assert.ok(context instanceof FakeAudioContext);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('ensureAudioContext throws when the API is missing', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {};

  try {
    await assert.rejects(
      ensureAudioContext(),
      error => {
        assert.equal(error.message, 'AudioContext is not supported in this environment.');
        return true;
      },
    );
  } finally {
    globalThis.window = originalWindow;
  }
});
