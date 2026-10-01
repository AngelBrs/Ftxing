/**
 * Automatic mode selection.
 *
 * There is no universally "best" mode: each one trades sensitivity against
 * speed and message capacity. This picks a sensible default for what the
 * operator is trying to do under the conditions actually measured on the
 * air, and always explains the choice.
 */
import type { ModeId } from '../protocols/modes';
import { MODES } from '../protocols/modes';

export type Purpose = 'cq' | 'qso' | 'chat' | 'emergency';

export interface Conditions {
  /** Median SNR of recent decodes (dB), or null when nothing has decoded. */
  medianSnr: number | null;
  /** Envelope variation over a slot (dB); >6 dB means real fading. */
  fadingDb: number;
  /** Percentage of clipped samples. */
  clipPercent: number;
  /** RMS input level, dBFS. */
  levelDb: number;
  /** Decode counts per mode over the recent history. */
  activity: Partial<Record<ModeId, number>>;
  /** Whether the experimental FT2 waveform is allowed. */
  allowFt2: boolean;
}

export interface ModeChoice {
  mode: ModeId;
  reasons: string[];
  alternatives: { mode: ModeId; why: string }[];
}

export function chooseMode(purpose: Purpose, c: Conditions): ModeChoice {
  const reasons: string[] = [];
  const poorAudio = c.clipPercent > 1 || c.levelDb < -50;
  const weak = c.medianSnr !== null && c.medianSnr <= -13;
  const strong = c.medianSnr !== null && c.medianSnr >= -6;
  const fading = c.fadingDb > 6;
  const busiest = (Object.entries(c.activity) as [ModeId, number][])
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0)[0];

  let mode: ModeId;

  if (purpose === 'chat') {
    mode = strong && !fading && !poorAudio ? 'JS8B' : 'JS8A';
    reasons.push(
      mode === 'JS8A'
        ? 'Free-text conversation: JS8 Normal carries arbitrary text and is the most robust JS8 speed.'
        : 'Free-text conversation with strong, stable signals: JS8 Fast keeps the conversation flowing.',
    );
  } else if (purpose === 'emergency') {
    mode = 'JS8A';
    reasons.push('Emergency/handling traffic: JS8 Normal sends arbitrary text and is the most sensitive messaging mode available here.');
  } else if (poorAudio) {
    mode = 'FT8';
    reasons.push(
      c.clipPercent > 1
        ? `Receive audio is clipping (${c.clipPercent.toFixed(1)}%), so the most robust standard mode (FT8) is selected while you fix the level.`
        : `Receive audio is very quiet (${c.levelDb.toFixed(0)} dBFS): FT8 tolerates poor audio best.`,
    );
  } else if (weak || fading) {
    mode = 'FT8';
    reasons.push(
      weak
        ? `Recent decodes average ${c.medianSnr!.toFixed(0)} dB SNR — weak-signal conditions, so FT8 (~-21 dB threshold) is the right tool.`
        : `Signals are fading (${c.fadingDb.toFixed(1)} dB variation); FT8's longer 15 s frame averages over the fades.`,
    );
  } else if (strong && purpose === 'qso') {
    mode = 'FT4';
    reasons.push(`Strong signals (${c.medianSnr!.toFixed(0)} dB): FT4 finishes a contact in half the time.`);
  } else {
    mode = 'FT8';
    reasons.push('No strong evidence either way — FT8 is the safe default: widest activity and best sensitivity of the fast modes.');
  }

  if (busiest && busiest[0] !== mode && busiest[1] >= 3) {
    reasons.push(`Note: most recent decodes were ${MODES[busiest[0]].label} (${busiest[1]} messages), so that is where the activity is.`);
  }
  if (c.allowFt2 && strong && purpose === 'qso' && c.medianSnr !== null && c.medianSnr > 3) {
    reasons.push('FT2 (experimental) would be faster still, but it is non-standard and only decodes in this application.');
  }
  if (c.medianSnr === null) {
    reasons.push('No decodes yet, so this is based on audio quality only.');
  }

  const alternatives: { mode: ModeId; why: string }[] = ([
    { mode: 'FT8', why: 'Most sensitive standard mode, 15 s slots, universal activity.' },
    { mode: 'FT4', why: 'Twice as fast, ~5 dB less sensitive, good for strong signals and contests.' },
    { mode: 'JS8A', why: 'Free-text keyboard-to-keyboard messaging, very sensitive, 15 s slots.' },
    { mode: 'JS8B', why: 'Faster JS8 for conversation when signals allow.' },
  ] as { mode: ModeId; why: string }[]).filter((a) => a.mode !== mode);

  return { mode, reasons, alternatives };
}
