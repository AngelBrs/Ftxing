/** Small DSP building blocks used by the adaptive receive pipeline. */

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  static lowpass(fs: number, f0: number, q = 0.707): Biquad {
    const b = new Biquad();
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const cosw = Math.cos(w);
    const a0 = 1 + alpha;
    b.b0 = ((1 - cosw) / 2) / a0;
    b.b1 = (1 - cosw) / a0;
    b.b2 = b.b0;
    b.a1 = (-2 * cosw) / a0;
    b.a2 = (1 - alpha) / a0;
    return b;
  }

  static highpass(fs: number, f0: number, q = 0.707): Biquad {
    const b = new Biquad();
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const cosw = Math.cos(w);
    const a0 = 1 + alpha;
    b.b0 = ((1 + cosw) / 2) / a0;
    b.b1 = -(1 + cosw) / a0;
    b.b2 = b.b0;
    b.a1 = (-2 * cosw) / a0;
    b.a2 = (1 - alpha) / a0;
    return b;
  }

  static notch(fs: number, f0: number, q = 30): Biquad {
    const b = new Biquad();
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const cosw = Math.cos(w);
    const a0 = 1 + alpha;
    b.b0 = 1 / a0;
    b.b1 = (-2 * cosw) / a0;
    b.b2 = 1 / a0;
    b.a1 = (-2 * cosw) / a0;
    b.a2 = (1 - alpha) / a0;
    return b;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  processInPlace(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      buf[i] = y;
    }
  }
}

/** First-order DC blocker (removes soundcard DC offset). */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private readonly r: number;
  constructor(r = 0.999) {
    this.r = r;
  }
  processInPlace(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = x - this.x1 + this.r * this.y1;
      this.x1 = x;
      this.y1 = y;
      buf[i] = y;
    }
  }
}

/**
 * Arbitrary-ratio resampler with a windowed-sinc kernel.
 * Used to bring whatever rate the browser gives us (44.1/48/16 kHz ...) to
 * the 12 kHz the decoders work at.
 */
export class Resampler {
  private static readonly TAPS = 16;
  private history = new Float32Array(Resampler.TAPS);
  /** Position of the next output sample inside (history ++ input). */
  private pos = Resampler.TAPS;

  private readonly inRate: number;
  private readonly outRate: number;

  constructor(inRate: number, outRate: number) {
    this.inRate = inRate;
    this.outRate = outRate;
  }

  get ratio(): number {
    return this.inRate / this.outRate;
  }

  process(input: Float32Array): Float32Array {
    const taps = Resampler.TAPS;
    const half = taps / 2;
    const H = this.history.length;
    const buf = new Float32Array(H + input.length);
    buf.set(this.history);
    buf.set(input, H);

    const step = this.ratio;
    const cutoff = Math.min(1, this.outRate / this.inRate) * 0.95;
    const out: number[] = [];
    let pos = this.pos;
    const limit = buf.length - half;
    while (pos < limit) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      let acc = 0;
      let norm = 0;
      for (let k = -half + 1; k <= half; k++) {
        const x = k - frac;
        const w = 0.54 + 0.46 * Math.cos((Math.PI * x) / half);
        const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
        const h = w * sinc;
        const idx = i0 + k;
        acc += (idx >= 0 && idx < buf.length ? buf[idx] : 0) * h;
        norm += h;
      }
      out.push(norm !== 0 ? acc / norm : acc);
      pos += step;
    }

    this.history = buf.slice(Math.max(0, buf.length - taps));
    this.pos = pos - (buf.length - this.history.length);
    return Float32Array.from(out);
  }
}
