/**
 * Slot decoding engine: DSP -> per-mode sync detection -> decoding ->
 * diagnostics. Runs inside a Web Worker (or Node, for the test suite).
 */
import { processSlot, type DspReport, type DspSettings } from '../dsp/pipeline';
import { CallsignHashTable } from '../protocols/message77';
import { ftxDecodeCandidate } from '../protocols/ftx';
import { js8DecodeCandidate } from '../protocols/js8';
import { MODES, type ModeId, type ModeSpec, bandwidth, frameSeconds } from '../protocols/modes';
import { SymbolSpectra, findCandidates, type Candidate } from '../protocols/modem';

export interface DecodedMessage {
  id: string;
  /** Wall-clock time of the start of the slot, ms. */
  timeMs: number;
  mode: ModeId;
  frequency: number;
  snr: number;
  dt: number;
  text: string;
  messageType: string;
  confidence: number;
  toneMatch: number;
  /** Repeat counter when the same message is heard again. */
  repeats: number;
  callTo?: string;
  callDe?: string;
}

export interface ModeDetection {
  mode: ModeId;
  /** Best Costas sync score found in the slot (dB). */
  syncScore: number;
  /** 0..1 confidence that this mode is present. */
  confidence: number;
  bestFrequency: number;
  decodes: number;
  /** Set when this sighting is really another mode's signal that did decode. */
  explainedBy?: ModeId;
}

export interface SignalSighting {
  frequency: number;
  snr: number;
  mode: ModeId;
  decoded: boolean;
  bandwidth: number;
}

export interface SlotResult {
  mode: ModeId;
  slotStartMs: number;
  decodes: DecodedMessage[];
  detections: ModeDetection[];
  signals: SignalSighting[];
  report: DspReport;
  diagnostics: string[];
  elapsedMs: number;
}

export interface DecodeOptions {
  modes: ModeId[];
  dsp: DspSettings;
  osdOrder: number;
  maxCandidates: number;
  minHz: number;
  maxHz: number;
  /** Shared hash table so <...> callsigns resolve over time. */
  hashes: CallsignHashTable;
}

function confidenceFromScore(score: number): number {
  // Empirical mapping from Costas sync score (dB above the symbol average)
  // to a presence probability. ~1 dB is noise, >6 dB is a solid signal.
  return Math.max(0, Math.min(0.9, (score - 5.0) / 6));
}

function decodeConfidence(toneMatch: number, snr: number): number {
  // CRC-14 + re-encode verification make false decodes very unlikely; the
  // remaining uncertainty is mostly "is this really what was sent".
  const base = 0.9 + 0.09 * Math.min(1, Math.max(0, (toneMatch - 0.3) / 0.6));
  const weak = snr < -20 ? 0.03 : 0;
  return Math.min(0.999, base - weak);
}

/** Analyse one slot of audio for one mode. */
export function decodeSlotForMode(
  samples: Float32Array,
  sampleRate: number,
  modeId: ModeId,
  slotStartMs: number,
  opts: DecodeOptions,
  processed?: { audio: Float32Array; report: DspReport },
): SlotResult {
  const started = Date.now();
  const spec: ModeSpec = MODES[modeId];
  const { audio, report } = processed ?? processSlot(samples, sampleRate, opts.dsp);

  const sp = new SymbolSpectra(audio, sampleRate, spec, Math.min(4000, opts.maxHz + 500));
  const cands = findCandidates(sp, spec, {
    minHz: opts.minHz,
    maxHz: opts.maxHz,
    minDt: -1.2,
    maxDt: 2.6,
    maxCandidates: opts.maxCandidates,
  });

  const decodes: DecodedMessage[] = [];
  const signals: SignalSighting[] = [];
  const decodedFreqs: number[] = [];

  for (const cand of cands) {
    const already = decodedFreqs.some((f) => Math.abs(f - cand.frequency) < bandwidth(spec) * 0.5);
    if (already) continue;
    if (spec.family === 'JS8') {
      const d = js8DecodeCandidate(sp, spec, cand, opts.osdOrder);
      if (d) {
        decodedFreqs.push(d.frequency);
        decodes.push({
          id: `${slotStartMs}-${modeId}-${d.frequency.toFixed(0)}`,
          timeMs: slotStartMs,
          mode: modeId,
          frequency: d.frequency,
          snr: d.snr,
          dt: d.dt,
          text: d.text,
          messageType: d.frameType,
          confidence: decodeConfidence(d.toneMatch, d.snr),
          toneMatch: d.toneMatch,
          repeats: 1,
        });
      }
    } else {
      const d = ftxDecodeCandidate(sp, spec, cand, opts.hashes, opts.osdOrder);
      if (d) {
        decodedFreqs.push(d.frequency);
        const parts = d.text.split(' ');
        decodes.push({
          id: `${slotStartMs}-${modeId}-${d.frequency.toFixed(0)}`,
          timeMs: slotStartMs,
          mode: modeId,
          frequency: d.frequency,
          snr: d.snr,
          dt: d.dt,
          text: d.text,
          messageType: d.messageType,
          confidence: decodeConfidence(d.toneMatch, d.snr),
          toneMatch: d.toneMatch,
          repeats: 1,
          callTo: parts[0],
          callDe: parts[1],
        });
      }
    }
  }

  // Signal sightings (decoded or not) for the waterfall overlay
  for (const c of cands.slice(0, 12)) {
    if (c.score < 1.2) continue;
    const decoded = decodedFreqs.some((f) => Math.abs(f - c.frequency) < bandwidth(spec) * 0.5);
    signals.push({
      frequency: c.frequency,
      snr: estimateCandidateSnr(sp, spec, c),
      mode: modeId,
      decoded,
      bandwidth: bandwidth(spec),
    });
  }

  const best = cands[0];
  const detection: ModeDetection = {
    mode: modeId,
    syncScore: best?.score ?? 0,
    confidence: decodes.length ? 0.99 : confidenceFromScore(best?.score ?? 0),
    bestFrequency: best?.frequency ?? 0,
    decodes: decodes.length,
  };

  const diagnostics = buildDiagnostics(report, detection, decodes.length, spec, cands, sp);

  return {
    mode: modeId,
    slotStartMs,
    decodes,
    detections: [detection],
    signals,
    report,
    diagnostics,
    elapsedMs: Date.now() - started,
  };
}

