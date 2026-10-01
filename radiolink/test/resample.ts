import { Resampler } from '../src/dsp/filters';
const inRate = 48000, outRate = 12000, f = 1500;
const r = new Resampler(inRate, outRate);
let outAll: number[] = [];
let phase = 0;
for (let c = 0; c < 20; c++) {
  const chunk = new Float32Array(1283);
  for (let i = 0; i < chunk.length; i++) { chunk[i] = Math.sin(2*Math.PI*f*(phase++)/inRate); }
  outAll.push(...r.process(chunk));
}
const expected = Math.round(20*1283*outRate/inRate);
// measure frequency via zero crossings
let zc = 0;
for (let i = 1; i < outAll.length; i++) if (outAll[i-1] < 0 && outAll[i] >= 0) zc++;
const est = zc * outRate / outAll.length;
let rms = 0; for (const v of outAll) rms += v*v; rms = Math.sqrt(rms/outAll.length);
console.log(`samples ${outAll.length} (expect ~${expected}) freq ${est.toFixed(1)} Hz (expect ${f}) rms ${rms.toFixed(3)} (expect 0.707)`);
