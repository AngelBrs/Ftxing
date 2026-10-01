/**
 * Mode definitions for every supported waveform.
 *
 * FT8 / FT4 parameters come from the WSJT-X reference implementation and are
 * bit-for-bit interoperable with WSJT-X, JTDX, ft8_lib, etc.
 * JS8 (A/B/C) parameters come from the JS8Call source (lib/js8/*_params.f90).
 *
 * FT2 is NOT an official WSJT-X mode. There is no published FT2 standard, so
 * this application implements a clearly-labelled experimental member of the
 * FT family (same source encoding, CRC and LDPC code as FT8, four times
 * faster). It interoperates with other copies of this application only.
 */

export type ModeId = 'FT8' | 'FT4' | 'FT2' | 'JS8A' | 'JS8B' | 'JS8C';

export interface SyncGroup {
  /** index of first symbol of this sync group */
  pos: number;
  tones: number[];
}

export interface ModeSpec {
  id: ModeId;
  label: string;
  family: 'FTX' | 'JS8';
  /** Number of FSK tones. */
  tones: number;
  bitsPerSymbol: number;
  /** Seconds per channel symbol. Tone spacing = 1 / symbolPeriod. */
  symbolPeriod: number;
  /** Length of the transmit/receive slot in seconds (T/R period). */
  slotSeconds: number;
  /** Total channel symbols per frame. */
  nSym: number;
  syncGroups: SyncGroup[];
  /** Symbol indices carrying codeword data, in transmission order. */
  dataSymbols: number[];
  /** Gray map bits->tone (null = identity, used by JS8). */
  gray: number[] | null;
  /** Gaussian smoothing BT product used for transmission. */
  bt: number;
  /** LDPC variant. */
  code: 'K91' | 'K87';
  /** Offset in seconds from the start of the slot where transmission begins. */
  startDelay: number;
  /** Length of the receive analysis window in symbol periods. */
  analysisWindow: number;
  /** True when the waveform is interoperable with mainstream software. */
  standard: boolean;
  description: string;
}

const FT8_COSTAS = [3, 1, 4, 0, 6, 5, 2];
const FT4_COSTAS = [
  [0, 1, 3, 2],
  [1, 0, 2, 3],
  [2, 3, 1, 0],
  [3, 2, 0, 1],
];
const JS8_COSTAS = [4, 2, 5, 6, 1, 3, 0];
const FT8_GRAY = [0, 1, 3, 2, 5, 6, 4, 7];
const FT4_GRAY = [0, 1, 3, 2];

function dataSymbols(nSym: number, exclude: Set<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < nSym; i++) if (!exclude.has(i)) out.push(i);
  return out;
}

function ftxLike(
  id: ModeId,
  label: string,
  symbolPeriod: number,
  slotSeconds: number,
  bt: number,
  standard: boolean,
  description: string,
): ModeSpec {
  const excl = new Set<number>();
  for (let k = 0; k < 7; k++) {
    excl.add(k);
    excl.add(36 + k);
    excl.add(72 + k);
  }
  return {
    id,
    label,
    family: 'FTX',
    tones: 8,
    bitsPerSymbol: 3,
    symbolPeriod,
    slotSeconds,
    nSym: 79,
    syncGroups: [
      { pos: 0, tones: FT8_COSTAS },
      { pos: 36, tones: FT8_COSTAS },
      { pos: 72, tones: FT8_COSTAS },
    ],
    dataSymbols: dataSymbols(79, excl),
    gray: FT8_GRAY,
    bt,
    code: 'K91',
    startDelay: 0.5,
    analysisWindow: 1.8,
    standard,
    description,
  };
}

