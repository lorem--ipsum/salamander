// Offline renderer: build a spectrum, inverse-FFT it, write a WAV.
//
// The loop is seamless because an inverse FFT of length N produces a signal that is
// exactly periodic with period N. Wrapping from the last sample back to the first is
// mathematically continuous, so there is no click at the loop point.

import { fft, ifft } from './fft.js';
import { sampleCurve } from './dsp.js';

export const SAMPLE_RATE = 44100;
export const FRAMES = 1 << 20; // 23.8 s at 44.1 kHz
const CURVE_POINTS = 8192;

// Level is matched on A-weighted loudness, not raw RMS. Sub-bass carries enormous energy
// but almost no perceived loudness, so plain RMS normalisation made a bass boost quieten
// everything audible to keep the total constant.
const TARGET_LOUDNESS_DBFS = -30;
const PEAK_CEILING = 0.98;
// Noise wastes a lot of headroom on rare peaks. Everything below the knee passes through
// untouched and only the tips are rounded off, which on noise produces more noise rather
// than audible distortion, and buys several dB of real loudness.
const SOFT_KNEE = 0.75;
// How far past the ceiling the signal may be driven before shaping. Beyond this the
// rounding stops being subtle, so extreme sub-bass settings give up level instead of
// quietly turning into distortion.
const MAX_DRIVE = 1.5;

// A narrow band's envelope wanders at a rate set by its bandwidth. The bottom octave is
// only about 20 Hz wide, so it fluctuates at the 1-8 Hz rates the ear is most sensitive
// to, and brown noise puts most of its energy exactly there. That is the low-end
// pulsation. Each band is steadied against its own envelope: one wide band does not work,
// because a wide band fluctuates faster than any of its sub-bands and so matches none of
// them. Left and right are steadied separately too — with any stereo width their
// envelopes are independent signals.
const LOW_BAND_EDGES = [20, 50, 120, 300];
const LOW_EDGE_WIDTH = 1.25;
const LOW_WINDOW_SEC = 0.12;
// Short of fully flat: a narrow band with a perfectly constant envelope stops sounding
// like noise and starts sounding like a tone.
const LOW_STRENGTH = 0.85;

// A separate, much slower pass removes the multi-second swell whose return the ear would
// otherwise recognise as the loop point. It has to stay well below 0.5 Hz: smoothing near
// the ear's 4 Hz sensitivity peak creates pumping rather than removing it.
const SLOW_WINDOW_SEC = 2.5;
const SLOW_BLOCK = 256;

let scratch = null;
function buffers(n) {
  if (!scratch || scratch.re.length !== n) {
    scratch = {
      re: new Float64Array(n),
      im: new Float64Array(n),
      bandRe: new Float64Array(n),
      bandIm: new Float64Array(n),
    };
  }
  return scratch;
}

/** Circular Hann smoothing. Circular so the result stays exactly periodic. */
function smoothCircular(values, half) {
  const m = values.length;
  if (half < 1) return Float64Array.from(values);
  if (half > m >> 1) half = m >> 1;
  const win = new Float64Array(2 * half + 1);
  let winSum = 0;
  for (let j = -half; j <= half; j++) {
    const v = 0.5 * (1 + Math.cos((Math.PI * j) / (half + 1)));
    win[j + half] = v;
    winSum += v;
  }
  const out = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    let sum = 0;
    for (let j = -half; j <= half; j++) {
      let idx = k + j;
      if (idx < 0) idx += m;
      else if (idx >= m) idx -= m;
      sum += values[idx] * win[j + half];
    }
    out[k] = sum / winSum;
  }
  return out;
}

/** Turn an envelope into a levelling gain: mean over smoothed, raised to `strength`. */
function gainFromEnvelope(env, half, strength) {
  const m = env.length;
  const smooth = smoothCircular(env, half);
  let mean = 0;
  for (let k = 0; k < m; k++) mean += env[k];
  mean /= m;
  const gain = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const g = smooth[k] > 1e-12 ? mean / smooth[k] : 1;
    gain[k] = strength === 1 ? g : Math.pow(g, strength);
  }
  return gain;
}