function estimateCandidateSnr(sp: SymbolSpectra, spec: ModeSpec, cand: Candidate): number {
  // reuse the decoder's SNR estimator shape without requiring a decode
  let peak = -200;
  for (const g of spec.syncGroups) {
    for (let k = 0; k < g.tones.length; k++) {
      const block = cand.timeBlock + (g.pos + k) * 2;
      peak = Math.max(peak, sp.at(block, cand.freqBin + g.tones[k] * 2));
    }
  }
  const noiseRef = sp.noiseDb + 10 * Math.log10(2500 / (1 / spec.symbolPeriod));
  return Math.max(-35, Math.min(45, peak - noiseRef - 4.5));
}

function buildDiagnostics(
  report: DspReport,
  detection: ModeDetection,
  decodeCount: number,
  spec: ModeSpec,
  cands: Candidate[],
  sp: SymbolSpectra,
): string[] {
  const out: string[] = [];
  if (report.clipPercent > 1) out.push(`RX input appears clipped (${report.clipPercent.toFixed(1)}% of samples at full scale) — reduce audio level`);
  else if (report.clipPercent > 0.05) out.push(`Slight clipping detected (${report.clipPercent.toFixed(2)}%)`);
  if (report.tooQuiet) out.push(`RX audio is too quiet (${report.levelDb.toFixed(0)} dBFS) — raise the radio volume or input gain`);
  if (report.dropoutPercent > 5) out.push(`Possible audio dropout: ${report.dropoutPercent.toFixed(0)}% of the slot was silent`);
  if (report.humNotches.length) out.push(`Mains hum suppressed at ${report.humNotches.slice(0, 4).map((f) => `${f} Hz`).join(', ')}`);
  if (report.carrierNotches.length) out.push(`Steady carrier (birdie) notched at ${report.carrierNotches.slice(0, 3).map((f) => `${f.toFixed(0)} Hz`).join(', ')}`);
  if (report.fadingDb > 6) out.push(`Signal fading detected (${report.fadingDb.toFixed(1)} dB envelope variation) — retrying across the fade`);
  if (Math.abs(report.tiltDb) > 12) out.push(`Uneven audio response (${report.tiltDb > 0 ? 'treble' : 'bass'} heavy, ${Math.abs(report.tiltDb).toFixed(0)} dB tilt)`);
  if (report.dcOffset > 0.02) out.push(`DC offset removed (${(report.dcOffset * 100).toFixed(1)}% of full scale)`);

  if (decodeCount === 0) {
    if (detection.syncScore > 6.5) {
      const dtDrift = cands[0] ? cands[0].dt : 0;
      out.push(
        `${spec.label} signal detected at ${detection.bestFrequency.toFixed(0)} Hz but synchronization/decoding failed` +
          (Math.abs(dtDrift) > 1.2 ? ` — timing is off by ${dtDrift.toFixed(1)} s, check the computer clock` : ''),
      );
    } else if (detection.syncScore > 5.0) {
      out.push(
        `Possible weak ${spec.label} signal near ${detection.bestFrequency.toFixed(0)} Hz — estimated SNR ${estimateCandidateSnr(sp, spec, cands[0]).toFixed(0)} dB, below the decode threshold`,
      );
    } else if (!report.tooQuiet && report.snrDb < 6) {
      out.push(`No digital signals found — band appears to be just noise (peak ${report.snrDb.toFixed(0)} dB above floor)`);
    }
  }
  return out;
}

/** How long a mode's slot is, in ms. */
export function slotMs(mode: ModeId): number {
  return MODES[mode].slotSeconds * 1000;
}

/** Start time (ms since epoch) of the slot that contains `timeMs`. */
export function slotStart(mode: ModeId, timeMs: number): number {
  const len = slotMs(mode);
  return Math.floor(timeMs / len) * len;
}

export function transmitWindowMs(mode: ModeId): number {
  return frameSeconds(MODES[mode]) * 1000;
}
