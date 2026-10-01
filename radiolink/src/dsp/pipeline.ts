/**
 * Adaptive receive pipeline.
 *
 * Design rule: never destroy weak signals. Everything here is either linear
 * (gain, DC removal, band limiting) or extremely narrow (hum / carrier
 * notches). No broadband noise reduction is applied, because digital
 * weak-signal decoders work *below* the noise floor and aggressive denoising
 * would throw the signal away with the noise.
 */
import { realSpectrum, hann, nextPow2 } from './fft';
import { Biquad, DcBlocker } from './filters';

export interface StreamMetrics {
  /** RMS level in dBFS. */
  levelDb: number;
  /** Peak level in dBFS. */
  peakDb: number;
  /** Percentage of samples at or beyond full scale. */
  clipPercent: number;
  /** DC offset as a fraction of full scale. */
  dcOffset: number;
}

export interface DspReport {
  /** Noise floor of the audio passband, dBFS per analysis bin. */
  noiseFloorDb: number;
  /** Strongest in-band signal level relative to full scale. */
  peakSignalDb: number;
  /** Crude wideband SNR estimate (peak above floor). */
  snrDb: number;
  clipPercent: number;
  levelDb: number;
  dcOffset: number;
  /** Detected mains hum frequencies that were notched out. */
  humNotches: number[];
  /** Detected steady carriers (birdies) that were notched out. */
  carrierNotches: number[];
  /** Fading depth in dB measured over the slot (std-dev of the envelope). */
  fadingDb: number;
  /** True when the input is so quiet that decoding is unreliable. */
  tooQuiet: boolean;
  /** Gain applied by the automatic normalizer. */
  gainApplied: number;
  /** Spectral tilt across the passband in dB (uneven frequency response). */
  tiltDb: number;
  /** Fraction of the slot that was digital silence (dropout). */
  dropoutPercent: number;
}

export interface DspSettings {
  auto: boolean;
  dcBlock: boolean;
  humSuppression: boolean;
  carrierNotch: boolean;
  bandpass: boolean;
  bandLowHz: number;
  bandHighHz: number;
  normalize: boolean;
  /** Target RMS for normalization, in dBFS. */
  targetLevelDb: number;
}

export const DEFAULT_DSP: DspSettings = {
  auto: true,
  dcBlock: true,
  humSuppression: true,
  carrierNotch: true,
  bandpass: true,
  bandLowHz: 200,
  bandHighHz: 3200,
  normalize: true,
  targetLevelDb: -20,
};

export function measureStream(chunk: Float32Array): StreamMetrics {
  let sum = 0;
  let sum2 = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i];
    sum += v;
    sum2 += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.985) clipped++;
  }
  const n = Math.max(1, chunk.length);
  const rms = Math.sqrt(sum2 / n);
  return {
    levelDb: 20 * Math.log10(rms + 1e-9),
    peakDb: 20 * Math.log10(peak + 1e-9),
    clipPercent: (100 * clipped) / n,
    dcOffset: sum / n,
  };
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

/** Average power spectrum (dB) of a slot, using Welch averaging. */
export function slotSpectrum(samples: Float32Array, _sampleRate: number, fftSize = 4096): Float32Array {
  const n = nextPow2(fftSize);
  const win = hann(n);
  const hop = n / 2;
  const acc = new Float32Array(n / 2 + 1);
  let count = 0;
  for (let off = 0; off + n <= samples.length; off += hop) {
    const sp = realSpectrum(samples.subarray(off, off + n), win);
    for (let i = 0; i < acc.length; i++) acc[i] += sp[i];
    count++;
  }
  const out = new Float32Array(acc.length);
  for (let i = 0; i < acc.length; i++) out[i] = 10 * Math.log10(acc[i] / Math.max(1, count) / (n * n) + 1e-20);
  return out;
}

/**
 * Process one slot of audio: measure, clean up narrow interference and
 * normalize the level. Returns the cleaned audio plus a diagnostic report.
 */
