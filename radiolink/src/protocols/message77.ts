/**
 * FT8 / FT4 77-bit source encoding ("pack77" / "unpack77").
 *
 * Faithful TypeScript port of the reference implementation in
 * kgoba/ft8_lib ft8/message.c, itself a port of WSJT-X packjt77.f90.
 *
 * Supported message types:
 *   i3=0 n3=0  free text (13 characters)
 *   i3=0 n3=5  telemetry (18 hex digits)
 *   i3=1, i3=2 standard: <call> <call> <grid|report|RRR|RR73|73>
 *   i3=4       non-standard call (one hashed + one 11-char call)
 *
 * Callsign hashes (22/12/10 bit) are kept in a rolling table exactly like
 * WSJT-X does, so `<...>` placeholders resolve once the full call has been
 * heard.
 */
import { readBits, writeBits, type Bits } from './bits';

const T_FULL = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
const T_ALNUM_SPACE_SLASH = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
const T_ALNUM_SPACE = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const T_LETTERS_SPACE = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const T_ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const T_NUM = '0123456789';

const NTOKENS = 2063592;
const MAX22 = 4194304;
const MAXGRID4 = 32400;

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => c >= 'A' && c <= 'Z';

/** Rolling callsign hash table (shared by the decoder and encoder). */
export class CallsignHashTable {
  private h22 = new Map<number, string>();
  private h12 = new Map<number, string>();
  private h10 = new Map<number, string>();

  static hash(callsign: string): { n22: number; n12: number; n10: number } | null {
    // 58-bit base-38 packing of up to 11 characters, then a multiply-shift hash
    let n58 = 0n;
    for (let i = 0; i < 11; i++) {
      const c = i < callsign.length ? callsign[i] : ' ';
      const j = T_ALNUM_SPACE_SLASH.indexOf(c);
      if (j < 0) return null;
      n58 = 38n * n58 + BigInt(j);
    }
    const n22 = Number(((47055833459n * n58) >> 42n) & 0x3fffffn);
    return { n22, n12: n22 >> 10, n10: n22 >> 12 };
  }

  save(callsign: string): { n22: number; n12: number; n10: number } | null {
    const h = CallsignHashTable.hash(callsign);
    if (!h) return null;
    this.h22.set(h.n22, callsign);
    this.h12.set(h.n12, callsign);
    this.h10.set(h.n10, callsign);
    return h;
  }

  lookup(kind: 22 | 12 | 10, hash: number): string | null {
    const m = kind === 22 ? this.h22 : kind === 12 ? this.h12 : this.h10;
    return m.get(hash) ?? null;
  }

  entries(): string[] {
    return [...new Set(this.h22.values())];
  }
}

function packBasecall(callsign: string): number {
  if (callsign.length <= 2) return -1;
  let c6 = '      ';
  const put = (s: string, at: number) => {
    c6 = (c6.slice(0, at) + s + c6.slice(at + s.length)).slice(0, 6);
  };
  const len = callsign.length;
  if (callsign.startsWith('3DA0') && len > 4 && len <= 7) {
    c6 = '      ';
    put('3D0', 0);
    put(callsign.slice(4), 3);
  } else if (callsign.startsWith('3X') && isLetter(callsign[2] ?? '') && len <= 7) {
    c6 = '      ';
    put('Q', 0);
    put(callsign.slice(2), 1);
  } else if (isDigit(callsign[2] ?? '') && len <= 6) {
    put(callsign, 0);
  } else if (isDigit(callsign[1] ?? '') && len <= 5) {
    put(callsign, 1);
  } else {
    return -1;
  }

  const i0 = T_ALNUM_SPACE.indexOf(c6[0]);
  const i1 = T_ALNUM.indexOf(c6[1]);
  const i2 = T_NUM.indexOf(c6[2]);
  const i3 = T_LETTERS_SPACE.indexOf(c6[3]);
  const i4 = T_LETTERS_SPACE.indexOf(c6[4]);
  const i5 = T_LETTERS_SPACE.indexOf(c6[5]);
  if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0) return -1;
  let n = i0;
  n = n * 36 + i1;
  n = n * 10 + i2;
  n = n * 27 + i3;
  n = n * 27 + i4;
  n = n * 27 + i5;
  return n;
}

function parseCqModifier(s: string): number {
  let nnum = 0;
  let nlet = 0;
  let m = 0;
  for (let i = 3; i < 8 && i < s.length; i++) {
    const c = s[i];
    if (c === ' ') break;
    if (isDigit(c)) nnum++;
    else if (isLetter(c)) {
      nlet++;
      m = 27 * m + (c.charCodeAt(0) - 64);
    } else return -1;
  }
  if (nnum === 3 && nlet === 0) return parseInt(s.slice(3, 6), 10);
  if (nnum === 0 && nlet > 0 && nlet <= 4) return 1000 + m;
  return -1;
}

