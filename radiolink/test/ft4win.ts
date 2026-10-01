import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ftxDecodeCandidate } from '../src/protocols/ftx';
import { FT4 } from '../src/protocols/modes';
import { SymbolSpectra, findCandidates, synthesize } from '../src/protocols/modem';
const FS=12000;
function noise(n:number,s:number){const o=new Float32Array(n);for(let i=0;i<n;i++){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();o[i]=s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}return o;}
function slot(spec:any,snr:number,freq:number,dt:number){const h=new CallsignHashTable();const p=pack77('CQ SV1ABC KM17',h)!;
 const sig=synthesize(ftxEncodeTones(p.bits,spec),spec,{sampleRate:FS,baseFrequency:freq,amplitude:1});
 const total=Math.round(spec.slotSeconds*FS);const buf=new Float32Array(total);
 const sigma=Math.sqrt((0.5/Math.pow(10,snr/10))*(FS/2)/2500);buf.set(noise(total,sigma));
 const off=Math.round(dt*FS);for(let i=0;i<sig.length;i++)if(off+i<total)buf[off+i]+=sig[i];return buf;}
for (const mult of [1.0,1.2,1.4,1.6,1.8]) {
  const res:string[]=[];
  for (const snr of [-12,-14,-16,-17]) {
    let ok=0;const N=10;
    for(let t=0;t<N;t++){
      const buf=slot(FT4,snr,1000+Math.random()*800,0.3+Math.random()*0.3);
      const sp=new SymbolSpectra(buf,FS,FT4,4000,mult);
      const cands=findCandidates(sp,FT4,{minDt:-0.5,maxDt:2.0,maxCandidates:20});
      const h=new CallsignHashTable();
      for(const c of cands){if(ftxDecodeCandidate(sp,FT4,c,h,1)){ok++;break;}}
    }
    res.push(`${snr}:${ok}/10`);
  }
  console.log('FT4 winMult',mult,res.join(' '));
}
