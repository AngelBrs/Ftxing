/**
 * Shared M-FSK modem for the FT-family and JS8.
 *
 * Transmit  : GFSK synthesis identical to the WSJT-X / ft8_lib reference
 *             (Gaussian frequency pulse, BT = 2 for FT8/JS8, 1 for FT4).
 * Receive   : non-coherent FFT symbol spectra (2x time / 2x frequency
 *             oversampling), Costas sync search over the whole audio band and
 *             a +/- few second time window, max-log soft symbol metrics, then
 *             LDPC belief propagation + CRC validation in the mode layer.
 */
import { fftAny, hann } from '../dsp/fft';
import type { ModeSpec } from './modes';
import { toneSpacing } from './modes';

const GFSK_K = 5.336446; // pi * sqrt(2 / ln 2)

/** Gaussian frequency-shaping pulse spanning three symbol periods. */
function gfskPulse(nSpSym: number, bt: number): Float32Array {
  const p = new Float32Array(3 * nSpSym);
  for (let i = 0; i < 3 * nSpSym; i++) {
    const t = i / nSpSym - 1.5;
    p[i] = (erf(GFSK_K * bt * (t + 0.5)) - erf(GFSK_K * bt * (t - 0.5))) / 2;
  }
  return p;
}

/** Abramowitz & Stegun 7.1.26 error function (max error 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface SynthOptions {
  sampleRate: number;
  /** Audio frequency of tone 0, in Hz. */
  baseFrequency: number;
  amplitude?: number;
}

/** Synthesize the GFSK audio waveform for a tone sequence. */
export function synthesize(tones: Uint8Array | number[], spec: ModeSpec, opts: SynthOptions): Float32Array {
  const fs = opts.sampleRate;
  const nSpSym = Math.round(fs * spec.symbolPeriod);
  const nSym = tones.length;
  const nWave = nSym * nSpSym;
  const amp = opts.amplitude ?? 0.7;
  const df = toneSpacing(spec);

  const dphiPeak = (2 * Math.PI * df) / (fs / 1) / 1; // rad per sample for one tone step
  const dphi = new Float32Array(nWave + 2 * nSpSym);
  const carrier = (2 * Math.PI * opts.baseFrequency) / fs;
  dphi.fill(carrier);

  const pulse = gfskPulse(nSpSym, spec.bt);
  for (let i = 0; i < nSym; i++) {
    const ib = i * nSpSym;
    const tone = tones[i];
    for (let j = 0; j < 3 * nSpSym; j++) dphi[j + ib] += dphiPeak * tone * pulse[j];
  }
  // extend first/last symbol so the phase trajectory is continuous
  for (let j = 0; j < 2 * nSpSym; j++) {
    dphi[j] += dphiPeak * pulse[j + nSpSym] * tones[0];
    dphi[j + nSym * nSpSym] += dphiPeak * pulse[j] * tones[nSym - 1];
  }

  const out = new Float32Array(nWave);
  let phi = 0;
  for (let k = 0; k < nWave; k++) {
    out[k] = amp * Math.sin(phi);
    phi += dphi[k + nSpSym];
    if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
  }
  // raised-cosine envelope on the first/last 1/8 symbol
  const nRamp = Math.max(1, Math.floor(nSpSym / 8));
  for (let i = 0; i < nRamp; i++) {
    const env = (1 - Math.cos((2 * Math.PI * i) / (2 * nRamp))) / 2;
    out[i] *= env;
    out[nWave - 1 - i] *= env;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Receive side                                                        */
/* ------------------------------------------------------------------ */

export const TIME_OSR = 2;
export const FREQ_OSR = 2;

/**
 * Log-power symbol spectra: one row every (symbolPeriod / TIME_OSR) seconds,
 * one column every (toneSpacing / FREQ_OSR) Hz.
 */
export class SymbolSpectra {
  readonly nBlocks: number;
  readonly nBins: number;
  readonly binHz: number;
  readonly blockSeconds: number;
  readonly mag: Float32Array; // dB, row-major [block * nBins + bin]
  readonly noiseDb: number;
  readonly nSpSym: number;
  /** Seconds to add to (block * blockSeconds) to get the true frame start. */
  readonly dtOffset: number;

  constructor(samples: Float32Array, sampleRate: number, spec: ModeSpec, maxHz = 4000, winMult?: number) {
    const nSpSym = Math.round(sampleRate * spec.symbolPeriod);
    const nfft = nSpSym * FREQ_OSR;
    const step = Math.round(nSpSym / TIME_OSR);
    // Analysis window of 1.8 symbol periods: empirically the best compromise
    // between matched-filter gain and inter-symbol leakage for GFSK (the same
    // value the ft8_lib reference monitor settled on).
    const winLen = Math.min(nfft, Math.round(nSpSym * (winMult ?? spec.analysisWindow ?? 1.8)));
    const win = hann(winLen);
    let winPow = 0;
    for (let i = 0; i < winLen; i++) winPow += win[i] * win[i];

    const nBins = Math.min(nfft / 2, Math.ceil((maxHz * nfft) / sampleRate));
    const nBlocks = Math.max(0, Math.floor((samples.length - winLen) / step) + 1);
    const mag = new Float32Array(nBlocks * nBins);
    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);

    for (let b = 0; b < nBlocks; b++) {
      const off = b * step;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < winLen; i++) re[i] = (samples[off + i] ?? 0) * win[i];
      fftAny(re, im);
      const row = b * nBins;
      for (let k = 0; k < nBins; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) / winPow;
        mag[row + k] = 10 * Math.log10(p + 1e-20);
      }
    }

    this.nBlocks = nBlocks;
    this.nBins = nBins;
    this.mag = mag;
    this.binHz = sampleRate / nfft;
    this.blockSeconds = step / sampleRate;
    this.nSpSym = nSpSym;
    this.dtOffset = (winLen / 2 - nSpSym / 2) / sampleRate;
    this.noiseDb = percentileDb(mag, 0.3);
  }

  at(block: number, bin: number): number {
    if (block < 0 || block >= this.nBlocks || bin < 0 || bin >= this.nBins) return -200;
    return this.mag[block * this.nBins + bin];
  }
}