function pack28(callsign: string, hashes: CallsignHashTable): { n28: number; ip: number } | null {
  if (callsign === 'DE') return { n28: 0, ip: 0 };
  if (callsign === 'QRZ') return { n28: 1, ip: 0 };
  if (callsign === 'CQ') return { n28: 2, ip: 0 };
  if (callsign.startsWith('CQ ') && callsign.length < 8) {
    const v = parseCqModifier(callsign);
    if (v < 0) return null;
    return { n28: 3 + v, ip: 0 };
  }
  let ip = 0;
  let base = callsign;
  if (callsign.endsWith('/P') || callsign.endsWith('/R')) {
    ip = 1;
    base = callsign.slice(0, -2);
  }
  const n = packBasecall(base);
  if (n >= 0) {
    hashes.save(callsign);
    return { n28: NTOKENS + MAX22 + n, ip };
  }
  if (callsign.length >= 3 && callsign.length <= 11) {
    const h = hashes.save(callsign);
    if (!h) return null;
    return { n28: NTOKENS + h.n22, ip: 0 };
  }
  return null;
}

function unpack28(n28: number, ip: number, i3: number, hashes: CallsignHashTable): string | null {
  if (n28 < NTOKENS) {
    if (n28 === 0) return 'DE';
    if (n28 === 1) return 'QRZ';
    if (n28 === 2) return 'CQ';
    if (n28 <= 1002) return 'CQ ' + String(n28 - 3).padStart(3, '0');
    if (n28 <= 532443) {
      let n = n28 - 1003;
      const out: string[] = ['', '', '', ''];
      for (let i = 3; i >= 0; i--) {
        out[i] = T_LETTERS_SPACE[n % 27];
        n = Math.floor(n / 27);
      }
      return 'CQ ' + out.join('').trimStart();
    }
    return null;
  }
  let n = n28 - NTOKENS;
  if (n < MAX22) {
    const call = hashes.lookup(22, n);
    return call ? `<${call}>` : '<...>';
  }
  n -= MAX22;
  const c = new Array<string>(6);
  c[5] = T_LETTERS_SPACE[n % 27];
  n = Math.floor(n / 27);
  c[4] = T_LETTERS_SPACE[n % 27];
  n = Math.floor(n / 27);
  c[3] = T_LETTERS_SPACE[n % 27];
  n = Math.floor(n / 27);
  c[2] = T_NUM[n % 10];
  n = Math.floor(n / 10);
  c[1] = T_ALNUM[n % 36];
  n = Math.floor(n / 36);
  c[0] = T_ALNUM_SPACE[n % 37];
  let call = c.join('');
  if (call.startsWith('3D0') && call[3] !== ' ') call = '3DA0' + call.slice(3);
  else if (call[0] === 'Q' && isLetter(call[1])) call = '3X' + call.slice(1);
  call = call.trim();
  if (call.length < 3) return null;
  if (ip !== 0) {
    if (i3 === 1) call += '/R';
    else if (i3 === 2) call += '/P';
    else return null;
  }
  hashes.save(call);
  return call;
}

function packGrid(extra: string): number {
  if (!extra) return MAXGRID4 + 1;
  if (extra === 'RRR') return MAXGRID4 + 2;
  if (extra === 'RR73') return MAXGRID4 + 3;
  if (extra === '73') return MAXGRID4 + 4;
  const g = extra.toUpperCase();
  if (/^[A-R][A-R][0-9][0-9]$/.test(g)) {
    let v = g.charCodeAt(0) - 65;
    v = v * 18 + (g.charCodeAt(1) - 65);
    v = v * 10 + (g.charCodeAt(2) - 48);
    v = v * 10 + (g.charCodeAt(3) - 48);
    return v;
  }
  const m = /^(R?)([+-]\d{1,2})$/.exec(g);
  if (m) {
    const dd = parseInt(m[2], 10);
    const irpt = 35 + dd;
    return MAXGRID4 + irpt + (m[1] === 'R' ? 0x8000 : 0);
  }
  return MAXGRID4 + 1;
}

function unpackGrid(igrid4: number, ir: number): string {
  if (igrid4 <= MAXGRID4) {
    let n = igrid4;
    const d4 = n % 10;
    n = Math.floor(n / 10);
    const d3 = n % 10;
    n = Math.floor(n / 10);
    const c2 = String.fromCharCode(65 + (n % 18));
    n = Math.floor(n / 18);
    const c1 = String.fromCharCode(65 + (n % 18));
    return (ir > 0 ? 'R ' : '') + `${c1}${c2}${d3}${d4}`;
  }
  const irpt = igrid4 - MAXGRID4;
  if (irpt === 1) return '';
  if (irpt === 2) return 'RRR';
  if (irpt === 3) return 'RR73';
  if (irpt === 4) return '73';
  const v = irpt - 35;
  const s = (v >= 0 ? '+' : '-') + String(Math.abs(v)).padStart(2, '0');
  return (ir > 0 ? 'R' : '') + s;
}

