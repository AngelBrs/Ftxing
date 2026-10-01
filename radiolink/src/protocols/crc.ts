/**
 * CRCs used by the supported protocols.
 *
 *  - FT8 / FT4 / FT2: CRC-14, polynomial 0x2757 (WSJT-X), computed over the
 *    77-bit payload zero-extended to 82 bits.
 *  - JS8:             CRC-12, polynomial 0xC06, "augmented" style, computed
 *    over 11 bytes (72 payload bits + 3 type bits + zero padding), then
 *    XORed with 42 (a JS8Call-specific twist).
 */
import type { Bits } from './bits';

/** Generic MSB-first bitwise CRC over an array of bits. */
function crcBits(bits: Bits, width: number, poly: number): number {
  const top = 1 << (width - 1);
  const mask = (top << 1) - 1;
  let rem = 0;
  for (let i = 0; i < bits.length; i++) {
    const inBit = bits[i];
    const topBit = (rem & top) !== 0 ? 1 : 0;
    rem = ((rem << 1) & mask) | inBit;
    if (topBit) rem ^= poly;
  }
  return rem & mask;
}

/**
 * WSJT-X FT8/FT4 CRC-14 of a 77-bit payload.
 * Reference: ft8_lib ftx_add_crc() — payload zero-extended to 82 bits,
 * CRC computed over 82 bits.
 */
export function crc14(payload77: Bits): number {
  const ext = new Uint8Array(82);
  ext.set(payload77.subarray(0, 77));
  // The reference implementation runs the division over 82 bits and returns
  // the 14-bit remainder, which for a plain (non-augmented) CRC means we must
  // also clock in 14 zero bits.
  const full = new Uint8Array(82 + 14);
  full.set(ext);
  return crcBits(full, 14, 0x2757);
}

/** JS8 CRC-12 (boost augmented_crc with polynomial 0xC06), XOR 42. */
export function crc12js8(bits: Bits): number {
  // Augmented CRC: the message already carries the trailing zero bits, so we
  // simply divide the whole bit sequence.
  return crcBits(bits, 12, 0xc06) ^ 42;
}
