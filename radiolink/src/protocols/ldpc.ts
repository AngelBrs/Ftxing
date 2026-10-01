/**
 * Systematic LDPC codes used by the FT-family and JS8.
 *
 * Both codes are systematic: codeword = [ message(K) | parity(M) ] with
 * parity_i = sum_j G[i][j] * message_j (mod 2).  The parity-check matrix is
 * therefore H = [ G | I_M ], which we build directly from the published
 * generator matrices (see tables.ts for provenance).
 *
 * Decoding uses a normalized min-sum belief-propagation decoder, which is
 * numerically robust with the soft symbol metrics coming out of a noisy,
 * fading HF channel, plus an ordered-statistics style bit-flip fallback for
 * near-miss cases.
 */
import { hexToBits, type Bits } from './bits';

export class LdpcCode {
  readonly N: number;
  readonly K: number;
  readonly M: number;
  /** For each parity check, the list of codeword bit indices involved. */
  readonly checkNodes: Int32Array[];
  /** For each codeword bit, the list of parity checks it participates in. */
  readonly bitNodes: Int32Array[];
  private readonly genRows: Bits[];

  constructor(genHex: string[], K: number, N: number) {
    this.K = K;
    this.N = N;
    this.M = N - K;
    if (genHex.length !== this.M) throw new Error('generator size mismatch');
    this.genRows = genHex.map((h) => hexToBits(h, K));

    const checks: number[][] = [];
    const bits: number[][] = Array.from({ length: N }, () => [] as number[]);
    for (let i = 0; i < this.M; i++) {
      const row: number[] = [];
      const g = this.genRows[i];
      for (let j = 0; j < K; j++) if (g[j]) row.push(j);
      row.push(K + i); // the parity bit itself
      checks.push(row);
      for (const b of row) bits[b].push(i);
    }
    this.checkNodes = checks.map((r) => Int32Array.from(r));
    this.bitNodes = bits.map((r) => Int32Array.from(r));
  }

  /** Systematic encode: K message bits -> N codeword bits. */
  encode(message: Bits): Bits {
    const cw = new Uint8Array(this.N);
    cw.set(message.subarray(0, this.K));
    for (let i = 0; i < this.M; i++) {
      const g = this.genRows[i];
      let sum = 0;
      for (let j = 0; j < this.K; j++) sum ^= g[j] & message[j];
      cw[this.K + i] = sum;
    }
    return cw;
  }

  /** Number of unsatisfied parity checks for a hard-decision codeword. */
  countErrors(hard: Bits): number {
    let bad = 0;
    for (const row of this.checkNodes) {
      let s = 0;
      for (let k = 0; k < row.length; k++) s ^= hard[row[k]];
      if (s) bad++;
    }
    return bad;
  }

  /**
   * Normalized min-sum BP decoder.
   * @param llr  Log-likelihood ratios, positive = bit is more likely 0.
   * @returns hard decisions plus the number of remaining parity errors.
   */
  decode(llr: Float32Array, maxIters = 40, alpha = 0.75): { bits: Bits; errors: number; iters: number } {
    const N = this.N;
    const M = this.M;
    // message arrays laid out per check node
    const rows = this.checkNodes;
    const toCheck: Float32Array[] = new Array(M);
    const toBit: Float32Array[] = new Array(M);
    for (let i = 0; i < M; i++) {
      toCheck[i] = new Float32Array(rows[i].length);
      toBit[i] = new Float32Array(rows[i].length);
    }
    const total = new Float32Array(N);
    const hard = new Uint8Array(N);

    // init
    for (let i = 0; i < M; i++) {
      const row = rows[i];
      for (let k = 0; k < row.length; k++) toCheck[i][k] = llr[row[k]];
    }

    let best: { bits: Bits; errors: number; iters: number } | null = null;

    for (let iter = 0; iter < maxIters; iter++) {
      // check node update (min-sum)
      for (let i = 0; i < M; i++) {
        const row = rows[i];
        const inMsg = toCheck[i];
        const out = toBit[i];
        let sign = 1;
        let min1 = Infinity;
        let min2 = Infinity;
        let minIdx = -1;
        for (let k = 0; k < row.length; k++) {
          const v = inMsg[k];
          if (v < 0) sign = -sign;
          const a = Math.abs(v);
          if (a < min1) {
            min2 = min1;
            min1 = a;
            minIdx = k;
          } else if (a < min2) min2 = a;
        }
        for (let k = 0; k < row.length; k++) {
          const v = inMsg[k];
          const s = v < 0 ? -sign : sign; // exclude own sign
          const mag = (k === minIdx ? min2 : min1) * alpha;
          out[k] = s * mag;
        }
      }

      // bit node update
      total.set(llr);
      for (let i = 0; i < M; i++) {
        const row = rows[i];
        const out = toBit[i];
        for (let k = 0; k < row.length; k++) total[row[k]] += out[k];
      }
      for (let n = 0; n < N; n++) hard[n] = total[n] < 0 ? 1 : 0;

      const errors = this.countErrors(hard);
      if (!best || errors < best.errors) best = { bits: hard.slice(), errors, iters: iter + 1 };
      if (errors === 0) return best;

      for (let i = 0; i < M; i++) {
        const row = rows[i];
        const out = toBit[i];
        const inMsg = toCheck[i];
        for (let k = 0; k < row.length; k++) inMsg[k] = total[row[k]] - out[k];
      }
    }
    return best!;
  }
}

