// Iterative radix-2 Cooley-Tukey FFT over separate real/imaginary Float64Arrays.
//
// Twiddle factors are precomputed per transform size rather than accumulated by
// recurrence: at n = 2^20 the recurrence drifts far enough to smear the spectrum.

const twiddleCache = new Map();

function twiddles(n) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let j = 0; j < half; j++) {
    const a = (-2 * Math.PI * j) / n;
    cos[j] = Math.cos(a);
    sin[j] = Math.sin(a);
  }
  t = { cos, sin };
  twiddleCache.set(n, t);
  return t;
}

/** Forward FFT, in place. Length must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let base = 0; base < n; base += len) {
      for (let j = 0, tw = 0; j < half; j++, tw += stride) {
        const wr = cos[tw];
        const wi = sin[tw];
        const a = base + j;
        const b = a + half;
        const br = re[b];
        const bi = im[b];
        const vr = br * wr - bi * wi;
        const vi = br * wi + bi * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

/** Inverse FFT, in place, via conj -> forward -> conj -> scale. */
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const s = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= s;
    im[i] *= -s;
  }
}
