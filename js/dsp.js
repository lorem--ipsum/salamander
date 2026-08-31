// Everything that shapes the noise is expressed as a single magnitude curve in dB.
// Colour, equaliser, muffle and brightness all fold into the same function, which is
// what makes adding a new colour trivial and makes the on-screen curve exact.

export const EQ_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Slopes for the muffle / brightness pair, in dB per octave beyond the cutoff.
const LP_SLOPE = 12;
const HP_SLOPE = 12;

// Guard rails. Brown and black noise rise without bound towards DC; without a hard
// subsonic rolloff every scrap of headroom goes into bins no speaker can reproduce.
const SUB_F = 18;
const SUB_SLOPE = 36;
const ULTRA_F = 19000;
const ULTRA_SLOPE = 48;

/** A-weighting in dB. Grey noise is its inverse: equally loud to the ear at every frequency. */
function aWeightDb(f) {
  const f2 = f * f;
  const num = 12194 * 12194 * f2 * f2;
  const den =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);
  return 20 * Math.log10(num / den) + 2.0;
}

function greyDb(f) {
  return Math.max(-30, Math.min(30, -aWeightDb(f)));
}

/** A-weighting as a linear amplitude factor, for judging perceived loudness. */
export const aWeightAmp = (f) => Math.pow(10, aWeightDb(f) / 20);

/** Gaussian bell in log-frequency, used to give green noise its mid emphasis. */
function bellDb(f, { freq, gain, octaves }) {
  const x = Math.log2(f / freq) / octaves;
  return gain * Math.exp(-x * x);
}

// `exp` is the exponent on *amplitude*: amplitude is proportional to f^exp.
// Pink is -0.5 (-3 dB/oct in power), brown is -1 (-6 dB/oct).
export const COLORS = {
  brown: { label: 'Brown', exp: -1, blurb: 'Deep rumble, -6 dB/oct' },
  pink: { label: 'Pink', exp: -0.5, blurb: 'Balanced, -3 dB/oct' },
  white: { label: 'White', exp: 0, blurb: 'Flat and hissy' },
  black: { label: 'Black', exp: -2, blurb: 'Almost pure sub-bass' },
  grey: { label: 'Grey', exp: 0, grey: true, blurb: 'Perceptually flat' },
  green: {
    label: 'Green',
    exp: -0.5,
    bump: { freq: 500, gain: 6, octaves: 1.5 },
    blurb: 'Pink with a midrange lift',
  },
  blue: { label: 'Blue', exp: 0.5, blurb: 'Bright, +3 dB/oct' },
  violet: { label: 'Violet', exp: 1, blurb: 'Very bright, +6 dB/oct' },
};

function eqDbAt(f, eq) {
  const b = EQ_BANDS;
  if (f <= b[0]) return eq[0];
  if (f >= b[b.length - 1]) return eq[b.length - 1];
  let i = 0;
  while (i < b.length - 2 && f > b[i + 1]) i++;
  const t = (Math.log2(f) - Math.log2(b[i])) / (Math.log2(b[i + 1]) - Math.log2(b[i]));
  const s = t * t * (3 - 2 * t); // smoothstep, so the curve has no kinks at band centres
  return eq[i] + (eq[i + 1] - eq[i]) * s;
}

/** Target magnitude at frequency `f`, in dB relative to 1 kHz. */
export function magnitudeDb(f, s) {
  const c = COLORS[s.color] || COLORS.brown;
  let db = 20 * c.exp * Math.log10(f / 1000);
  if (c.grey) db += greyDb(f);
  if (c.bump) db += bellDb(f, c.bump);
  db += eqDbAt(f, s.eq);
  if (f > s.lowpass) db -= LP_SLOPE * Math.log2(f / s.lowpass);
  if (f < s.highpass) db -= HP_SLOPE * Math.log2(s.highpass / f);
  if (f < SUB_F) db -= SUB_SLOPE * Math.log2(SUB_F / f);
  if (f > ULTRA_F) db -= ULTRA_SLOPE * Math.log2(f / ULTRA_F);
  return db;
}

/**
 * Sample the curve at `count` log-spaced points between `fLo` and `fHi`.
 * The renderer interpolates this table across a million bins rather than
 * evaluating logs and powers per bin.
 */
export function sampleCurve(s, fLo, fHi, count) {
  const freq = new Float64Array(count);
  const db = new Float64Array(count);
  const amp = new Float64Array(count);
  const aw = new Float64Array(count);
  const logLo = Math.log(fLo);
  const step = (Math.log(fHi) - logLo) / (count - 1);
  for (let i = 0; i < count; i++) {
    const f = Math.exp(logLo + i * step);
    const d = magnitudeDb(f, s);
    freq[i] = f;
    db[i] = d;
    amp[i] = Math.pow(10, d / 20);
    aw[i] = aWeightAmp(f);
  }
  return { freq, db, amp, aw, logLo, step };
}
