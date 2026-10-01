/**
 * FT8 / FT4 / FT2 codec: 77-bit payload -> CRC-14 -> LDPC(174,91) -> tones,
 * and the matching receive path.
 */
import { LDPC_174_91_GEN_HEX, FT4_XOR } from './tables';
import { LdpcCode, osdDecode } from './ldpc';
import { crc14 } from './crc';
import { readBits, writeBits, type Bits } from './bits';
import type { ModeSpec } from './modes';
import {
  extractLlr,
  estimateSnr,
  refineFrequency,
  synthesize,
  verifyTones,
  type Candidate,
  type SymbolSpectra,
} from './modem';
import { CallsignHashTable, pack77, unpack77 } from './message77';

let code91: LdpcCode | null = null;
export function ldpc91(): LdpcCode {
  if (!code91) code91 = new LdpcCode(LDPC_174_91_GEN_HEX, 91, 174);
  return code91;
}

function applyFt4Xor(payload: Bits): Bits {
  const out = payload.slice();
  for (let i = 0; i < 77; i++) {
    const bit = (FT4_XOR[i >> 3] >> (7 - (i & 7))) & 1;
    out[i] ^= bit;
  }
  return out;
}

/** 77 payload bits -> channel tone sequence for an FT-family mode. */
export function ftxEncodeTones(payload77: Bits, spec: ModeSpec): Uint8Array {
  const payload = spec.id === 'FT4' ? applyFt4Xor(payload77) : payload77;
  const a91 = new Uint8Array(91);
  a91.set(payload.subarray(0, 77));
  const crc = crc14(payload);
  writeBits(a91, 77, 14, crc);
  const codeword = ldpc91().encode(a91);

  const tones = new Uint8Array(spec.nSym);
  for (const g of spec.syncGroups) for (let k = 0; k < g.tones.length; k++) tones[g.pos + k] = g.tones[k];
  let bit = 0;
  for (const sym of spec.dataSymbols) {
    let v = 0;
    for (let b = 0; b < spec.bitsPerSymbol; b++) v = (v << 1) | codeword[bit++];
    tones[sym] = spec.gray ? spec.gray[v] : v;
  }
  return tones;
}

export interface FtxDecode {
  payload: Bits;
  /** Fraction of symbols whose strongest tone matches the decoded message. */
  toneMatch: number;
  /** Mean dB margin of the decoded tones above the symbol average. */
  toneMargin: number;
  text: string;
  messageType: string;
  ldpcErrors: number;
  crcOk: boolean;
  frequency: number;
  dt: number;
  snr: number;
  score: number;
}

/** Try to decode one candidate. Returns null when the CRC does not check out. */
export function ftxDecodeCandidate(
  sp: SymbolSpectra,
  spec: ModeSpec,
  cand: Candidate,
  hashes: CallsignHashTable,
  osdOrder = 1,
): FtxDecode | null {
  const llr = extractLlr(sp, spec, cand, 174);
  const code = ldpc91();
  let { bits, errors } = code.decode(llr, 45);

  if (errors > 0 && osdOrder >= 0 && cand.score > 0.3) {
    // Belief propagation did not converge: fall back to ordered-statistics
    // decoding, which recovers many weak/fading signals BP alone misses.
    const osd = osdDecode(code, llr, osdOrder);
    if (osd && code.countErrors(osd.bits) === 0) {
      bits = osd.bits;
      errors = 0;
    }
  }
  if (errors > 0) return null;

  let payload = bits.slice(0, 77) as Bits;
  // The all-zero codeword is a valid codeword with a valid CRC, so OSD can
  // "decode" pure noise into an empty message. Reject it.
  let any = 0;
  for (let i = 0; i < 91; i++) any |= bits[i];
  if (!any) return null;
  const crcRx = readBits(bits, 77, 14);
  if (crc14(payload) !== crcRx) return null;
  if (spec.id === 'FT4') payload = applyFt4Xor(payload);

  const unpacked = unpack77(payload, hashes);
  if (!unpacked) return null;

  // Re-encode and compare with the received spectra to reject false decodes.
  const tones = ftxEncodeTones(payload, spec);
  const { match, margin } = verifyTones(sp, spec, cand, tones);
  if (match < 0.2) return null;

  return {
    payload,
    toneMatch: match,
    toneMargin: margin,
    text: unpacked.text,
    messageType: unpacked.type,
    ldpcErrors: errors,
    crcOk: true,
    frequency: refineFrequency(sp, spec, cand),
    dt: cand.dt,
    snr: estimateSnr(sp, spec, cand),
    score: cand.score,
  };
}

/** Encode text into an audio waveform for the given mode. */
export function ftxEncodeAudio(
  text: string,
  spec: ModeSpec,
  hashes: CallsignHashTable,
  sampleRate: number,
  baseFrequency: number,
  amplitude = 0.7,
): { audio: Float32Array; tones: Uint8Array; messageType: string; sent: string } | null {
  const packed = pack77(text, hashes);
  if (!packed) return null;
  const tones = ftxEncodeTones(packed.bits, spec);
  const audio = synthesize(tones, spec, { sampleRate, baseFrequency, amplitude });
  const roundTrip = unpack77(packed.bits, hashes);
  return { audio, tones, messageType: packed.type, sent: roundTrip?.text ?? text };
}
