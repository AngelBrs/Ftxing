import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones, ldpc91 } from '../src/protocols/ftx';
import { FT8 } from '../src/protocols/modes';
import { synthesize } from '../src/protocols/modem';
import { fftAny, hann } from '../src/dsp/fft';
import { crc14 } from '../src/protocols/crc';
import { readBits } from '../src/protocols/bits';
const FS=12000, spec=FT8, TIME_OSR=2, FREQ_OSR=2;
function noise(n:number,s:number){const o=new Float32Array(n);for(let i=0;i<n;i++){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();o[i]=s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}return o;}
function slot(snr:number,freq:number,dt:number){const h=new CallsignHashTable();const p=pack77('CQ SV1ABC KM17',h)!;
 const sig=synthesize(ftxEncodeTones(p.bits,spec),spec,{sampleRate:FS,baseFrequency:freq,amplitude:1});
 const total=15*FS;const buf=new Float32Array(total);
 const sigma=Math.sqrt((0.5/Math.pow(10,snr/10))*(FS/2)/2500);buf.set(noise(total,sigma));
 const off=Math.round(dt*FS);for(let i=0;i<sig.length;i++)if(off+i<total)buf[off+i]+=sig[i];return buf;}

function spectra(buf:Float32Array, winLenMult:number){
  const nsps=Math.round(FS*spec.symbolPeriod), nfft=nsps*FREQ_OSR, hop=nsps/TIME_OSR;
  const L=Math.round(nsps*winLenMult); const w=hann(L);
  const nBins=nfft/2, nBlocks=Math.floor((buf.length-Math.max(L,nfft))/hop)+1;
  const mag=new Float32Array(nBlocks*nBins); const re=new Float32Array(nfft), im=new Float32Array(nfft);
  for(let b=0;b<nBlocks;b++){re.fill(0);im.fill(0);const off=b*hop;
    for(let i=0;i<L;i++) re[i]=buf[off+i]*w[i];
    fftAny(re,im);
    for(let k=0;k<nBins;k++) mag[b*nBins+k]=10*Math.log10(re[k]*re[k]+im[k]*im[k]+1e-20);}
  return {mag,nBins,nBlocks,binHz:FS/nfft,blockSeconds:hop/FS};
}
function at(sp:any,b:number,k:number){return (b<0||b>=sp.nBlocks||k<0||k>=sp.nBins)?-200:sp.mag[b*sp.nBins+k];}
function sync(sp:any,t:number,f:number){let s=0,n=0;for(const g of spec.syncGroups)for(let k=0;k<7;k++){const bl=t+(g.pos+k)*TIME_OSR;let sum=0;for(let tone=0;tone<8;tone++)sum+=at(sp,bl,f+tone*FREQ_OSR);s+=at(sp,bl,f+g.tones[k]*FREQ_OSR)-sum/8;n++;}return s/n;}
function llr(sp:any,t:number,f:number){const toneBits=spec.gray!.map((tn,i)=>[tn,i] as const).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
 const out=new Float32Array(174);let bit=0;const m=new Float32Array(8);
 for(const symIdx of spec.dataSymbols){const bl=t+symIdx*TIME_OSR;for(let tone=0;tone<8;tone++)m[tone]=at(sp,bl,f+tone*FREQ_OSR);
  for(let b=0;b<3;b++){const mask=1<<(2-b);let m0=-1e9,m1=-1e9;for(let tone=0;tone<8;tone++){const v=m[tone];if(toneBits[tone]&mask){if(v>m1)m1=v;}else if(v>m0)m0=v;}out[bit++]=m0-m1;}}
 return out;}
for (const mult of [1.0, 1.4, 1.8, 2.0]) {
  const res:string[]=[];
  for (const snr of [-14,-16,-18,-20]) {
    let ok=0;const N=10;
    for(let tr=0;tr<N;tr++){
      const freq=1500, dt=0.48; const buf=slot(snr,freq,dt); const sp=spectra(buf,mult);
      const tb=Math.round(dt/sp.blockSeconds), fb=Math.round(freq/sp.binHz);
      // small local search
      let done=false;
      for(let dtb=-1;dtb<=1&&!done;dtb++)for(let dfb=-1;dfb<=1&&!done;dfb++){
        const r=ldpc91().decode(llr(sp,tb+dtb,fb+dfb),45);
        if(r.errors===0&&crc14(r.bits.slice(0,77))===readBits(r.bits,77,14))done=true;}
      if(done)ok++;
    }
    res.push(`${snr}:${ok}/10`);
  }
  console.log('winMult',mult,res.join('  '));
}
