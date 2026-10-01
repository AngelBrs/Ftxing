import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ldpc91 } from '../src/protocols/ftx';
import { FT8 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize, extractLlr } from '../src/protocols/modem';
import { crc14 } from '../src/protocols/crc';
import { readBits } from '../src/protocols/bits';
const FS=12000, spec=FT8;
function noise(n:number,s:number){const o=new Float32Array(n);for(let i=0;i<n;i++){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();o[i]=s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}return o;}
function slot(snr:number,freq:number,dt:number){const h=new CallsignHashTable();const p=pack77('CQ SV1ABC KM17',h)!;
 const sig=synthesize(ftxEncodeTones(p.bits,spec),spec,{sampleRate:FS,baseFrequency:freq,amplitude:1});
 const total=15*FS;const buf=new Float32Array(total);
 const sigma=Math.sqrt((0.5/Math.pow(10,snr/10))*(FS/2)/2500);buf.set(noise(total,sigma));
 const off=Math.round(dt*FS);for(let i=0;i<sig.length;i++)if(off+i<total)buf[off+i]+=sig[i];return buf;}
for (const snr of [-12,-14,-16,-18]) {
  let syncOk=0, decIdeal=0, decSearch=0; const N=10;
  for (let t=0;t<N;t++){
    const freq=1500, dt=0.48; // exactly on grid
    const buf=slot(snr,freq,dt);
    const sp=new SymbolSpectra(buf,FS,spec);
    const trueBin=Math.round(freq/sp.binHz), trueBlock=Math.round(dt/sp.blockSeconds);
    const cands=findCandidates(sp,spec,{minDt:0,maxDt:2.5,maxCandidates:20});
    const rank=cands.findIndex(c=>Math.abs(c.freqBin-trueBin)<=1&&Math.abs(c.timeBlock-trueBlock)<=1);
    if(rank>=0)syncOk++;
    const ideal={timeBlock:trueBlock,freqBin:trueBin,score:0,frequency:freq,dt};
    const r1=ldpc91().decode(extractLlr(sp,spec,ideal as any,174),45);
    if(r1.errors===0&&crc14(r1.bits.slice(0,77))===readBits(r1.bits,77,14))decIdeal++;
    for(const c of cands){const r=ldpc91().decode(extractLlr(sp,spec,c,174),45);
      if(r.errors===0&&crc14(r.bits.slice(0,77))===readBits(r.bits,77,14)){decSearch++;break;}}
  }
  console.log(`snr ${snr}: syncFound ${syncOk}/${N}  decodeIdealPos ${decIdeal}/${N}  decodeViaSearch ${decSearch}/${N}`);
}