/* ------------------------------------------------------------------ */
/* Free text (i3=0, n3=0): 13 characters, base-42                      */
/* ------------------------------------------------------------------ */

function packFreeText(text: string): Bits | null {
  const t = text.toUpperCase().slice(0, 13);
  const digits: number[] = [];
  for (let i = 0; i < 13; i++) {
    const c = i < t.length ? t[i] : ' ';
    const v = T_FULL.indexOf(c);
    if (v < 0) return null;
    digits.push(v);
  }
  // big-endian base-42 accumulation into a 71-bit integer
  let acc = 0n;
  for (const d of digits) acc = acc * 42n + BigInt(d);
  const bits = new Uint8Array(77);
  for (let i = 70; i >= 0; i--) {
    bits[i] = Number(acc & 1n);
    acc >>= 1n;
  }
  // bits 71..76 remain zero: i3 = 0, n3 = 0
  return bits;
}

function unpackFreeText(bits: Bits): string {
  let acc = 0n;
  for (let i = 0; i < 71; i++) acc = (acc << 1n) | BigInt(bits[i]);
  const chars: string[] = [];
  for (let i = 0; i < 13; i++) {
    chars.unshift(T_FULL[Number(acc % 42n)]);
    acc /= 42n;
  }
  return chars.join('').trim();
}

