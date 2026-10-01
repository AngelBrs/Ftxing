import { execFileSync } from 'child_process';
import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ftxDecodeCandidate } from '../src/protocols/ftx';
import { FT8, FT4 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize } from '../src/protocols/modem';
import { writeWav, readWav } from './wav';

const FS = 12000;
const REF = '/tmp/ft8_lib';

function decodeTs(spec: any, samples: Float32Array, rate: number) {
  const sp = new SymbolSpectra(samples, rate, spec);
  const cands = findCandidates(sp, spec, { minDt: -1, maxDt: 3, maxCandidates: 40 });
  const h = new CallsignHashTable();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cands) {
    const d = ftxDecodeCandidate(sp, spec, c, h, 1);
    if (d && !seen.has(d.text)) { seen.add(d.text); out.push(`${d.text} @ ${d.frequency.toFixed(0)}Hz ${d.snr.toFixed(0)}dB dt=${d.dt.toFixed(2)}`); }
  }
  return out;
}

const msgs = ['CQ SV1ABC KM17', 'SV1ABC DL2XYZ -11', 'DL2XYZ SV1ABC RR73', 'HELLO GREECE'];

console.log('=== 1. ft8_lib encodes -> our decoder reads ===');
for (const m of msgs) {
  execFileSync(`${REF}/gen_ft8`, [m, '/tmp/ref.wav', '1500'], { cwd: REF });
  const { samples, rate } = readWav('/tmp/ref.wav');
  console.log(`  ref wav "${m}" ->`, decodeTs(FT8, samples, rate));
}

console.log('=== 2. our encoder -> ft8_lib decoder reads ===');
for (const m of msgs) {
  const h = new CallsignHashTable();
  const p = pack77(m, h)!;
  const tones = ftxEncodeTones(p.bits, FT8);
  const sig = synthesize(tones, FT8, { sampleRate: FS, baseFrequency: 1237, amplitude: 0.5 });
  const buf = new Float32Array(15 * FS);
  const off = Math.round(0.5 * FS);
  buf.set(sig, off);
  writeWav('/tmp/ours.wav', buf, FS);
  const out = execFileSync(`${REF}/decode_ft8`, ['/tmp/ours.wav'], { cwd: REF }).toString().trim();
  console.log(`  ours "${m}" -> ft8_lib:`, out.split('\n').filter(Boolean).join(' | '));
}

console.log('=== 3. FT4 round trip through ft8_lib ===');
for (const m of ['CQ SV1ABC KM17', 'SV1ABC DL2XYZ R-08']) {
  const h = new CallsignHashTable();
  const p = pack77(m, h)!;
  const sig = synthesize(ftxEncodeTones(p.bits, FT4), FT4, { sampleRate: FS, baseFrequency: 1500, amplitude: 0.5 });
  const buf = new Float32Array(Math.round(7.5 * FS));
  buf.set(sig, Math.round(0.5 * FS));
  writeWav('/tmp/ours4.wav', buf, FS);
  const out = execFileSync(`${REF}/decode_ft8`, ['-ft4', '/tmp/ours4.wav'], { cwd: REF }).toString().trim();
  console.log(`  ours FT4 "${m}" -> ft8_lib:`, out.split('\n').filter(Boolean).join(' | '));
}
