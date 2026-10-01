/**
 * JS8 codec (JS8Call compatible modem + frame layer).
 *
 * Modem / FEC layer — fully implemented and interoperable:
 *   72 message bits + 3 frame-type bits + CRC-12 (poly 0xC06, xor 42)
 *   -> LDPC(174,87) -> 79 channel symbols, 8-FSK, Costas 7x7 sync at
 *   symbols 0/36/72 (JS8Call NCOSTAS=1 arrays), no Gray mapping.
 *
 * Frame layer — what this application understands:
 *   * FrameData (Huffman "varicode" free text)      encode + decode
 *   * FrameDataCompressed (JSC dictionary coding)   detected, reported as
 *                                                   unsupported (the JSC code
 *                                                   tables are not included)
 *   * FrameDirected / FrameCompound / FrameHeartbeat: header fields decoded
 *                                                   (callsigns + command),
 *                                                   reported as such.
 */
import { LDPC_174_87_GEN_HEX } from './tables';
import { LdpcCode, osdDecode } from './ldpc';
import { crc12js8 } from './crc';
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

let code87: LdpcCode | null = null;
export function ldpc87(): LdpcCode {
  if (!code87) code87 = new LdpcCode(LDPC_174_87_GEN_HEX, 87, 174);
  return code87;
}

/** JS8Call Huffman varicode table (varicode.cpp hufftable). */
const HUFF: Record<string, string> = {
  ' ': '01',
  E: '100',
  T: '1101',
  A: '0011',
  O: '11111',
  I: '11100',
  N: '10111',
  S: '10100',
  H: '00011',
  R: '00000',
  D: '111011',
  L: '110011',
  C: '110001',
  U: '101101',
  M: '101011',
  W: '001011',
  F: '001001',
  G: '000101',
  Y: '000011',
  P: '1111011',
  B: '1111001',
  '.': '1110100',
  V: '1100101',
  K: '1100100',
  '-': '1100001',
  '+': '1100000',
  '?': '1011001',
  '!': '1011000',
  '"': '1010101',
  X: '1010100',
  '0': '0010101',
  J: '0010100',
  '1': '0010001',
  Q: '0010000',
  '2': '0001001',
  Z: '0001000',
  '3': '0000101',
  '5': '0000100',
  '4': '11110101',
  '9': '11110100',
  '8': '11110001',
  '6': '11110000',
  '7': '11101011',
  '/': '11101010',
};

const HUFF_DECODE: Record<string, string> = Object.fromEntries(Object.entries(HUFF).map(([k, v]) => [v, k]));

export const JS8_FRAME_TYPES = {
  HEARTBEAT: 0,
  COMPOUND: 1,
  COMPOUND_DIRECTED: 2,
  DIRECTED: 3,
  DATA: 4, // 10x
  DATA_COMPRESSED: 6, // 11x
} as const;

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;

/** JS8 28-bit base callsign unpack (varicode.cpp unpackCallsign). */
function unpackJs8Callsign(value: number, portable: boolean): string {
  if (value >= NBASECALL) {
    const special: Record<number, string> = {
      [NBASECALL + 1]: '<....>',
      [NBASECALL + 2]: '@ALLCALL',
      [NBASECALL + 3]: '@JS8NET',
    };
    return special[value] ?? `@GROUP${value - NBASECALL}`;
  }
  let v = value;
  const w = new Array<string>(6);
  w[5] = ALNUM[(v % 27) + 10];
  v = Math.floor(v / 27);
  w[4] = ALNUM[(v % 27) + 10];
  v = Math.floor(v / 27);
  w[3] = ALNUM[(v % 27) + 10];
  v = Math.floor(v / 27);
  w[2] = ALNUM[v % 10];
  v = Math.floor(v / 10);
  w[1] = ALNUM[v % 36];
  v = Math.floor(v / 36);
  w[0] = ALNUM[v] ?? ' ';
  let call = w.join('').trim();
  if (call.startsWith('3D0')) call = '3DA0' + call.slice(3);
  if (call.startsWith('Q') && call[1] >= 'A' && call[1] <= 'Z') call = '3X' + call.slice(1);
  return portable ? call + '/P' : call;
}

