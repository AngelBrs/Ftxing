/** Bit-level helpers shared by all FT-family / JS8 codecs. */

export type Bits = Uint8Array; // one bit per element, values 0/1

export function hexToBits(hex: string, nbits: number): Bits {
  const out = new Uint8Array(nbits);
  for (let i = 0; i < nbits; i++) {
    const byte = parseInt(hex.substr((i >> 3) * 2, 2), 16);
    out[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return out;
}

export function bytesToBits(bytes: Uint8Array, nbits: number): Bits {
  const out = new Uint8Array(nbits);
  for (let i = 0; i < nbits; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

export function bitsToBytes(bits: Bits, nbytes = Math.ceil(bits.length / 8)): Uint8Array {
  const out = new Uint8Array(nbytes);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** Read `n` bits starting at `pos` as an unsigned integer (MSB first, <= 32 bits). */
export function readBits(bits: Bits, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 2 + bits[pos + i];
  return v;
}

/** Write `n` bits of `value` at `pos` (MSB first). Works for values up to 2^53. */
export function writeBits(bits: Bits, pos: number, n: number, value: number): void {
  for (let i = n - 1; i >= 0; i--) {
    bits[pos + i] = value % 2;
    value = Math.floor(value / 2);
  }
}

export function bitsEqual(a: Bits, b: Bits): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
