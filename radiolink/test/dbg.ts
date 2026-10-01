import { CallsignHashTable } from '/home/user/radiolink/src/protocols/message77';
import { ftxDecodeCandidate } from '/home/user/radiolink/src/protocols/ftx';
import { FT8 } from '/home/user/radiolink/src/protocols/modes';
import { SymbolSpectra, findCandidates } from '/home/user/radiolink/src/protocols/modem';
import { readWav } from '/home/user/radiolink/test/wav';
import { execFileSync } from 'child_process';
execFileSync('/tmp/ft8_lib/gen_ft8', ['CQ SV1ABC KM17', '/tmp/ref.wav', '1500']);
const { samples, rate } = readWav('/tmp/ref.wav');
const sp = new SymbolSpectra(samples, rate, FT8);
const cands = findCandidates(sp, FT8, { minDt: -1, maxDt: 3, maxCandidates: 40 });
const h = new CallsignHashTable();
for (const c of cands.slice(0, 40)) {
  const d = ftxDecodeCandidate(sp, FT8, c, h, 1);
  if (d) console.log(JSON.stringify(d.text), 'f=', d.frequency.toFixed(1), 'dt=', d.dt.toFixed(2), 'match=', d.toneMatch.toFixed(2), 'margin=', d.toneMargin.toFixed(1), 'syncScore=', c.score.toFixed(2), 'type=', d.messageType);
}