/** Commonly seen JS8 directed commands (varicode.cpp directed_cmds, abridged). */
const DIRECTED_CMDS: Record<number, string> = {
  0: ' SNR?',
  1: ' DIT DIT',
  2: ' NACK',
  3: ' HEARTBEAT SNR',
  4: ' GRID?',
  5: '>',
  6: ' STATUS?',
  7: ' STATUS',
  8: ' HEARING?',
  9: ' MSG',
  10: ' MSG TO:',
  11: ' QUERY',
  12: ' QUERY MSGS',
  13: ' QUERY CALL',
  15: ' ACK',
  16: ' AGN?',
  17: ' INFO?',
  18: ' INFO',
  19: ' GRID',
  21: ' SNR',
  22: ' QSL?',
  23: ' QSL',
  24: ' YES',
  25: ' NO',
  26: ' BCN',
  27: ' 73',
  28: ' SK',
  29: '?',
  30: ' HW CPY?',
  31: ' SNR',
};

export interface Js8Frame {
  /** 72 payload bits of the frame */
  bits: Bits;
  i3: number;
}

/** Encode free text into one or more JS8 data frames (Huffman varicode). */
export function js8EncodeText(text: string): { frames: Js8Frame[]; sent: string } {
  const clean = text.toUpperCase().replace(/[^\x20-\x7E]/g, '');
  const bits: number[] = [];
  const chars: string[] = [];
  for (const ch of clean) {
    const code = HUFF[ch];
    if (!code) continue;
    chars.push(ch);
    for (const b of code) bits.push(b === '1' ? 1 : 0);
  }

  const frames: Js8Frame[] = [];
  const sentChars: string[] = [];
  let pos = 0;
  let charIdx = 0;
  // Greedily fill 70-bit payloads (2 flag bits + 70 data bits = 72)
  while (charIdx < chars.length) {
    const frameBits: number[] = [1, 0]; // FrameData, not compressed
    let used = 0;
    while (charIdx + used < chars.length) {
      const code = HUFF[chars[charIdx + used]];
      // keep at least one padding bit so the frame end is unambiguous
      if (frameBits.length + code.length > 71) break;
      for (const b of code) frameBits.push(b === '1' ? 1 : 0);
      used++;
    }
    if (used === 0) break;
    sentChars.push(chars.slice(charIdx, charIdx + used).join(''));
    charIdx += used;
    // pad: first pad bit 0, remaining bits 1
    const pad = 72 - frameBits.length;
    for (let i = 0; i < pad; i++) frameBits.push(i === 0 ? 0 : 1);
    frames.push({ bits: Uint8Array.from(frameBits), i3: 0 });
    pos += used;
  }
  if (frames.length === 0) {
    const frameBits = [1, 0, 0];
    while (frameBits.length < 72) frameBits.push(1);
    frames.push({ bits: Uint8Array.from(frameBits), i3: 0 });
  }
  return { frames, sent: sentChars.join('') };
}

export interface Js8FrameDecode {
  text: string;
  frameType: string;
  supported: boolean;
}

/** Interpret the 72 payload bits of a JS8 frame. */
export function js8DecodeFrame(frame: Bits, i3: number): Js8FrameDecode {
  const isData = frame[0] === 1;
  if (isData) {
    const compressed = frame[1] === 1;
    // strip padding: everything after the last 0 bit is padding
    let last0 = -1;
    for (let i = frame.length - 1; i >= 0; i--) {
      if (frame[i] === 0) {
        last0 = i;
        break;
      }
    }
    const payload = Array.from(frame.subarray(2, Math.max(2, last0)));
    if (compressed) {
      return {
        text: '[JS8 compressed-text frame — JSC dictionary decoding not supported]',
        frameType: 'FrameDataCompressed',
        supported: false,
      };
    }
    // Huffman decode
    let s = payload.join('');
    let out = '';
    while (s.length > 0) {
      let matched = false;
      for (let len = 2; len <= 8; len++) {
        const pre = s.slice(0, len);
        if (HUFF_DECODE[pre] !== undefined) {
          out += HUFF_DECODE[pre];
          s = s.slice(len);
          matched = true;
          break;
        }
      }
      if (!matched) break;
    }
    return { text: out, frameType: i3 === 1 ? 'FrameFastData' : 'FrameData', supported: true };
  }

  const type = readBits(frame, 0, 3);
  if (type === JS8_FRAME_TYPES.DIRECTED) {
    const from = readBits(frame, 3, 28);
    const to = readBits(frame, 31, 28);
    const cmd = readBits(frame, 59, 5);
    const extraBits = readBits(frame, 64, 8);
    const portableFrom = (extraBits >> 7) & 1;
    const portableTo = (extraBits >> 6) & 1;
    const extra = extraBits % 64;
    const cmdText = DIRECTED_CMDS[cmd % 32] ?? ` CMD${cmd}`;
    let text = `${unpackJs8Callsign(from, !!portableFrom)}: ${unpackJs8Callsign(to, !!portableTo)}${cmdText}`;
    if (extra !== 0) text += ` ${extra - 31}`;
    return { text, frameType: 'FrameDirected', supported: true };
  }
  if (type === JS8_FRAME_TYPES.HEARTBEAT || type === JS8_FRAME_TYPES.COMPOUND || type === JS8_FRAME_TYPES.COMPOUND_DIRECTED) {
    const call = unpackJs8Callsign(readBits(frame, 3, 28), false);
    const label =
      type === JS8_FRAME_TYPES.HEARTBEAT
        ? 'FrameHeartbeat'
        : type === JS8_FRAME_TYPES.COMPOUND
          ? 'FrameCompound'
          : 'FrameCompoundDirected';
    return { text: `${call}: [${label}]`, frameType: label, supported: true };
  }
  return { text: '[JS8 frame type not supported]', frameType: `type${type}`, supported: false };
}