/**
 * Rescale a gain curve so it leaves the band's total power alone. Levelling an envelope
 * otherwise shifts the band's energy slightly, which shows up as a dip in the response.
 */
function preserveBandPower(env, gain) {
  let before = 0;
  let after = 0;
  for (let i = 0; i < env.length; i++) {
    const e = env[i] * env[i];
    before += e;
    after += e * gain[i] * gain[i];
  }
  const scale = after > 0 ? Math.sqrt(before / after) : 1;
  for (let i = 0; i < gain.length; i++) gain[i] *= scale;
}

/**
 * Walk a gain curve of length m across n samples, calling `apply(i, g)` for each.
 * Both lengths are powers of two, so this steps segment by segment and interpolates
 * incrementally — a floor and a modulo per sample cost more than everything else here.
 */
function walkGain(gain, n, apply) {
  const m = gain.length;
  const stride = n / m;
  const inv = 1 / stride;
  for (let k = 0; k < m; k++) {
    const g0 = gain[k];
    const slope = ((k + 1 >= m ? gain[0] : gain[k + 1]) - g0) * inv;
    const start = k * stride;
    for (let j = 0; j < stride; j++) apply(start + j, g0 + slope * j);
  }
}

/** 0 below edge/width, 1 above edge*width. Complementary pairs sum to exactly 1. */
function edgeFade(f, edge, width) {
  const lo = edge / width;
  const hi = edge * width;
  if (f <= lo) return 0;
  if (f >= hi) return 1;
  const t = (Math.log(f) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return 0.5 * (1 - Math.cos(Math.PI * t));
}

/**
 * The band's true envelope, via its analytic signal at a decimated rate.
 *
 * Shifting the band's bins down to baseband and running a short inverse transform gives
 * the complex envelope directly, sampled across the whole loop. Taking the magnitude is
 * then exact — no carrier ripple to average away, which is what block-power estimates get
 * wrong at 20 Hz where a block holds a fraction of a cycle.
 */
function bandEnvelope(specRe, specIm, kLo, kHi, weights, points) {
  const br = new Float64Array(points);
  const bi = new Float64Array(points);
  for (let k = kLo; k <= kHi; k++) {
    const w = weights[k - kLo];
    if (w <= 0) continue;
    const idx = k - kLo;
    br[idx] = specRe[k] * w;
    bi[idx] = specIm[k] * w;
  }
  ifft(br, bi);
  const env = new Float64Array(points);
  for (let i = 0; i < points; i++) env[i] = Math.hypot(br[i], bi[i]);
  return env;
}

/** Steady each low band, per channel, adding back only the correction. */
function steadyLowEnd(re, im, low, band, n, df, durationSec, windowSec, strength) {
  const half = n >> 1;
  for (let b = 0; b < LOW_BAND_EDGES.length - 1; b++) {
    const lo = LOW_BAND_EDGES[b];
    const hi = LOW_BAND_EDGES[b + 1];
    const kLo = Math.max(1, Math.floor(lo / LOW_EDGE_WIDTH / df));
    const kHi = Math.min(half - 1, Math.ceil((hi * LOW_EDGE_WIDTH) / df), low.top);
    if (kHi <= kLo) continue;

    const count = kHi - kLo + 1;
    const weights = new Float64Array(count);
    for (let k = kLo; k <= kHi; k++) {
      const f = k * df;
      weights[k - kLo] = edgeFade(f, lo, LOW_EDGE_WIDTH) * (1 - edgeFade(f, hi, LOW_EDGE_WIDTH));
    }

    let points = 1;
    while (points < count) points <<= 1;
    const envHalf = Math.max(1, Math.round((windowSec * points) / durationSec / 2));
    const envL = bandEnvelope(low.lRe, low.lIm, kLo, kHi, weights, points);
    const envR = bandEnvelope(low.rRe, low.rIm, kLo, kHi, weights, points);
    const gainL = gainFromEnvelope(envL, envHalf, strength);
    const gainR = gainFromEnvelope(envR, envHalf, strength);
    preserveBandPower(envL, gainL);
    preserveBandPower(envR, gainR);

    // Full-rate band signal, repacked so one inverse transform yields both channels.
    band.re.fill(0);
    band.im.fill(0);
    for (let k = kLo; k <= kHi; k++) {
      const w = weights[k - kLo];
      if (w <= 0) continue;
      const lr = low.lRe[k];
      const li = low.lIm[k];
      const rr = low.rRe[k];
      const ri = low.rIm[k];
      band.re[k] = (lr - ri) * w;
      band.im[k] = (li + rr) * w;
      band.re[n - k] = (lr + ri) * w;
      band.im[n - k] = (rr - li) * w;
    }
    ifft(band.re, band.im);

    walkGain(gainL, n, (i, g) => {
      re[i] += band.re[i] * (g - 1);
    });
    walkGain(gainR, n, (i, g) => {
      im[i] += band.im[i] * (g - 1);
    });
  }
}

/** Remove the slow swell that would otherwise make the loop point recognisable. */
function flattenSlowSwell(re, im, sampleRate) {
  const n = re.length;
  const m = Math.max(8, Math.floor(n / SLOW_BLOCK));
  const envL = new Float64Array(m);
  const envR = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    let sl = 0;
    let sr = 0;
    const start = k * SLOW_BLOCK;
    for (let i = start; i < start + SLOW_BLOCK; i++) {
      sl += re[i] * re[i];
      sr += im[i] * im[i];
    }
    envL[k] = Math.sqrt(sl / SLOW_BLOCK);
    envR[k] = Math.sqrt(sr / SLOW_BLOCK);
  }
  const half = Math.max(1, Math.round((SLOW_WINDOW_SEC * sampleRate) / SLOW_BLOCK / 2));
  const gainL = gainFromEnvelope(envL, half, 1);
  const gainR = gainFromEnvelope(envR, half, 1);
  walkGain(gainL, n, (i, g) => {
    re[i] *= g;
  });
  walkGain(gainR, n, (i, g) => {
    im[i] *= g;
  });
}

