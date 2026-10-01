/** Iterative radix-2 complex FFT with cached twiddle factors + real helpers. */

const cache = new Map<number, { cos: Float32Array; sin: Float32Array; rev: Uint32Array }>();

function tables(n: number) {
  let t = cache.get(n);
  if (t) return t;
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  t = { cos, sin, rev };
  cache.set(n, t);
  return t;
}

/** In-place complex FFT. re/im length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  const { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = cos[k];
        const s = sin[k];
        const tre = re[j + half] * c - im[j + half] * s;
        const tim = re[j + half] * s + im[j + half] * c;
        re[j + half] = re[j] - tre;
        im[j + half] = im[j] - tim;
        re[j] += tre;
        im[j] += tim;
      }
    }
  }
}

/** Power spectrum (magnitude squared) of a real signal, length n/2+1. */
export function realSpectrum(samples: Float32Array, window?: Float32Array): Float32Array {
  const n = samples.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  if (window) for (let i = 0; i < n; i++) re[i] = samples[i] * window[i];
  else re.set(samples);
  fft(re, im);
  const out = new Float32Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* ------------------------------------------------------------------ */
/* Bluestein (chirp-z) transform for arbitrary lengths                  */
/* ------------------------------------------------------------------ */

const bluesteinCache = new Map<number, { m: number; cosT: Float32Array; sinT: Float32Array; bre: Float32Array; bim: Float32Array }>();

function bluesteinTables(n: number) {
  let t = bluesteinCache.get(n);
  if (t) return t;
  const m = nextPow2(2 * n + 1);
  const cosT = new Float32Array(n);
  const sinT = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i * i) % (2 * n);
    const ang = (Math.PI * j) / n;
    cosT[i] = Math.cos(ang);
    sinT[i] = Math.sin(ang);
  }
  const bre = new Float32Array(m);
  const bim = new Float32Array(m);
  bre[0] = cosT[0];
  bim[0] = sinT[0];
  for (let i = 1; i < n; i++) {
    bre[i] = bre[m - i] = cosT[i];
    bim[i] = bim[m - i] = sinT[i];
  }
  fft(bre, bim);
  t = { m, cosT, sinT, bre, bim };
  bluesteinCache.set(n, t);
  return t;
}

/** In-place complex DFT for arbitrary n (uses Bluestein when n is not a power of two). */
export function fftAny(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if ((n & (n - 1)) === 0) {
    fft(re, im);
    return;
  }
  const { m, cosT, sinT, bre, bim } = bluesteinTables(n);
  const are = new Float32Array(m);
  const aim = new Float32Array(m);
  for (let i = 0; i < n; i++) {
    are[i] = re[i] * cosT[i] + im[i] * sinT[i];
    aim[i] = -re[i] * sinT[i] + im[i] * cosT[i];
  }
  fft(are, aim);
  for (let i = 0; i < m; i++) {
    const r = are[i] * bre[i] - aim[i] * bim[i];
    const s = are[i] * bim[i] + aim[i] * bre[i];
    are[i] = r;
    aim[i] = s;
  }
  // inverse FFT via conjugation
  for (let i = 0; i < m; i++) aim[i] = -aim[i];
  fft(are, aim);
  for (let i = 0; i < n; i++) {
    const r = (are[i] * cosT[i] - aim[i] * sinT[i]) / m;
    const s = (-aim[i] * cosT[i] - are[i] * sinT[i]) / m;
    re[i] = r;
    im[i] = s;
  }
}
