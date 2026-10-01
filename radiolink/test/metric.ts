import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ldpc91 } from '../src/protocols/ftx';
import { FT8 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize, TIME_OSR, FREQ_OSR } from '../src/protocols/modem';
import { crc14 } from '../src/protocols/crc';
import { readBits } from '../src/protocols/bits';

const FS = 12000, spec = FT8;
function noise(n: number, s: number) { const o = new Float32Array(n); for (let i=0;i<n;i++){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();o[i]=s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);} return o; }
function slot(snr: number, freq: number, dt: number) {
  const h = new CallsignHashTable(); const p = pack77('CQ SV1ABC KM17', h)!;
  const sig = synthesize(ftxEncodeTones(p.bits, spec), spec, { sampleRate: FS, baseFrequency: freq, amplitude: 1 });
  const total = 15 * FS; const buf = new Float32Array(total);
  const sigma = Math.sqrt((0.5 / Math.pow(10, snr/10)) * (FS/2) / 2500);
  buf.set(noise(total, sigma));
  const off = Math.round(dt*FS);
  for (let i=0;i<sig.length;i++) if (off+i<total) buf[off+i]+=sig[i];
  return buf;
}
type Metric = 'db' | 'lin' | 'amp';
function llrFor(sp: SymbolSpectra, cand: any, metric: Metric) {
  const llr = new Float32Array(174);
  const toneBits = spec.gray!.map((t,i)=>[t,i] as const).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
  let bit = 0; const mags = new Float32Array(8);
  for (const symIdx of spec.dataSymbols) {
    const block = cand.timeBlock + symIdx*TIME_OSR;
    for (let t=0;t<8;t++) { const db = sp.at(block, cand.freqBin + t*FREQ_OSR);
      mags[t] = metric==='db' ? db : metric==='lin' ? Math.pow(10, db/10) : Math.pow(10, db/20); }
    if (metric!=='db') { let mx=0; for(let t=0;t<8;t++) mx=Math.max(mx,mags[t]); for(let t=0;t<8;t++) mags[t]/= (mx||1); }
    for (let b=0;b<3;b++) { const mask = 1<<(2-b); let m0=-1e9,m1=-1e9;
      for (let t=0;t<8;t++){ const v=mags[t]; if (toneBits[t]&mask){ if(v>m1)m1=v; } else if (v>m0) m0=v; }
      llr[bit++]=m0-m1; }
  }
  let s=0,s2=0; for(let i=0;i<174;i++){s+=llr[i];s2+=llr[i]*llr[i];}
  const mean=s/174, va=Math.max(1e-9,s2/174-mean*mean), k=2.83/Math.sqrt(va);
  for(let i=0;i<174;i++) llr[i]*=k;
  return llr;
}
for (const metric of ['db','lin','amp'] as Metric[]) {
  const res: string[] = [];
  for (const snr of [-14,-16,-18,-20]) {
    let ok=0; const N=12;
    for (let trial=0;trial<N;trial++) {
      const buf = slot(snr, 1000+Math.random()*1000, 0.3+Math.random()*0.4);
      const sp = new SymbolSpectra(buf, FS, spec);
      const cands = findCandidates(sp, spec, { minDt: 0, maxDt: 2.5, maxCandidates: 20 });
      let good=false;
      for (const c of cands) {
        const {bits,errors} = ldpc91().decode(llrFor(sp,c,metric), 45);
        if (errors===0 && crc14(bits.slice(0,77))===readBits(bits,77,14)) { good=true; break; }
      }
      if (good) ok++;
    }
    res.push(`${snr}dB:${ok}/12`);
  }
  console.log(metric.padEnd(4), res.join('  '));
}
