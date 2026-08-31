# Salamander

A noise generator built for one job: run all night on a locked iPhone, through a Bluetooth
speaker, and mask the bass coming through the wall.

No build step, no dependencies, no framework. Plain static files.

## Why it is built this way

The obvious approach — a realtime Web Audio graph with a noise source and biquad filters —
does not survive an iPhone going to sleep. Two iOS constraints drive the whole design:

- **`AudioContext` is suspended the moment the screen locks or Safari backgrounds.** A
  realtime graph goes silent within seconds of putting the phone down.
- **`HTMLMediaElement.volume` is not settable on iOS.** It always reads `1`. So there is no
  JavaScript gain, no JavaScript crossfade, and no JavaScript fade-out.

What *does* keep playing on a locked phone is an ordinary `<audio>` element playing real
media — the same thing every web podcast player relies on. So Salamander renders the noise
offline into a seamlessly-loopable WAV, plays it through `<audio loop>`, and bakes the
master volume into the samples.

### The loop is seamless by construction

Rather than filtering a noise source, the spectrum is built directly and inverse-FFT'd. An
inverse FFT of length `N` produces a signal that is exactly periodic with period `N`, so
wrapping from the last sample back to the first is mathematically continuous. There is no
click at the loop point — no crossfade, no overlap-add, no fudging.

It also means the noise colour, the equaliser, the muffle and the brightness are all the
same mechanism: a magnitude curve. The curve drawn on screen is literally the curve applied.

Left and right get independent random phase, blended by the width control, which is what
makes it sound wide and enveloping on a speaker rather than like a point source.

### Level is matched on loudness, not energy

Sub-bass carries enormous energy but almost no perceived loudness. Normalising on plain RMS
therefore made a bass boost quieten everything audible in order to hold the total constant —
turning the bottom band up made the whole thing sound *quieter*. Levels are now matched on
**A-weighted** loudness, computed analytically from the spectrum via Parseval rather than by
filtering the signal afterwards. Every colour and preset lands within a fraction of a dB of
the same perceived loudness, and the lowest band can be pushed to +9 dB without the audible
level moving at all.

Rare peaks are rounded off with a soft knee rather than hard-clipped, which on noise produces
more noise instead of audible distortion and buys several dB of real level. Drive into that
knee is capped, so genuinely extreme sub-bass settings give up loudness rather than quietly
turning to mush.

### The low end does not pulse

A narrow band's envelope wanders at a rate set by its bandwidth. The bottom octave is only
about 20 Hz wide, so it fluctuates at the 1-8 Hz rates the ear is most sensitive to, and
brown noise puts most of its energy exactly there. Measured on unprocessed noise, modulation
depth in that range runs 35% at 18-40 Hz and falls monotonically to 7% by 1.5 kHz — which is
why the pulsing is heard on the low end specifically and nowhere else.

Each low band is now levelled against its **own** envelope. Two details matter and both were
got wrong first time round:

- **One wide band does not work.** A wide band's envelope fluctuates faster than any of its
  sub-bands, so a single correction matches none of them and smears fluctuation into
  neighbours that were fine.
- **Left and right need separate gains.** At any stereo width their envelopes are independent
  signals, so a gain derived from their combined power flattens neither.

The envelope itself comes from the band's analytic signal, obtained by shifting its bins to
baseband and running a short inverse transform. That is exact and free of carrier ripple —
block-power estimates fall apart at 20 Hz, where a block holds a fraction of a cycle. Each
gain curve is then rescaled to preserve band power, so levelling does not bend the response.

This takes 18-40 Hz from about 35% down to 28%. The floor is real: noise has a fluctuating
envelope by definition, and flattening a narrow band completely stops it sounding like noise
at all, which is why the correction stops at 85% strength.

### The loop point is not audible

The waveform is continuous at the seam by construction, but that was not enough: noise wanders
several dB over seconds, and because that wander repeats with the loop, the ear recognised the
returning swell and heard it *as* the loop point. The slow envelope is now divided out, measured
circularly so the signal stays exactly periodic. The level step across the loop is 0.36 dB
against an 0.89 dB median for ordinary moments in the file — the seam is a smaller event than
86% of the rest of the noise. It also masks more evenly and sits louder for the same peak.

### The player's own looping is not gapless — the voices fade around it

Making the *file* loop seamlessly turned out to be the easy half. A media element's `loop`
attribute is not gapless: measured in Chrome with no Web Audio anywhere near the path, by
comparing media time against the wall clock, it **stalls for about 95 ms at every restart**.
Over 30 seconds of wall clock only 29.1 seconds of audio played. That is heard as a cut once
per loop, and it is the restart itself rather than the source — blob: and data: URLs stall
alike.

Nothing can be scheduled in JavaScript to cover it, because JavaScript is frozen once the
phone is locked, and there is no volume to automate either — iOS ignores it. So the crossfade
is baked into the audio itself. Each voice is multiplied by `sin(pi*t/T)`: silent at both ends
of its file, peak in the middle. **The stall then happens while that voice is already
silent.** Several voices play at once, evenly staggered, and `sin^2` sampled at V equally
spaced phases sums to `V/2` — a mathematically constant total, for any V >= 2. No mixer, no
volume, no JavaScript.

