import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ftxDecodeCandidate } from '../src/protocols/ftx';
import { FT8 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize } from '../src/protocols/modem';
const FS=12000;
for (const dt of [0.0, 0.5, 1.0, 1.5]) {
  const h=new CallsignHashTable(); const p=pack77('CQ SV1ABC KM17',h)!;
  const sig=synthesize(ftxEncodeTones(p.bits,FT8),FT8,{sampleRate:FS,baseFrequency:1500,amplitude:0.5});
  const buf=new Float32Array(15*FS); buf.set(sig, Math.round(dt*FS));
  const sp=new SymbolSpectra(buf,FS,FT8);
  const c=findCandidates(sp,FT8,{minDt:-1,maxDt:3,maxCandidates:5})[0];
  const d=ftxDecodeCandidate(sp,FT8,c,new CallsignHashTable(),1);
  console.log('true dt',dt,'reported',d?.dt.toFixed(3),'freq',d?.frequency.toFixed(1));
}
