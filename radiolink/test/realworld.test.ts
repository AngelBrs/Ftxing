/**
 * End-to-end test: build genuinely nasty radio audio (hum, clipping, AGC
 * pumping, fading, dropouts, birdies, band-limited phone microphone response,
 * multiple overlapping signals, DC offset, wrong sample rate) and push it
 * through the real slot pipeline used by the application.
 */
import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones } from '../src/protocols/ftx';
import { js8EncodeText, js8EncodeTones } from '../src/protocols/js8';
import { FT8, FT4, JS8A, MODES, type ModeId } from '../src/protocols/modes';
import { synthesize } from '../src/protocols/modem';
import { decodeSlotForMode } from '../src/engine/decodeSlot';
import { DEFAULT_DSP } from '../src/dsp/pipeline';
import { Resampler, Biquad } from '../src/dsp/filters';

const FS = 12000;

function noise(n: number, sigma: number): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0;
    let v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    o[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return o;
}

interface Impairments {
  hum?: number;
  clip?: number;
  dc?: number;
  fade?: boolean;
  dropout?: boolean;
  birdie?: number;
  phoneMic?: boolean;
  agc?: boolean;
  resampleVia?: number;
}

function buildSlot(
  mode: ModeId,
  messages: { text: string; freq: number; snr: number; dt: number }[],
  imp: Impairments,
): Float32Array {
  const spec = MODES[mode];
  const total = Math.round(spec.slotSeconds * FS);
  const buf = new Float32Array(total);
  const worstSnr = messages.length ? Math.min(...messages.map((m) => m.snr)) : -10;
  const sigma = Math.sqrt((0.5 / Math.pow(10, worstSnr / 10)) * (FS / 2) / 2500);
  buf.set(noise(total, sigma));

  for (const m of messages) {
    let sig: Float32Array;
    if (spec.family === 'JS8') {
      const { frames } = js8EncodeText(m.text);
      sig = synthesize(js8EncodeTones(frames[0], spec), spec, { sampleRate: FS, baseFrequency: m.freq, amplitude: 1 });
    } else {
      const h = new CallsignHashTable();
      const p = pack77(m.text, h)!;
      sig = synthesize(ftxEncodeTones(p.bits, spec), spec, { sampleRate: FS, baseFrequency: m.freq, amplitude: 1 });
    }
    const amp = Math.pow(10, (m.snr - worstSnr) / 20);
    const off = Math.round(m.dt * FS);
    for (let i = 0; i < sig.length; i++) {
      const j = off + i;
      if (j < 0 || j >= total) continue;
      let a = amp;
      if (imp.fade) a *= 0.3 + 0.7 * Math.abs(Math.sin((2 * Math.PI * i) / (FS * 4.5)));
      if (imp.dropout && i > sig.length * 0.42 && i < sig.length * 0.5) a = 0;
      buf[j] += sig[i] * a;
    }
  }

  if (imp.hum) for (let i = 0; i < total; i++) {
    buf[i] += imp.hum * (Math.sin((2 * Math.PI * 50 * i) / FS) + 0.6 * Math.sin((2 * Math.PI * 150 * i) / FS) + 0.35 * Math.sin((2 * Math.PI * 300 * i) / FS));
  }
  if (imp.birdie) for (let i = 0; i < total; i++) buf[i] += imp.birdie * Math.sin((2 * Math.PI * 2100 * i) / FS);
  if (imp.dc) for (let i = 0; i < total; i++) buf[i] += imp.dc;

  if (imp.agc) {
    // slow gain pumping of +/- 9 dB
    for (let i = 0; i < total; i++) buf[i] *= Math.pow(10, (9 * Math.sin((2 * Math.PI * i) / (FS * 6))) / 20);
  }
  if (imp.phoneMic) {
    Biquad.highpass(FS, 320, 0.7).processInPlace(buf);
    Biquad.lowpass(FS, 2600, 0.7).processInPlace(buf);
  }
  // A real sound card delivers samples inside +/-1; normalize like an input stage.
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak > 0) for (let i = 0; i < total; i++) buf[i] = (buf[i] / peak) * 0.6;

  if (imp.clip) {
    const lim = imp.clip;
    for (let i = 0; i < total; i++) buf[i] = Math.max(-lim, Math.min(lim, buf[i]));
  }
  if (imp.resampleVia) {
    const up = new Resampler(FS, imp.resampleVia).process(buf);
    const back = new Resampler(imp.resampleVia, FS).process(up);
    const out = new Float32Array(total);
    out.set(back.subarray(0, Math.min(total, back.length)));
    return out;
  }
  return buf;
}