export function processSlot(
  input: Float32Array,
  sampleRate: number,
  settings: DspSettings = DEFAULT_DSP,
): { audio: Float32Array; report: DspReport } {
  const audio = Float32Array.from(input);
  const metrics = measureStream(audio);

  if (settings.dcBlock || settings.auto) new DcBlocker().processInPlace(audio);

  const fftSize = 4096;
  const spec = slotSpectrum(audio, sampleRate, fftSize);
  const binHz = sampleRate / fftSize;
  const lo = Math.floor(settings.bandLowHz / binHz);
  const hi = Math.min(spec.length - 1, Math.ceil(settings.bandHighHz / binHz));
  const inBand: number[] = [];
  for (let i = lo; i <= hi; i++) inBand.push(spec[i]);
  const noiseFloorDb = percentile(inBand, 0.25);
  const peakSignalDb = Math.max(...inBand);

  // --- hum detection: mains harmonics standing well above the local floor ---
  const humNotches: number[] = [];
  if (settings.humSuppression || settings.auto) {
    // Only the low harmonics matter, and the peak must be *narrow*: a digital
    // signal is tens of Hz wide and must never be notched away.
    for (const base of [50, 60]) {
      for (let h = 1; h * base <= Math.min(420, settings.bandHighHz); h++) {
        const f = h * base;
        if (f < settings.bandLowHz - 40) continue;
        const bin = Math.round(f / binHz);
        if (bin <= 3 || bin >= spec.length - 4) continue;
        const local: number[] = [];
        for (let k = bin - 20; k <= bin + 20; k++) if (Math.abs(k - bin) > 3 && k > 0 && k < spec.length) local.push(spec[k]);
        const floor = percentile(local, 0.5);
        const narrow = spec[bin] - Math.max(spec[bin - 3], spec[bin + 3]) > 12;
        if (spec[bin] - floor > 12 && narrow && !humNotches.some((x) => Math.abs(x - f) < 5)) humNotches.push(f);
      }
    }
  }

  // --- steady carrier (birdie) detection: single-bin peaks, not FSK signals ---
  const carrierNotches: number[] = [];
  if (settings.carrierNotch || settings.auto) {
    for (let i = lo + 3; i < hi - 3; i++) {
      const local: number[] = [];
      for (let k = i - 25; k <= i + 25; k++) if (Math.abs(k - i) > 4 && k > 0 && k < spec.length) local.push(spec[k]);
      const floor = percentile(local, 0.5);
      const isPeak = spec[i] > spec[i - 1] && spec[i] > spec[i + 1];
      const narrow = spec[i] - Math.max(spec[i - 3], spec[i + 3]) > 18;
      if (isPeak && narrow && spec[i] - floor > 22) {
        const f = i * binHz;
        if (!carrierNotches.some((x) => Math.abs(x - f) < 3 * binHz)) carrierNotches.push(f);
      }
    }
  }

  for (const f of humNotches.slice(0, 8)) Biquad.notch(sampleRate, f, 35).processInPlace(audio);
  for (const f of carrierNotches.slice(0, 4)) Biquad.notch(sampleRate, f, 60).processInPlace(audio);

  if (settings.bandpass || settings.auto) {
    Biquad.highpass(sampleRate, settings.bandLowHz, 0.7).processInPlace(audio);
    Biquad.lowpass(sampleRate, settings.bandHighHz, 0.7).processInPlace(audio);
  }

  // --- fading / dropout analysis on the band-limited audio ---
  const winLen = Math.round(sampleRate * 0.2);
  const envelope: number[] = [];
  let silent = 0;
  for (let off = 0; off + winLen <= audio.length; off += winLen) {
    let s2 = 0;
    for (let i = 0; i < winLen; i++) s2 += audio[off + i] * audio[off + i];
    const rms = Math.sqrt(s2 / winLen);
    envelope.push(20 * Math.log10(rms + 1e-9));
    if (rms < 1e-5) silent++;
  }
  const meanEnv = envelope.reduce((a, b) => a + b, 0) / Math.max(1, envelope.length);
  const fadingDb = Math.sqrt(
    envelope.reduce((a, b) => a + (b - meanEnv) * (b - meanEnv), 0) / Math.max(1, envelope.length),
  );
  const dropoutPercent = (100 * silent) / Math.max(1, envelope.length);

  // --- spectral tilt (poor microphone / uneven audio response) ---
  const third = Math.floor((hi - lo) / 3);
  const lowAvg = inBand.slice(0, third).reduce((a, b) => a + b, 0) / Math.max(1, third);
  const highAvg = inBand.slice(-third).reduce((a, b) => a + b, 0) / Math.max(1, third);
  const tiltDb = highAvg - lowAvg;

  // --- automatic gain normalization (linear, no compression) ---
  let gainApplied = 1;
  if (settings.normalize || settings.auto) {
    let s2 = 0;
    for (let i = 0; i < audio.length; i++) s2 += audio[i] * audio[i];
    const rms = Math.sqrt(s2 / Math.max(1, audio.length));
    const target = Math.pow(10, settings.targetLevelDb / 20);
    if (rms > 1e-7) {
      gainApplied = Math.min(2000, target / rms);
      for (let i = 0; i < audio.length; i++) audio[i] *= gainApplied;
    }
  }

  return {
    audio,
    report: {
      noiseFloorDb,
      peakSignalDb,
      snrDb: peakSignalDb - noiseFloorDb,
      clipPercent: metrics.clipPercent,
      levelDb: metrics.levelDb,
      dcOffset: metrics.dcOffset,
      humNotches,
      carrierNotches,
      fadingDb,
      tooQuiet: metrics.levelDb < -55,
      gainApplied,
      tiltDb,
      dropoutPercent,
    },
  };
}