function unpackTelemetry(bits: Bits): string {
  let hex = '';
  let acc = 0n;
  for (let i = 0; i < 71; i++) acc = (acc << 1n) | BigInt(bits[i]);
  acc <<= 1n; // right-align into 72 bits as WSJT-X does
  const s = acc.toString(16).padStart(18, '0');
  hex = s.toUpperCase();
  return hex;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface Packed77 {
  bits: Bits;
  type: string;
}

/** Encode a human-typed message into 77 payload bits. */
export function pack77(text: string, hashes: CallsignHashTable): Packed77 | null {
  const clean = text.trim().toUpperCase().replace(/\s+/g, ' ');
  const tokens = clean.split(' ');

  let callTo = '';
  let callDe = '';
  let extra = '';
  let rest: string[] = [];

  if (clean.startsWith('CQ ')) {
    const mod = parseCqModifier(clean);
    if (mod >= 0) {
      callTo = 'CQ ' + tokens[1];
      callDe = tokens[2] ?? '';
      extra = tokens[3] ?? '';
      rest = tokens.slice(4);
    } else {
      callTo = 'CQ';
      callDe = tokens[1] ?? '';
      extra = tokens[2] ?? '';
      rest = tokens.slice(3);
    }
  } else {
    callTo = tokens[0] ?? '';
    callDe = tokens[1] ?? '';
    extra = tokens[2] ?? '';
    rest = tokens.slice(3);
  }

  if (rest.length === 0 && callTo && callDe) {
    const std = packStandard(callTo, callDe, extra, hashes);
    if (std) return { bits: std, type: 'standard' };
    const nonstd = packNonstandard(callTo, callDe, extra, hashes);
    if (nonstd) return { bits: nonstd, type: 'nonstandard-call' };
  }
  const free = packFreeText(clean);
  if (free) return { bits: free, type: 'free-text' };
  return null;
}

function packStandard(callTo: string, callDe: string, extra: string, hashes: CallsignHashTable): Bits | null {
  const a = pack28(callTo, hashes);
  const b = pack28(callDe, hashes);
  if (!a || !b) return null;
  let i3 = 1;
  if (callTo.endsWith('/P') || callDe.endsWith('/P')) {
    i3 = 2;
    if (callTo.endsWith('/R') || callDe.endsWith('/R')) return null;
  }
  const slashDe = callDe.indexOf('/');
  const icq = callTo === 'CQ' || callTo.startsWith('CQ ');
  if (slashDe >= 2 && icq && !(callDe.endsWith('/P') || callDe.endsWith('/R'))) return null;

  const igrid4full = packGrid(extra);
  const ir = (igrid4full & 0x8000) !== 0 ? 1 : 0;
  const igrid4 = igrid4full & 0x7fff;
  if (extra && igrid4 === MAXGRID4 + 1 && extra !== '') {
    // extra token present but not a grid/report -> not a standard message
    return null;
  }

  const n29a = a.n28 * 2 + a.ip;
  const n29b = b.n28 * 2 + b.ip;
  const bits = new Uint8Array(77);
  writeBits(bits, 0, 29, n29a);
  writeBits(bits, 29, 29, n29b);
  writeBits(bits, 58, 1, ir);
  writeBits(bits, 59, 15, igrid4);
  writeBits(bits, 74, 3, i3);
  return bits;
}

function packNonstandard(callTo: string, callDe: string, extra: string, hashes: CallsignHashTable): Bits | null {
  const icq = callTo === 'CQ' || callTo.startsWith('CQ ') ? 1 : 0;
  if (!icq && callTo.length < 3) return null;
  if (callDe.length < 3) return null;

  let iflip = 0;
  let n12 = 0;
  let call58 = callDe;
  if (!icq) {
    if (callDe.startsWith('<') && callDe.endsWith('>')) iflip = 1;
    const call12 = iflip === 0 ? callTo : callDe;
    call58 = iflip === 0 ? callDe : callTo;
    const h = hashes.save(call12.replace(/[<>]/g, ''));
    if (!h) return null;
    n12 = h.n12;
  }
  const plain = call58.replace(/[<>]/g, '');
  if (plain.length > 11) return null;
  let n58 = 0n;
  for (const ch of plain) {
    const j = T_ALNUM_SPACE_SLASH.indexOf(ch);
    if (j < 0) return null;
    n58 = n58 * 38n + BigInt(j);
  }
  hashes.save(plain);

  let nrpt = 0;
  if (!icq) {
    if (extra === 'RRR') nrpt = 1;
    else if (extra === 'RR73') nrpt = 2;
    else if (extra === '73') nrpt = 3;
    else if (extra) return null;
  }

  const bits = new Uint8Array(77);
  writeBits(bits, 0, 12, n12);
  // 58-bit field written via BigInt
  for (let i = 57; i >= 0; i--) {
    bits[12 + i] = Number(n58 & 1n);
    n58 >>= 1n;
  }
  writeBits(bits, 70, 1, iflip);
  writeBits(bits, 71, 2, nrpt);
  writeBits(bits, 73, 1, icq);
  writeBits(bits, 74, 3, 4);
  return bits;
}

export interface Unpacked77 {
  text: string;
  type: string;
  callTo?: string;
  callDe?: string;
  extra?: string;
  i3: number;
  n3: number;
}

/** Decode 77 payload bits back into text. Returns null for unsupported types. */
export function unpack77(bits: Bits, hashes: CallsignHashTable): Unpacked77 | null {
  const i3 = readBits(bits, 74, 3);
  const n3 = readBits(bits, 71, 3);

  if (i3 === 0 && n3 === 0) {
    return { text: unpackFreeText(bits), type: 'free-text', i3, n3 };
  }
  if (i3 === 0 && n3 === 5) {
    return { text: unpackTelemetry(bits), type: 'telemetry', i3, n3 };
  }
  if (i3 === 1 || i3 === 2) {
    const n29a = readBits(bits, 0, 29);
    const n29b = readBits(bits, 29, 29);
    const ir = bits[58];
    const igrid4 = readBits(bits, 59, 15);
    const callTo = unpack28(Math.floor(n29a / 2), n29a % 2, i3, hashes);
    const callDe = unpack28(Math.floor(n29b / 2), n29b % 2, i3, hashes);
    if (!callTo || !callDe) return null;
    const extra = unpackGrid(igrid4, ir);
    return {
      text: [callTo, callDe, extra].filter(Boolean).join(' '),
      type: 'standard',
      callTo,
      callDe,
      extra,
      i3,
      n3,
    };
  }
  if (i3 === 4) {
    const n12 = readBits(bits, 0, 12);
    let n58 = 0n;
    for (let i = 0; i < 58; i++) n58 = (n58 << 1n) | BigInt(bits[12 + i]);
    const iflip = bits[70];
    const nrpt = readBits(bits, 71, 2);
    const icq = bits[73];
    const chars: string[] = [];
    for (let i = 10; i >= 0; i--) {
      chars[i] = T_ALNUM_SPACE_SLASH[Number(n58 % 38n)];
      n58 /= 38n;
    }
    const decoded = chars.join('').trim();
    if (decoded.length >= 3) hashes.save(decoded);
    const hashed = hashes.lookup(12, n12);
    const call3 = hashed ? `<${hashed}>` : '<...>';
    const call1 = iflip ? decoded : call3;
    const call2 = iflip ? call3 : decoded;
    let callTo = call1;
    let extra = '';
    if (icq) {
      callTo = 'CQ';
    } else {
      extra = ['', 'RRR', 'RR73', '73'][nrpt];
    }
    return {
      text: [callTo, call2, extra].filter(Boolean).join(' '),
      type: 'nonstandard-call',
      callTo,
      callDe: call2,
      extra,
      i3,
      n3,
    };
  }
  return null;
}