function js8Like(id: ModeId, label: string, nsps: number, slotSeconds: number, description: string): ModeSpec {
  const excl = new Set<number>();
  for (let k = 0; k < 7; k++) {
    excl.add(k);
    excl.add(36 + k);
    excl.add(72 + k);
  }
  return {
    id,
    label,
    family: 'JS8',
    tones: 8,
    bitsPerSymbol: 3,
    symbolPeriod: nsps / 12000,
    slotSeconds,
    nSym: 79,
    syncGroups: [
      { pos: 0, tones: JS8_COSTAS },
      { pos: 36, tones: JS8_COSTAS },
      { pos: 72, tones: JS8_COSTAS },
    ],
    dataSymbols: dataSymbols(79, excl),
    gray: null, // JS8 maps codeword bits straight to tones
    bt: 2.0,
    code: 'K87',
    startDelay: 0.5,
    analysisWindow: 1.8,
    standard: true,
    description,
  };
}

export const FT8: ModeSpec = ftxLike(
  'FT8',
  'FT8',
  0.16,
  15,
  2.0,
  true,
  'Standard weak-signal mode. 15 s slots, 6.25 Hz tone spacing, ~50 Hz bandwidth. This decoder is measured at about -18.5 dB SNR (WSJT-X reaches -21 dB).',
);

export const FT4: ModeSpec = {
  ...ftxLike('FT4', 'FT4', 0.048, 7.5, 1.0, true, ''),
  tones: 4,
  bitsPerSymbol: 2,
  nSym: 105,
  syncGroups: [
    { pos: 1, tones: FT4_COSTAS[0] },
    { pos: 34, tones: FT4_COSTAS[1] },
    { pos: 67, tones: FT4_COSTAS[2] },
    { pos: 100, tones: FT4_COSTAS[3] },
  ],
  dataSymbols: dataSymbols(
    105,
    new Set<number>([
      0,
      104,
      ...[1, 2, 3, 4],
      ...[34, 35, 36, 37],
      ...[67, 68, 69, 70],
      ...[100, 101, 102, 103],
    ]),
  ),
  gray: FT4_GRAY,
  startDelay: 0.5,
  description:
    'Twice as fast as FT8 (7.5 s slots, 4-GFSK, ~90 Hz bandwidth). Measured here at about -14 dB SNR (WSJT-X reaches -17.5 dB). Less sensitive than FT8, better for quick exchanges and busy bands.',
};

export const FT2: ModeSpec = ftxLike(
  'FT2',
  'FT2 (experimental)',
  0.04,
  5,
  1.0,
  false,
  'EXPERIMENTAL, non-standard: no published FT2 specification exists. Same 77-bit source coding, CRC-14 and LDPC(174,91) as FT8, but 4x faster (25 Hz tone spacing, 3.2 s frame in a 5 s slot). Measured at about -5 dB SNR. Interoperates only with other copies of this application.',
);

export const JS8A: ModeSpec = js8Like(
  'JS8A',
  'JS8 Normal',
  1920,
  15,
  'JS8 Normal (JS8A): 15 s slots, 6.25 Hz spacing, 12.6 s frame. Free-text keyboard-to-keyboard messaging. This decoder is measured at about -18 dB SNR (JS8Call itself reaches about -24 dB).',
);
export const JS8B: ModeSpec = js8Like(
  'JS8B',
  'JS8 Fast',
  1200,
  10,
  'JS8 Fast (JS8B): 10 s slots, 10 Hz spacing. Faster conversational messaging, needs a few dB more signal than JS8 Normal.',
);
export const JS8C: ModeSpec = js8Like(
  'JS8C',
  'JS8 Turbo',
  600,
  6,
  'JS8 Turbo (JS8C): 6 s slots, 20 Hz spacing. Fastest JS8 speed, for strong local/NVIS paths.',
);

export const MODES: Record<ModeId, ModeSpec> = {
  FT8,
  FT4,
  FT2,
  JS8A,
  JS8B,
  JS8C,
};

export const ALL_MODES: ModeSpec[] = [FT8, FT4, FT2, JS8A, JS8B, JS8C];

/** Nominal frame duration (transmission length) in seconds. */
export function frameSeconds(spec: ModeSpec): number {
  return spec.nSym * spec.symbolPeriod;
}

export function toneSpacing(spec: ModeSpec): number {
  return 1 / spec.symbolPeriod;
}

export function bandwidth(spec: ModeSpec): number {
  return spec.tones * toneSpacing(spec);
}
