import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ftxDecodeCandidate } from '../src/protocols/ftx';
import { FT8, FT4, FT2 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize } from '../src/protocols/modem';
import { writeWav } from './wav';

const FS = 12000;

function noise(n: number, sigma: number) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    out[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}

function buildSlot(spec: typeof FT8, text: string, freq: number, snrDb: number, dt: number) {
  const h = new CallsignHashTable();
  const p = pack77(text, h)!;
  const tones = ftxEncodeTones(p.bits, spec);
  const sig = synthesize(tones, spec, { sampleRate: FS, baseFrequency: freq, amplitude: 1 });
  const total = Math.round(spec.slotSeconds * FS);
  const buf = new Float32Array(total);
  // noise with SNR referenced to 2500 Hz bandwidth
  const bw = 2500;
  const sigPow = 0.5;                      // amplitude 1 sine
  const noisePow = sigPow / Math.pow(10, snrDb / 10);  // in 2500 Hz
  const sigma = Math.sqrt((noisePow * (FS / 2)) / bw);
  buf.set(noise(total, sigma));
  const off = Math.round(dt * FS);
  for (let i = 0; i < sig.length; i++) if (off + i >= 0 && off + i < total) buf[off + i] += sig[i];
  return buf;
}

function tryDecode(spec: typeof FT8, buf: Float32Array) {
  const sp = new SymbolSpectra(buf, FS, spec);
  const cands = findCandidates(sp, spec, { minDt: 0, maxDt: 2.5, maxCandidates: 30 });
  const h = new CallsignHashTable();
  const out: string[] = [];
  for (const c of cands) {
    const d = ftxDecodeCandidate(sp, spec, c, h);
    if (d) out.push(`${d.text} | ${d.frequency.toFixed(1)} Hz | ${d.snr.toFixed(0)} dB | dt ${d.dt.toFixed(2)}`);
  }
  return out;
}

for (const [spec, name] of [[FT8, 'FT8'], [FT4, 'FT4'], [FT2, 'FT2']] as const) {
  for (const snr of [10, 0, -10, -15, -18, -20, -22]) {
    const buf = buildSlot(spec as any, 'CQ SV1ABC KM17', 1500, snr, 0.5);
    const res = tryDecode(spec as any, buf);
    console.log(`${name} snr=${String(snr).padStart(4)} ->`, res.length ? res[0] : 'no decode');
  }
}

// multi-signal test
{
  const a = buildSlot(FT8, 'CQ SV1ABC KM17', 800, -5, 0.5);
  const b = buildSlot(FT8, 'SV1ABC DL2XYZ -11', 1700, -12, 0.7);
  const mix = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) mix[i] = a[i] + b[i];
  console.log('FT8 two signals ->', tryDecode(FT8, mix));
  writeWav('/tmp/ts_ft8.wav', mix, FS);
}
