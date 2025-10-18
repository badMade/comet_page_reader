export function bufferToWave(buffer, sampleRate) {
  const bytesPerSample = 2;
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length * numChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(arrayBuffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  let offset = 0;
  writeString(offset, 'RIFF'); offset += 4;
  view.setUint32(offset, 36 + length, true); offset += 4;
  writeString(offset, 'WAVE'); offset += 4;
  writeString(offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * numChannels * bytesPerSample, true); offset += 4;
  view.setUint16(offset, numChannels * bytesPerSample, true); offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true); offset += 2;
  writeString(offset, 'data'); offset += 4;
  view.setUint32(offset, length, true); offset += 4;

  for (let channel = 0; channel < numChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < channelData.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function playAudioFromBase64(base64, mimeType = 'audio/mpeg') {
  const arrayBuffer = base64ToArrayBuffer(base64);
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio(url);
    await audio.play();
    return audio;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export function createRecorder(stream, options = {}) {
  if (!window.MediaRecorder) {
    throw new Error('MediaRecorder is not supported in this browser.');
  }
  const mimeType = options.mimeType || 'audio/webm';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  return {
    recorder,
    start() {
      chunks.length = 0;
      recorder.start();
    },
    stop() {
      return new Promise(resolve => {
        recorder.ondataavailable = event => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.stop();
      });
    },
    cancel() {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      chunks.length = 0;
    },
  };
}

export async function ensureAudioContext() {
  if (window.AudioContext || window.webkitAudioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    return new Ctx();
  }
  throw new Error('AudioContext is not supported in this environment.');
}