function percentileDb(values: Float32Array, p: number): number {
  if (values.length === 0) return -100;
  const stride = Math.max(1, Math.floor(values.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += stride) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
}

export interface Candidate {
  /** index of the first symbol block */
  timeBlock: number;
  /** bin index of tone 0 */
  freqBin: number;
  score: number;
  frequency: number;
  dt: number;
}

export interface SearchOptions {
  minHz?: number;
  maxHz?: number;
  /** earliest start time relative to the start of the buffer, seconds */
  minDt?: number;
  maxDt?: number;
  maxCandidates?: number;
}

/** Costas correlation search over time and frequency. */
export function findCandidates(sp: SymbolSpectra, spec: ModeSpec, opts: SearchOptions = {}): Candidate[] {
  const minHz = opts.minHz ?? 150;
  const maxHz = opts.maxHz ?? 3200;
  const minBin = Math.max(0, Math.floor(minHz / sp.binHz));
  const maxBin = Math.min(sp.nBins - spec.tones * FREQ_OSR - 1, Math.ceil(maxHz / sp.binHz));
  const minDt = opts.minDt ?? -2.5;
  const maxDt = opts.maxDt ?? 2.5;
  const minBlock = Math.floor(minDt / sp.blockSeconds);
  const maxBlock = Math.ceil(maxDt / sp.blockSeconds);
  const lastBlockNeeded = (spec.nSym - 1) * TIME_OSR;

  const out: Candidate[] = [];
  for (let t = minBlock; t <= maxBlock; t++) {
    if (t + lastBlockNeeded >= sp.nBlocks) break;
    if (t < 0) continue;
    for (let f = minBin; f <= maxBin; f++) {
      let score = 0;
      let n = 0;
      for (const g of spec.syncGroups) {
        for (let k = 0; k < g.tones.length; k++) {
          const block = t + (g.pos + k) * TIME_OSR;
          if (block < 0 || block >= sp.nBlocks) continue;
          let sum = 0;
          for (let tone = 0; tone < spec.tones; tone++) sum += sp.at(block, f + tone * FREQ_OSR);
          const expected = sp.at(block, f + g.tones[k] * FREQ_OSR);
          score += expected - sum / spec.tones;
          n++;
        }
      }
      if (n === 0) continue;
      out.push({
        timeBlock: t,
        freqBin: f,
        score: score / n,
        frequency: f * sp.binHz,
        dt: t * sp.blockSeconds + sp.dtOffset,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  // suppress neighbours in the (time, frequency) plane
  const kept: Candidate[] = [];
  const limit = opts.maxCandidates ?? 60;
  for (const c of out) {
    if (kept.length >= limit) break;
    const dup = kept.some(
      (k) => Math.abs(k.freqBin - c.freqBin) <= FREQ_OSR && Math.abs(k.timeBlock - c.timeBlock) <= TIME_OSR,
    );
    if (!dup) kept.push(c);
  }
  return kept;
}

/**
 * Max-log soft metrics for the codeword bits of one candidate.
 * Returns LLRs where positive means "bit is more likely 0".
 */
export function extractLlr(sp: SymbolSpectra, spec: ModeSpec, cand: Candidate, nBits: number): Float32Array {
  const bps = spec.bitsPerSymbol;
  const llr = new Float32Array(nBits);
  const toneBits = new Int32Array(spec.tones);
  for (let tone = 0; tone < spec.tones; tone++) {
    // map tone -> data bits (inverse of the Gray map when one is used)
    if (spec.gray) {
      const idx = spec.gray.indexOf(tone);
      toneBits[tone] = idx;
    } else {
      toneBits[tone] = tone;
    }
  }

  let bit = 0;
  const mags = new Float32Array(spec.tones);
  for (const symIdx of spec.dataSymbols) {
    if (bit >= nBits) break;
    const block = cand.timeBlock + symIdx * TIME_OSR;
    for (let tone = 0; tone < spec.tones; tone++) mags[tone] = sp.at(block, cand.freqBin + tone * FREQ_OSR);
    for (let b = 0; b < bps; b++) {
      if (bit >= nBits) break;
      const mask = 1 << (bps - 1 - b);
      let max0 = -1e9;
      let max1 = -1e9;
      for (let tone = 0; tone < spec.tones; tone++) {
        const v = mags[tone];
        if (toneBits[tone] & mask) {
          if (v > max1) max1 = v;
        } else if (v > max0) max0 = v;
      }
      llr[bit++] = max0 - max1;
    }
  }

  // Normalize: scale so that the metric distribution has unit-ish variance,
  // which keeps the min-sum decoder well conditioned on both strong and weak
  // signals (equivalent to ft8_lib's sigma normalization).
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < nBits; i++) {
    sum += llr[i];
    sum2 += llr[i] * llr[i];
  }
  const mean = sum / nBits;
  const variance = Math.max(1e-6, sum2 / nBits - mean * mean);
  const scale = 2.83 / Math.sqrt(variance);
  for (let i = 0; i < nBits; i++) llr[i] *= scale;
  return llr;
}

/** Estimate signal-to-noise ratio in the conventional 2500 Hz reference bandwidth. */
export function estimateSnr(sp: SymbolSpectra, spec: ModeSpec, cand: Candidate): number {
  let sigDb = 0;
  let n = 0;
  for (let s = 0; s < spec.nSym; s++) {
    const block = cand.timeBlock + s * TIME_OSR;
    if (block < 0 || block >= sp.nBlocks) continue;
    let best = -200;
    for (let tone = 0; tone < spec.tones; tone++) best = Math.max(best, sp.at(block, cand.freqBin + tone * FREQ_OSR));
    sigDb += Math.pow(10, best / 10);
    n++;
  }
  if (n === 0) return -30;
  const sigPow = sigDb / n;
  const noisePow = Math.pow(10, sp.noiseDb / 10);
  const signalOnly = Math.max(sigPow - noisePow, noisePow * 1e-3);
  // noise in the 2500 Hz reference bandwidth vs the analysis bin bandwidth
  const noiseRef = noisePow * (2500 / (1 / spec.symbolPeriod));
  // Empirical calibration: the peak-bin estimate above over-reads by about
  // 4.5 dB compared with the WSJT-X SNR convention (verified against
  // synthetic AWGN test vectors at known SNR).
  const snr = 10 * Math.log10(signalOnly / noiseRef) - 4.5;
  return Math.max(-35, Math.min(45, snr));
}

/** Refine the frequency estimate with a parabolic fit over neighbouring sub-bins. */
export function refineFrequency(sp: SymbolSpectra, spec: ModeSpec, cand: Candidate): number {
  const scoreAt = (f: number) => {
    let score = 0;
    let n = 0;
    for (const g of spec.syncGroups) {
      for (let k = 0; k < g.tones.length; k++) {
        const block = cand.timeBlock + (g.pos + k) * TIME_OSR;
        score += sp.at(block, f + g.tones[k] * FREQ_OSR);
        n++;
      }
    }
    return n ? score / n : -200;
  };
  const y0 = scoreAt(cand.freqBin - 1);
  const y1 = scoreAt(cand.freqBin);
  const y2 = scoreAt(cand.freqBin + 1);
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const clamped = Math.max(-1, Math.min(1, delta));
  return (cand.freqBin + clamped) * sp.binHz;
}

/**
 * Verify a decode by comparing the received symbol spectra against the tone
 * sequence implied by the decoded message.
 *
 * Ordered-statistics decoding always produces *some* codeword, so a CRC pass
 * alone leaves a 1/16384 chance of a false decode per attempt. Requiring the
 * received spectra to actually look like the decoded tones removes those
 * false decodes and gives an honest confidence value for the UI.
 */
export function verifyTones(
  sp: SymbolSpectra,
  spec: ModeSpec,
  cand: Candidate,
  tones: Uint8Array,
): { match: number; margin: number } {
  let hits = 0;
  let margin = 0;
  let n = 0;
  for (let s = 0; s < spec.nSym; s++) {
    const block = cand.timeBlock + s * TIME_OSR;
    if (block < 0 || block >= sp.nBlocks) continue;
    let best = -1;
    let bestVal = -1e9;
    let sum = 0;
    for (let tone = 0; tone < spec.tones; tone++) {
      const v = sp.at(block, cand.freqBin + tone * FREQ_OSR);
      sum += v;
      if (v > bestVal) {
        bestVal = v;
        best = tone;
      }
    }
    if (best === tones[s]) hits++;
    margin += sp.at(block, cand.freqBin + tones[s] * FREQ_OSR) - sum / spec.tones;
    n++;
  }
  return { match: n ? hits / n : 0, margin: n ? margin / n : 0 };
}
