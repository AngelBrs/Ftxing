/**
 * Browser audio plumbing.
 *
 * RX: getUserMedia (with every browser "enhancement" disabled — echo
 *     cancellation, noise suppression and AGC destroy digital signals) ->
 *     AudioWorklet -> raw Float32 frames -> decoder worker.
 * TX: generated waveform -> AudioBuffer -> selected output device.
 */

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        this.buffer[this.pos++] = ch[i];
        if (this.pos === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0));
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export type AudioChunkHandler = (chunk: Float32Array, time: number) => void;

export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private txSource: AudioBufferSourceNode | null = null;
  private txResolve: (() => void) | null = null;
  private txGain: GainNode | null = null;
  private sinkElement: HTMLAudioElement | null = null;
  private sinkDest: MediaStreamAudioDestinationNode | null = null;
  onChunk: AudioChunkHandler | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get running(): boolean {
    return !!this.stream;
  }

  static async listDevices(): Promise<AudioDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || (d.kind === 'audioinput' ? 'Microphone' : 'Speaker'),
        kind: d.kind as 'audioinput' | 'audiooutput',
      }));
  }

  async startRx(deviceId?: string): Promise<void> {
    await this.stopRx();
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
    }
    await this.ctx.resume();
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -140;
    this.analyser.maxDecibels = 0;
    this.workletNode = new AudioWorkletNode(this.ctx, 'capture-processor');
    this.workletNode.port.onmessage = (ev) => {
      this.onChunk?.(ev.data as Float32Array, Date.now());
    };
    this.source.connect(this.analyser);
    this.source.connect(this.workletNode);
    // keep the worklet alive without feeding audio back to the speakers
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.workletNode.connect(mute).connect(this.ctx.destination);
  }

  async stopRx(): Promise<void> {
    this.workletNode?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.workletNode = null;
    this.source = null;
    this.stream = null;
  }

  /** Route transmit audio to a specific output device when the browser allows it. */
  async setOutputDevice(deviceId: string | undefined): Promise<'context' | 'element' | 'default'> {
    if (!this.ctx) this.ctx = new AudioContext();
    if (!deviceId || deviceId === 'default') return 'default';
    const anyCtx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof anyCtx.setSinkId === 'function') {
      try {
        await anyCtx.setSinkId(deviceId);
        return 'context';
      } catch {
        /* fall through to the element path */
      }
    }
    const el = this.sinkElement ?? document.createElement('audio');
    const elAny = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof elAny.setSinkId === 'function') {
      if (!this.sinkDest) {
        this.sinkDest = this.ctx.createMediaStreamDestination();
        el.srcObject = this.sinkDest.stream;
        el.autoplay = true;
        this.sinkElement = el;
      }
      await elAny.setSinkId(deviceId);
      await el.play().catch(() => undefined);
      return 'element';
    }
    return 'default';
  }

  /** Play a generated waveform. Resolves when playback finishes. */
  async play(samples: Float32Array, gain = 0.5): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    this.stopTx();
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (this.sinkDest) g.connect(this.sinkDest);
    else g.connect(this.ctx.destination);
    this.txSource = src;
    this.txGain = g;
    return new Promise((resolve) => {
      this.txResolve = resolve;
      src.onended = () => {
        this.txSource = null;
        this.txResolve = null;
        resolve();
      };
      src.start();
    });
  }

  stopTx(): void {
    const resolve = this.txResolve;
    this.txResolve = null;
    if (this.txSource) {
      try {
        this.txSource.onended = null;
        this.txSource.stop();
      } catch {
        /* already stopped */
      }
      this.txSource.disconnect();
      this.txSource = null;
    }
    this.txGain?.disconnect();
    this.txGain = null;
    // make sure a caller awaiting play() is released when we cut TX short
    resolve?.();
  }

  /** Current spectrum for the waterfall (dB values, one per FFT bin). */
  spectrum(out: Float32Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
    return true;
  }

  get spectrumBins(): number {
    return this.analyser ? this.analyser.frequencyBinCount : 0;
  }

  async close(): Promise<void> {
    await this.stopRx();
    this.stopTx();
    await this.ctx?.close();
    this.ctx = null;
  }
}