function run(name: string, mode: ModeId, messages: { text: string; freq: number; snr: number; dt: number }[], imp: Impairments) {
  const audio = buildSlot(mode, messages, imp);
  const result = decodeSlotForMode(audio, FS, mode, Date.now(), {
    modes: [mode],
    dsp: DEFAULT_DSP,
    osdOrder: 1,
    maxCandidates: 30,
    minHz: 200,
    maxHz: 3000,
    hashes: new CallsignHashTable(),
  });
  const wanted = messages.map((m) => m.text.toUpperCase());
  const got = result.decodes.map((d) => d.text.toUpperCase());
  const hit = wanted.filter((w) => got.some((g) => g.includes(w.split(':')[0]) || w.includes(g)));
  const status = hit.length === wanted.length ? 'PASS' : hit.length ? 'PART' : 'FAIL';
  console.log(
    `${status} ${name.padEnd(34)} ${hit.length}/${wanted.length} decoded  [${result.decodes
      .map((d) => `${d.text} ${d.snr.toFixed(0)}dB ${d.frequency.toFixed(0)}Hz ${(d.confidence * 100).toFixed(0)}%`)
      .join(' | ')}]`,
  );
  for (const d of result.diagnostics) console.log(`      · ${d}`);
  return status;
}

const results: string[] = [];
results.push(run('clean FT8', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -10, dt: 0.5 }], {}));
results.push(run('heavy mains hum', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -10, dt: 0.5 }], { hum: 0.25 }));
results.push(run('clipped + DC offset', 'FT8', [{ text: 'SV1ABC DL2XYZ -11', freq: 1200, snr: -8, dt: 0.6 }], { clip: 0.25, dc: 0.08 }));
results.push(run('fading + AGC pumping', 'FT8', [{ text: 'DL2XYZ SV1ABC RR73', freq: 1800, snr: -6, dt: 0.5 }], { fade: true, agc: true }));
results.push(run('dropout mid-frame', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 900, snr: -3, dt: 0.5 }], { dropout: true }));
results.push(run('phone mic + birdie', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -8, dt: 0.5 }], { phoneMic: true, birdie: 0.2 }));
results.push(run('48k resample round trip', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -10, dt: 0.5 }], { resampleVia: 48000 }));
results.push(
  run(
    'three overlapping signals',
    'FT8',
    [
      { text: 'CQ SV1ABC KM17', freq: 700, snr: -6, dt: 0.5 },
      { text: 'SV1ABC DL2XYZ -11', freq: 1500, snr: -10, dt: 0.55 },
      { text: 'DL2XYZ SV1ABC RR73', freq: 2300, snr: -14, dt: 0.45 },
    ],
    { hum: 0.1, agc: true },
  ),
);
results.push(run('FT4 with hum + clipping', 'FT4', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -8, dt: 0.5 }], { hum: 0.2, clip: 0.3 }));
results.push(run('JS8 free text, fading', 'JS8A', [{ text: 'HELLO FROM GREECE', freq: 1200, snr: -10, dt: 0.5 }], { fade: true, hum: 0.15 }));
results.push(run('noise only (no signal)', 'FT8', [], {}));
results.push(run('big timing error (+2.0 s)', 'FT8', [{ text: 'CQ SV1ABC KM17', freq: 1500, snr: -8, dt: 2.0 }], {}));

const pass = results.filter((r) => r === 'PASS').length;
console.log(`\n${pass}/${results.length} scenarios fully decoded (the "noise only" case passes by design when nothing decodes)`);
