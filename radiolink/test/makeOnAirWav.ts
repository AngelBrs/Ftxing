import { CallsignHashTable, pack77 } from '../src/protocols/message77';
import { ftxEncodeTones } from '../src/protocols/ftx';
import { FT8 } from '../src/protocols/modes';
import { synthesize } from '../src/protocols/modem';
import { writeWav } from './wav';

const FS = 48000;
const SLOTS = 8;
const out = new Float32Array(FS * 15 * SLOTS);
const msgs = ['CQ SV1ABC KM17', 'SV1ABC DL2XYZ -11', 'DL2XYZ SV1ABC R-09'];
const h = new CallsignHashTable();
// light band noise so the display and noise-floor estimate look realistic
for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * 0.02;
for (let s = 0; s < SLOTS; s++) {
  const text = msgs[s % msgs.length];
  const bits = pack77(text, h)!.bits;
  for (const [freq, amp] of [[1200, 0.25], [1875, 0.12]] as [number, number][]) {
    const sig = synthesize(ftxEncodeTones(bits, FT8), FT8, { sampleRate: FS, baseFrequency: freq, amplitude: amp });
    const off = Math.round((s * 15 + 0.5) * FS);
    for (let i = 0; i < sig.length; i++) out[off + i] += sig[i];
  }
}
writeWav('/tmp/onair.wav', out, FS);
console.log('wrote /tmp/onair.wav', (out.length / FS).toFixed(1), 's');