/** Build the 87 information bits (72 payload + 3 type + 12 CRC) of a JS8 frame. */
export function js8Info87(frame: Js8Frame): Bits {
  const crcInput = new Uint8Array(88);
  crcInput.set(frame.bits.subarray(0, 72));
  writeBits(crcInput, 72, 3, frame.i3);
  const crc = crc12js8(crcInput);
  const bits = new Uint8Array(87);
  bits.set(frame.bits.subarray(0, 72));
  writeBits(bits, 72, 3, frame.i3);
  writeBits(bits, 75, 12, crc);
  return bits;
}

export function js8EncodeTones(frame: Js8Frame, spec: ModeSpec): Uint8Array {
  const info = js8Info87(frame);
  const codeword = ldpc87().encode(info);
  const tones = new Uint8Array(spec.nSym);
  for (const g of spec.syncGroups) for (let k = 0; k < g.tones.length; k++) tones[g.pos + k] = g.tones[k];
  let bit = 0;
  for (const sym of spec.dataSymbols) {
    let v = 0;
    for (let b = 0; b < 3; b++) v = (v << 1) | codeword[bit++];
    tones[sym] = v; // JS8 does not Gray-map
  }
  return tones;
}

export function js8EncodeAudio(
  text: string,
  spec: ModeSpec,
  sampleRate: number,
  baseFrequency: number,
  amplitude = 0.7,
): { frames: { audio: Float32Array; tones: Uint8Array; text: string }[]; sent: string } {
  const { frames, sent } = js8EncodeText(text);
  return {
    frames: frames.map((f) => ({
      audio: synthesize(js8EncodeTones(f, spec), spec, { sampleRate, baseFrequency, amplitude }),
      tones: js8EncodeTones(f, spec),
      text: js8DecodeFrame(f.bits, f.i3).text,
    })),
    sent,
  };
}

export interface Js8Decode {
  text: string;
  frameType: string;
  supported: boolean;
  frequency: number;
  dt: number;
  snr: number;
  score: number;
  ldpcErrors: number;
  toneMatch: number;
  toneMargin: number;
}

export function js8DecodeCandidate(
  sp: SymbolSpectra,
  spec: ModeSpec,
  cand: Candidate,
  osdOrder = 1,
): Js8Decode | null {
  const llr = extractLlr(sp, spec, cand, 174);
  const code = ldpc87();
  let { bits, errors } = code.decode(llr, 45);
  if (errors > 0 && osdOrder >= 0 && cand.score > 0.3) {
    const osd = osdDecode(code, llr, osdOrder);
    if (osd && code.countErrors(osd.bits) === 0) {
      bits = osd.bits;
      errors = 0;
    }
  }
  if (errors > 0) return null;
  const info = bits.subarray(0, 87);
  let any = 0;
  for (let i = 0; i < 87; i++) any |= info[i];
  if (!any) return null;
  const crcInput = new Uint8Array(88);
  crcInput.set(info.subarray(0, 75));
  const expect = crc12js8(crcInput);
  const got = readBits(info, 75, 12);
  if (expect !== got) return null;
  const i3 = readBits(info, 72, 3);
  const frame = info.slice(0, 72);
  const dec = js8DecodeFrame(frame, i3);
  const tones = js8EncodeTones({ bits: frame, i3 }, spec);
  const { match, margin } = verifyTones(sp, spec, cand, tones);
  if (match < 0.2) return null;
  return {
    toneMatch: match,
    toneMargin: margin,
    text: dec.text,
    frameType: dec.frameType,
    supported: dec.supported,
    frequency: refineFrequency(sp, spec, cand),
    dt: cand.dt,
    snr: estimateSnr(sp, spec, cand),
    score: cand.score,
    ldpcErrors: errors,
  };
}