/* ------------------------------------------------------------------ */
/* Ordered-statistics decoding (OSD)                                   */
/* ------------------------------------------------------------------ */

export interface OsdResult {
  bits: Bits;
  distance: number;
}

/**
 * Ordered-statistics decoder used when belief propagation fails.
 *
 * This is the same idea as WSJT-X's osd174_91: re-order the codeword
 * positions by reliability, Gaussian-eliminate the generator matrix to find
 * the most reliable independent basis, re-encode from the hard decisions of
 * that basis, and search a small neighbourhood of bit flips for the codeword
 * with the smallest soft distance. It buys several dB on weak signals.
 */
export function osdDecode(code: LdpcCode, llr: Float32Array, order = 1): OsdResult | null {
  const N = code.N;
  const K = code.K;

  // Full generator matrix rows (K x N), systematic: [ I_K | P ]
  if (!(code as unknown as { _gmat?: Uint8Array[] })._gmat) {
    const g: Uint8Array[] = [];
    for (let r = 0; r < K; r++) {
      const row = new Uint8Array(N);
      row[r] = 1;
      g.push(row);
    }
    for (let i = 0; i < code.M; i++) {
      for (const bitIdx of code.checkNodes[i]) {
        if (bitIdx < K) g[bitIdx][K + i] = 1;
      }
    }
    (code as unknown as { _gmat?: Uint8Array[] })._gmat = g;
  }
  const gmat = (code as unknown as { _gmat: Uint8Array[] })._gmat;

  const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => Math.abs(llr[b]) - Math.abs(llr[a]));

  // Permuted generator matrix
  const A: Uint8Array[] = [];
  for (let r = 0; r < K; r++) {
    const row = new Uint8Array(N);
    const src = gmat[r];
    for (let c = 0; c < N; c++) row[c] = src[idx[c]];
    A.push(row);
  }

  // Gaussian elimination to reduced row echelon form over the most reliable columns
  const pivotCols: number[] = [];
  let rank = 0;
  for (let c = 0; c < N && rank < K; c++) {
    let pivot = -1;
    for (let r = rank; r < K; r++) {
      if (A[r][c]) {
        pivot = r;
        break;
      }
    }
    if (pivot < 0) continue;
    const tmp = A[rank];
    A[rank] = A[pivot];
    A[pivot] = tmp;
    for (let r = 0; r < K; r++) {
      if (r !== rank && A[r][c]) {
        const dst = A[r];
        const src = A[rank];
        for (let j = c; j < N; j++) dst[j] ^= src[j];
      }
    }
    pivotCols.push(c);
    rank++;
  }
  if (rank < K) return null;

  const hard = new Uint8Array(N);
  const rel = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    hard[c] = llr[idx[c]] < 0 ? 1 : 0;
    rel[c] = Math.abs(llr[idx[c]]);
  }

  const base = new Uint8Array(N);
  for (let k = 0; k < K; k++) if (hard[pivotCols[k]]) xorInto(base, A[k]);

  const distanceOf = (cw: Uint8Array) => {
    let d = 0;
    for (let c = 0; c < N; c++) if (cw[c] !== hard[c]) d += rel[c];
    return d;
  };

  let bestCw = base;
  let bestDist = distanceOf(base);

  if (order >= 1) {
    const trial = new Uint8Array(N);
    for (let k = K - 1; k >= 0; k--) {
      trial.set(base);
      xorInto(trial, A[k]);
      const d = distanceOf(trial);
      if (d < bestDist) {
        bestDist = d;
        bestCw = trial.slice();
      }
    }
  }
  if (order >= 2) {
    const trial = new Uint8Array(N);
    const span = Math.min(K, 40); // only the least reliable part of the basis
    for (let a = K - span; a < K; a++) {
      for (let b = a + 1; b < K; b++) {
        trial.set(base);
        xorInto(trial, A[a]);
        xorInto(trial, A[b]);
        const d = distanceOf(trial);
        if (d < bestDist) {
          bestDist = d;
          bestCw = trial.slice();
        }
      }
    }
  }

  // un-permute
  const out = new Uint8Array(N);
  for (let c = 0; c < N; c++) out[idx[c]] = bestCw[c];
  return { bits: out, distance: bestDist };
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}