/** Linear below the knee, smoothly asymptotic to the ceiling above it. */
function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= SOFT_KNEE) return x;
  const span = PEAK_CEILING - SOFT_KNEE;
  const y = SOFT_KNEE + span * Math.tanh((a - SOFT_KNEE) / span);
  return x < 0 ? -y : y;
}

function writeWav(left, right, gain, sampleRate) {
  const frames = left.length;
  const dataBytes = frames * 4; // stereo, 16-bit
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const tag = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);

  const pcm = new Int16Array(buf, 44, frames * 2);
  let shaped = 0;
  let outPower = 0;
  for (let i = 0, j = 0; i < frames; i++) {
    const rawL = left[i] * gain;
    const rawR = right[i] * gain;
    if (rawL > SOFT_KNEE || rawL < -SOFT_KNEE) shaped++;
    if (rawR > SOFT_KNEE || rawR < -SOFT_KNEE) shaped++;
    const l = softClip(rawL);
    const r = softClip(rawR);
    outPower += l * l + r * r;
    pcm[j++] = l < 0 ? l * 0x8000 : l * 0x7fff;
    pcm[j++] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }
  return {
    blob: new Blob([buf], { type: 'audio/wav' }),
    shapedFraction: shaped / (frames * 2),
    // Measured after shaping, so the reported level is what actually leaves the file.
    outRms: Math.sqrt(outPower / (frames * 2)),
  };
}

/**
 * Render one seamless loop of shaped noise.
 * Returns a blob URL plus measurements the UI can display.
 */
