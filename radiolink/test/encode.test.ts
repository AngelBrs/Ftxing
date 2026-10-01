import { CallsignHashTable, pack77, unpack77 } from '../src/protocols/message77';
import { ftxEncodeTones } from '../src/protocols/ftx';
import { FT8, FT4 } from '../src/protocols/modes';
import { bitsToBytes } from '../src/protocols/bits';

const cases: [string, string, string, string][] = [
  ['ft8', 'CQ SV1ABC KM17', '000000267e388b92c448', '3140652000000001157707053711205333253140652613075272712621126425767551433140652'],
  ['ft4', 'SV1ABC DL2XYZ -11', 'cfc711734492849faa08', '001323011313131302012221001302221210230330110030101203202223300013223103110321302133203220300100122032010'],
  ['ft8', 'HELLO GREECE', '039ddad018554c1fa448', '3140652007147234501513632017455326423140652665722472651662775576132711733140652'],
  ['ft8', 'SV1ABC DL2XYZ RR73', 'cfc711734492849fa4c8', '3140652427525312545333351117455424353140652370741574452123125031162063213140652'],
];

let pass = 0;
for (const [mode, text, payloadHex, toneStr] of cases) {
  const h = new CallsignHashTable();
  const p = pack77(text, h);
  if (!p) { console.log('FAIL pack', text); continue; }
  const gotPayload = Array.from(bitsToBytes(p.bits, 10)).map(b => b.toString(16).padStart(2,'0')).join('');
  const spec = mode === 'ft4' ? FT4 : FT8;
  const tones = ftxEncodeTones(p.bits, spec);
  const gotTones = Array.from(tones).join('');
  const ok = gotPayload === payloadHex && gotTones === toneStr;
  const back = unpack77(p.bits, h);
  const rt = back?.text === text.replace(/\s+/g,' ');
  console.log(ok && rt ? 'PASS' : 'FAIL', mode.toUpperCase(), JSON.stringify(text), '->', back?.text, `[${back?.type}]`);
  if (!ok) { console.log('  payload exp', payloadHex, 'got', gotPayload); console.log('  tones exp', toneStr, '\n  tones got', gotTones); }
  if (ok && rt) pass++;
}
console.log(`${pass}/${cases.length} reference vectors matched`);
