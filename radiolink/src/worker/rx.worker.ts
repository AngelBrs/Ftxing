/// <reference lib="webworker" />
/**
 * Receive worker: keeps a rolling 12 kHz buffer of microphone audio, and at
 * the end of every transmission slot runs the DSP + decoder chain for each
 * active mode. All heavy lifting happens here so the UI never blocks.
 */
import { Resampler } from '../dsp/filters';
import { measureStream, processSlot, type DspSettings, DEFAULT_DSP } from '../dsp/pipeline';
import { CallsignHashTable } from '../protocols/message77';
import type { ModeId } from '../protocols/modes';
import { decodeSlotForMode, slotMs, slotStart, type SlotResult } from '../engine/decodeSlot';

const DECODE_RATE = 12000;
const BUFFER_SECONDS = 45;

interface WorkerOptions {
  modes: ModeId[];
  dsp: DspSettings;
  osdOrder: number;
  maxCandidates: number;
  minHz: number;
  maxHz: number;
  enabled: boolean;
}

let options: WorkerOptions = {
  modes: ['FT8'],
  dsp: DEFAULT_DSP,
  osdOrder: 1,
  maxCandidates: 24,
  minHz: 200,
  maxHz: 3000,
  enabled: true,
};

const hashes = new CallsignHashTable();
let resampler: Resampler | null = null;
let inputRate = 48000;

const ring = new Float32Array(DECODE_RATE * BUFFER_SECONDS);
let writePos = 0;
let totalSamples = 0;
/** Wall-clock time (ms) corresponding to sample index 0 of the stream. */
let timeOrigin = 0;
let originInitialised = false;

const lastProcessed = new Map<ModeId, number>();

function pushSamples(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    ring[writePos] = data[i];
    writePos = (writePos + 1) % ring.length;
  }
  totalSamples += data.length;
}

/** Copy samples for the absolute time range [startMs, endMs). */
function extract(startMs: number, endMs: number): Float32Array | null {
  const startIdx = Math.round(((startMs - timeOrigin) / 1000) * DECODE_RATE);
  const endIdx = Math.round(((endMs - timeOrigin) / 1000) * DECODE_RATE);
  if (endIdx > totalSamples) return null;
  if (startIdx < totalSamples - ring.length || startIdx < 0) return null;
  const n = endIdx - startIdx;
  if (n <= 0 || n > ring.length) return null;
  const out = new Float32Array(n);
  let pos = (writePos - (totalSamples - startIdx) + ring.length * 4) % ring.length;
  for (let i = 0; i < n; i++) {
    out[i] = ring[pos];
    pos = (pos + 1) % ring.length;
  }
  return out;
}

function maybeDecode(): void {
  if (!options.enabled) return;
  const now = Date.now();
  for (const mode of options.modes) {
    const len = slotMs(mode);
    // the most recent slot that has completely finished
    const current = slotStart(mode, now);
    const finished = current - len;
    if ((lastProcessed.get(mode) ?? 0) >= finished) continue;
    const pre = 1000;
    const post = 1200;
    // wait until the tail of the window has actually been captured
    const guard = post + 400;
    if (now - (finished + len) < guard) continue;
    const samples = extract(finished - pre, finished + len + post);
    if (!samples) {
      // give up on this slot only once it is clearly unrecoverable
      if (now - (finished + len) > 4000) lastProcessed.set(mode, finished);
      continue;
    }
    lastProcessed.set(mode, finished);
    try {
      const processed = processSlot(samples, DECODE_RATE, options.dsp);
      const result: SlotResult = decodeSlotForMode(samples, DECODE_RATE, mode, finished, {
        modes: options.modes,
        dsp: options.dsp,
        osdOrder: options.osdOrder,
        maxCandidates: options.maxCandidates,
        minHz: options.minHz,
        maxHz: options.maxHz,
        hashes,
      }, processed);
      // dt is measured from the start of the extracted window, which begins
      // `pre` ms before the slot
      for (const d of result.decodes) d.dt -= pre / 1000;
      self.postMessage({ type: 'slot', result, knownCalls: hashes.entries().length });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err), mode });
    }
  }
}

let metricAccum: Float32Array[] = [];
let lastMetric = 0;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      inputRate = msg.sampleRate;
      resampler = inputRate === DECODE_RATE ? null : new Resampler(inputRate, DECODE_RATE);
      options = { ...options, ...msg.options };
      originInitialised = false;
      totalSamples = 0;
      writePos = 0;
      ring.fill(0);
      lastProcessed.clear();
      self.postMessage({ type: 'ready', inputRate, decodeRate: DECODE_RATE });
      break;
    }
    case 'options': {
      options = { ...options, ...msg.options };
      break;
    }
    case 'audio': {
      const chunk: Float32Array = msg.samples;
      const arrivedAt: number = msg.time ?? Date.now();
      const resampled = resampler ? resampler.process(chunk) : chunk;
      if (!originInitialised) {
        // The chunk we just received ends "now" (minus a small buffer latency)
        timeOrigin = arrivedAt - (resampled.length / DECODE_RATE) * 1000;
        originInitialised = true;
      }
      pushSamples(resampled);
      metricAccum.push(resampled);

      const now = Date.now();
      if (now - lastMetric > 200) {
        lastMetric = now;
        const total = metricAccum.reduce((a, b) => a + b.length, 0);
        const merged = new Float32Array(total);
        let off = 0;
        for (const part of metricAccum) {
          merged.set(part, off);
          off += part.length;
        }
        metricAccum = [];
        // gentle clock correction so slot boundaries stay aligned with UTC
        const expectedEnd = timeOrigin + (totalSamples / DECODE_RATE) * 1000;
        const drift = now - expectedEnd;
        if (Math.abs(drift) > 400) timeOrigin += drift * 0.5;
        else timeOrigin += drift * 0.02;
        self.postMessage({ type: 'metrics', metrics: measureStream(merged), bufferSeconds: totalSamples / DECODE_RATE });
      }
      maybeDecode();
      break;
    }
    case 'tick': {
      maybeDecode();
      break;
    }
    case 'decodeNow': {
      // Manual "decode this window now" (used by waterfall click / retry)
      const mode: ModeId = msg.mode;
      const len = slotMs(mode);
      const start = slotStart(mode, Date.now() - len);
      const samples = extract(start - 1000, start + len + 1200);
      if (samples) {
        const result = decodeSlotForMode(samples, DECODE_RATE, mode, start, {
          modes: options.modes,
          dsp: options.dsp,
          osdOrder: Math.max(options.osdOrder, 2),
          maxCandidates: options.maxCandidates * 2,
          minHz: msg.minHz ?? options.minHz,
          maxHz: msg.maxHz ?? options.maxHz,
          hashes,
        });
        for (const d of result.decodes) d.dt -= 1;
        self.postMessage({ type: 'slot', result, manual: true });
      } else {
        self.postMessage({ type: 'error', message: 'Not enough buffered audio yet', mode });
      }
      break;
    }
    case 'modes': {
      options.modes = msg.modes;
      break;
    }
  }
};

export {};