export function renderLoop(
  settings,
  {
    frames = FRAMES,
    sampleRate = SAMPLE_RATE,
    steadyLow = true,
    flatten = true,
    lowWindowSec = LOW_WINDOW_SEC,
    lowStrength = LOW_STRENGTH,
  } = {},
) {
  const t0 = performance.now();
  const n = frames;
  const half = n >> 1;
  const df = sampleRate / n;
  const durationSec = n / sampleRate;
  const { re, im, bandRe, bandIm } = buffers(n);
  re.fill(0);
  im.fill(0);

  // Per-channel spectra are kept for the low bins only — about 1% of them — because the
  // main inverse transform destroys the packed spectrum, and the low-band correction
  // needs each channel separately.
  const topBin = Math.min(
    half - 1,
    Math.ceil((LOW_BAND_EDGES[LOW_BAND_EDGES.length - 1] * LOW_EDGE_WIDTH) / df),
  );
  const low = steadyLow
    ? {
        top: topBin,
        lRe: new Float64Array(topBin + 1),
        lIm: new Float64Array(topBin + 1),
        rRe: new Float64Array(topBin + 1),
        rIm: new Float64Array(topBin + 1),
      }
    : null;

  const table = sampleCurve(settings, df, sampleRate / 2, CURVE_POINTS);
  const { amp, aw, logLo, step } = table;
  // Parseval: summing over bins gives the flat and A-weighted power of the result
  // exactly, with no need to filter the signal afterwards.
  let flatPower = 0;
  let weightedPower = 0;
  const last = CURVE_POINTS - 1;
  const logDf = Math.log(df);
  const width = settings.width;

  for (let k = 1; k < half; k++) {
    let pos = (logDf + Math.log(k) - logLo) / step;
    if (pos < 0) pos = 0;
    else if (pos > last) pos = last;
    const i0 = pos | 0;
    const frac = pos - i0;
    const a = i0 >= last ? amp[last] : amp[i0] + (amp[i0 + 1] - amp[i0]) * frac;
    const wgt = i0 >= last ? aw[last] : aw[i0] + (aw[i0 + 1] - aw[i0]) * frac;
    flatPower += a * a;
    weightedPower += a * a * wgt * wgt;

    const pl = Math.random() * 2 * Math.PI;
    const pr = pl + width * (Math.random() * 2 * Math.PI - Math.PI);
    const lr = a * Math.cos(pl);
    const li = a * Math.sin(pl);
    const rr = a * Math.cos(pr);
    const ri = a * Math.sin(pr);

    // Z[k] = L[k] + i*R[k], with both spectra Hermitian-symmetric, so one complex
    // inverse transform yields left in the real part and right in the imaginary part.
    re[k] = lr - ri;
    im[k] = li + rr;
    re[n - k] = lr + ri;
    im[n - k] = rr - li;

    if (low && k <= topBin) {
      low.lRe[k] = lr;
      low.lIm[k] = li;
      low.rRe[k] = rr;
      low.rIm[k] = ri;
    }
  }

  ifft(re, im);
  if (low) {
    steadyLowEnd(re, im, low, { re: bandRe, im: bandIm }, n, df, durationSec, lowWindowSec, lowStrength);
  }
  if (flatten) flattenSlowSwell(re, im, sampleRate);

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const l = re[i];
    const r = im[i];
    sum += l * l + r * r;
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }
  const rms = Math.sqrt(sum / (2 * n)) || 1e-12;

  // How much quieter this spectrum sounds than its raw level suggests.
  const weighting = flatPower > 0 ? Math.sqrt(weightedPower / flatPower) : 1;
  const target = Math.pow(10, (TARGET_LOUDNESS_DBFS + settings.volumeDb) / 20);
  let gain = target / (rms * weighting);
  const driveCap = (MAX_DRIVE * PEAK_CEILING) / peak;
  if (gain > driveCap) gain = driveCap;

  const { blob, shapedFraction, outRms } = writeWav(re, im, gain, sampleRate);
  return {
    url: URL.createObjectURL(blob),
    frames: n,
    sampleRate,
    durationSec,
    peak: Math.min(PEAK_CEILING, peak * gain),
    shapedFraction,
    rmsDbfs: 20 * Math.log10(outRms),
    loudnessDbfs: 20 * Math.log10(outRms * weighting),
    renderMs: performance.now() - t0,
  };
}

/** A fraction of a second of silence, used to unlock the audio elements on iOS. */
export function silentWavUrl() {
  const frames = 2048;
  const silent = new Float64Array(frames);
  const { blob } = writeWav(silent, silent, 1, 8000);
  return URL.createObjectURL(blob);
}
