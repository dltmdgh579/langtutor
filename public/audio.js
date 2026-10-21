// Microphone capture (-> PCM16 @ 24kHz, base64) and streaming playback of
// the tutor's PCM16 audio, with support for barge-in (stop + measure).

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.length++] = channel[i];
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0));
          this.length = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

// Streaming linear resampler that keeps its position across chunks.
class Resampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.pos = 0;
    this.last = 0;
  }

  process(input) {
    // Sample index 0 is the last sample of the previous chunk.
    const at = (i) => (i === 0 ? this.last : input[i - 1]);
    const lastIndex = input.length;
    const out = [];
    let pos = this.pos;
    while (pos < lastIndex) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(at(i) + (at(i + 1) - at(i)) * frac);
      pos += this.step;
    }
    this.pos = pos - lastIndex;
    this.last = input[input.length - 1];
    return out;
  }
}

function floatToBase64Pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64Pcm16ToFloat(base64) {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const samples = new Float32Array(binary.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  return samples;
}

export class Microphone {
  constructor(ctx, sampleRate, onChunk) {
    this.ctx = ctx;
    this.onChunk = onChunk;
    this.muted = false;
    this.resampler = new Resampler(ctx.sampleRate, sampleRate);
    this.pending = [];
    // Send ~100ms per message to keep the event rate reasonable.
    this.flushSize = sampleRate / 10;
    this.level = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor');
    this.node.port.onmessage = ({ data }) => this.handleFrame(data);
    this.source.connect(this.node);
  }

  handleFrame(frame) {
    let peak = 0;
    for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
    this.level = this.muted ? 0 : peak;

    // While muted keep the stream flowing as silence so server VAD can close turns.
    const samples = this.resampler.process(this.muted ? new Float32Array(frame.length) : frame);
    for (const s of samples) this.pending.push(s);
    if (this.pending.length >= this.flushSize) {
      this.onChunk(floatToBase64Pcm16(this.pending));
      this.pending = [];
    }
  }

  stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}

export class Player {
  constructor(ctx, sampleRate) {
    this.ctx = ctx;
    this.sampleRate = sampleRate;
    this.sources = new Set();
    this.nextTime = 0;
    this.itemId = null;
    this.itemStart = 0;
    this.itemQueuedSec = 0;
    // All playback goes through an analyser so the UI can follow the tutor's voice.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(ctx.destination);
    this.levelBuffer = new Float32Array(this.analyser.fftSize);
  }

  get isPlaying() {
    return this.sources.size > 0;
  }

  get level() {
    if (!this.isPlaying) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let peak = 0;
    for (const s of this.levelBuffer) peak = Math.max(peak, Math.abs(s));
    return peak;
  }

  enqueue(base64, itemId) {
    const samples = base64Pcm16ToFloat(base64);
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;

    if (itemId !== this.itemId) {
      this.itemId = itemId;
      this.itemStart = startAt;
      this.itemQueuedSec = 0;
    }
    this.itemQueuedSec += buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  // Stops playback and reports how much of the current item the learner heard,
  // so the server-side conversation can be truncated to match.
  interrupt() {
    const heard = this.itemId
      ? {
          itemId: this.itemId,
          playedMs: Math.round(
            Math.max(0, Math.min(this.ctx.currentTime - this.itemStart, this.itemQueuedSec)) * 1000,
          ),
        }
      : null;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources.clear();
    this.nextTime = 0;
    this.itemId = null;
    return heard;
  }
}
