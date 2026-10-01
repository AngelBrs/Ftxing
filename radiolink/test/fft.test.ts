import { fftAny } from '../src/dsp/fft';
const n = 1152;
const re = new Float32Array(n), im = new Float32Array(n);
for (let i=0;i<n;i++){ re[i]=Math.sin(2*Math.PI*17*i/n)+0.3*Math.cos(2*Math.PI*100*i/n); im[i]=0.1*Math.sin(2*Math.PI*5*i/n); }
const r0=re.slice(), i0=im.slice();
fftAny(re,im);
let maxErr=0;
for (const k of [0,1,5,17,100,511,1151]) {
  let sr=0, si=0;
  for (let j=0;j<n;j++){ const a=-2*Math.PI*j*k/n; sr += r0[j]*Math.cos(a)-i0[j]*Math.sin(a); si += r0[j]*Math.sin(a)+i0[j]*Math.cos(a); }
  maxErr = Math.max(maxErr, Math.abs(sr-re[k]), Math.abs(si-im[k]));
}
console.log('max abs error', maxErr.toFixed(5), maxErr < 0.05 ? 'PASS' : 'FAIL');