Simply overlapping voices at full level is not enough, and the reason is worth recording.
Averaged over the stall the total only dips by `10*log10(V/(V-1))`, which is 1.8 dB at three
voices and sounds harmless on paper. But the voices are uncorrelated, so when the momentarily
loudest one drops out the instantaneous hole is far deeper. Measured against an identical mix
with no stall, block by block:

| | mean drop | worst 5 ms block |
|---|---|---|
| flat voices | -2.87 dB | **-9.72 dB** |
| faded voices | -0.05 dB | **-0.16 dB** |

Three faded voices sum to within 0.08 dB of a single flat voice at full level, so the
arrangement costs nothing in loudness.

### Changing a setting does not produce a gap

Each voice keeps two elements, ping-ponged. A new loop is preloaded and started *before* the
old one is paused, so there is never a moment of silence, and the stagger is re-established
on every swap.

## Running it locally

```bash
python3 -m http.server 8123
```

Then open <http://127.0.0.1:8123>. It needs to be served over HTTP — opening `index.html`
as a `file://` URL will not work, because it uses ES modules.

Note that the Media Session API needs a secure context, so **lock-screen controls will not
appear over plain HTTP on a LAN address**. That part only works once it is on HTTPS.

## Putting it on the iPhone

GitHub Pages is the simplest host. From this directory:

```bash
gh repo create salamander --private --source=. --remote=origin --push
```

Then enable Pages on the `main` branch at the repository root:

```bash
gh api -X POST repos/{owner}/salamander/pages -f "source[branch]=main" -f "source[path]=/"
```

Give it a minute, then open `https://<your-github-username>.github.io/salamander/` on the
iPhone. Tap Share → **Add to Home Screen** for a full-screen launcher with the icon.

A private repository needs a paid GitHub plan to serve Pages. If yours is on the free plan,
drop `--private` and make it public — there is nothing sensitive here.

## Using it at night

Start it, then lock the phone. The lock screen and Control Center get play/pause controls,
and it keeps going over Bluetooth.

**To stop it after a while, use the iPhone's own timer:** Clock → Timer → When Timer Ends →
*Stop Playing*. There is deliberately no sleep timer in the app, because a JavaScript timer
cannot be trusted once the screen is locked — iOS throttles or freezes it. The system timer
is the reliable tool and it already exists.

The **Bass Mask** preset is the one aimed at the actual problem: a brown-noise
base with 40–125 Hz pushed up to sit on top of the intruding bass, and everything above
4 kHz rolled off so it is not hissy. Start there and adjust the low bands to taste.

## Known iOS quirks

- If lock-screen buttons stop responding after the audio has been **paused** for around 30
  seconds, that is a known bug with home-screen web apps. Opening the site in Safari instead
  of from the home-screen icon avoids it. It does not affect continuous playback.
- Master volume is baked into the render, so it only takes effect after the loop is
  re-rendered (a fraction of a second). The real night-time control is the phone or speaker
  volume; the in-app slider sets the headroom.
- There is no offline caching, so the page needs a network connection to *start*. Once it is
  playing, the connection is no longer needed.

## Layout

```
index.html              markup, PWA metadata, icon links
app.css                 dark theme, large touch targets, safe-area insets
js/fft.js               iterative radix-2 complex FFT / inverse FFT
js/dsp.js               colour curves, equaliser, filters -> magnitude curve in dB
js/render.js            spectrum -> inverse FFT -> normalise -> 16-bit WAV
js/player.js            two-element ping-pong, iOS unlock, Media Session
js/presets.js           built-in presets, user presets in localStorage
js/ui.js                controls and the response-curve canvas
js/main.js              wiring
tools/make-icons.mjs    regenerates the PNG icons (no dependencies)
```

Regenerate the icons after changing the design:

```bash
node tools/make-icons.mjs
```

## Tuning

`FRAMES` in `js/render.js` sets the loop length — currently `2^20`, about 23.8 seconds at
44.1 kHz, rendering in roughly 210 ms for a 4 MB file. Doubling it makes repetition harder to
notice, at double the render time and memory; the per-band low-end work costs three extra
inverse transforms, so this is no longer nearly free.

`TARGET_LOUDNESS_DBFS` sets the A-weighted loudness every render is matched to, currently
`-30`. `SOFT_KNEE` and `MAX_DRIVE` control the peak shaping. `renderLoop` reports
`shapedFraction`: if raising the target pushes that past a few percent on settings you
actually use, you are trading audible quality for level.

`LOW_BAND_EDGES`, `LOW_WINDOW_SEC` and `LOW_STRENGTH` control the low-end steadying.
Shortening the window past about 0.1 s buys very little and starts bending the response;
pushing strength to 1.0 makes narrow bands sound tonal rather than noisy.

`SLOW_WINDOW_SEC` is the separate, much slower pass that kills the loop-point swell, currently
`2.5` s. Keep it well below 0.5 Hz in effect: smoothing anywhere near the ear's 4 Hz
sensitivity peak creates pumping instead of removing it, which is exactly what an earlier
0.35 s broadband version did.

The layout is tuned for an iPhone 13 mini (375 × 812 CSS px). Transport, pickers, response
curve and equaliser all land above the fold; shaping scrolls into view.
