import { js8EncodeText, js8EncodeTones, js8DecodeFrame, js8DecodeCandidate, js8Info87, ldpc87 } from '../src/protocols/js8';
import { JS8A, JS8B } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize } from '../src/protocols/modem';
const FS = 12000;
function noise(n:number,s:number){const o=new Float32Array(n);for(let i=0;i<n;i++){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();o[i]=s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}return o;}

// 1. frame layer round trip
for (const text of ['HELLO FROM GREECE', 'SV1ABC: TEST 123', 'CQ CQ DE SV1ABC']) {
  const { frames } = js8EncodeText(text);
  const out = frames.map(f => js8DecodeFrame(f.bits, f.i3).text).join('');
  console.log(out === text.toUpperCase() ? 'PASS' : 'FAIL', `frames=${frames.length}`, JSON.stringify(out));
}
// 2. LDPC/CRC + modem round trip through audio at several SNRs
for (const spec of [JS8A, JS8B]) {
  for (const snr of [0, -10, -16, -18, -20]) {
    const { frames } = js8EncodeText('HELLO FROM GREECE SV1ABC');
    const tones = js8EncodeTones(frames[0], spec);
    const sig = synthesize(tones, spec, { sampleRate: FS, baseFrequency: 1200, amplitude: 1 });
    const total = Math.round(spec.slotSeconds * FS);
    const buf = new Float32Array(total);
    buf.set(noise(total, Math.sqrt((0.5 / Math.pow(10, snr / 10)) * (FS / 2) / 2500)));
    const off = Math.round(0.5 * FS);
    for (let i = 0; i < sig.length && off + i < total; i++) buf[off + i] += sig[i];
    const sp = new SymbolSpectra(buf, FS, spec);
    const cands = findCandidates(sp, spec, { minDt: 0, maxDt: 2, maxCandidates: 20 });
    let got = 'no decode';
    for (const c of cands) { const d = js8DecodeCandidate(sp, spec, c, 1); if (d) { got = `${d.text} | ${d.frequency.toFixed(0)}Hz ${d.snr.toFixed(0)}dB ${d.frameType}`; break; } }
    console.log(spec.id, 'snr', snr, '->', got);
  }
}
