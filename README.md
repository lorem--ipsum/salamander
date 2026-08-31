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

### Holding the lock screen

Playing several elements at once is what fixes the audio, but it fights how iOS decides
which page owns the Now Playing controls. Two failures came out of testing on an actual
phone, and both are about the session rather than the sound:

- **Controls showed "paused" while audio was clearly playing.** iOS picks its Now Playing
  source from playback activity, and the spare elements were being unlocked *after* the
  audible ones — so the last thing iOS saw was an element playing and immediately pausing.
  The spares are now unlocked first, and muted, so they never claim the lock screen.
- **Pause then play stopped working, and the controls handed over to Music.** Pausing
  stopped every element, so for a moment nothing at all was playing and iOS tore the audio
  session down. A backgrounded page cannot get it back. A silent keep-alive element now
  starts *before* the voices stop, so something always holds the session; it is released
  again only once the voices are running. It is deliberately unmuted, because a muted
  element does not hold a session — its content is silence, so nothing is heard.

Holding the session turned out not to be enough on its own. Testing on the phone again: the
state showed correctly and playback resumed fine, but the lock-screen controls still slid
over to Music. The keep-alive was being started on pause and then *stopped* again once the
voices were running, so the page still had brief moments with no media playing — and iOS
uses exactly those moments to reassign the slot.

So the keep-alive is never stopped. Once the user has started playback it runs for the life
of the page, silent, through both playing and paused states. The page therefore always has
media playing, iOS never gets an opening, and the keep-alive — rather than voices that come
and go — is the stable thing the lock screen attaches to. A watchdog restarts it if anything
else pauses it, because iOS pauses the element it is tracking when the lock-screen pause is
used, and that can catch the keep-alive too.

It gets its playback grant from its own start call inside the tap. Playback state is also
re-asserted shortly after starting, because iOS settles Now Playing asynchronously and can
overwrite a state set too early.

The cost is that a silent element plays for as long as the page is open, including while
paused. That is the price of controls that keep working.

### Changing a setting hands over at silence

Each voice keeps two elements, but the exchange cannot happen just anywhere. A voice is
already faded to silence at the ends of its file, and that is the only place it can be
swapped for free. Getting this wrong was audible as cracks and a jumping level when moving
an equaliser slider:

- Starting the replacement at its stagger offset meant two of the three voices began at
  `sin(pi/3)` — 87% of full scale — instantly. Silence to near-full in one sample is a click.
- Stopping the outgoing voice mid-envelope dropped full scale to zero. Another click.
- Overlapping the two while both played put that voice at +3 dB until the old one stopped,
  and with three voices doing it at different moments the level stepped around.

Now every replacement is preloaded, then each voice is held until it approaches the end of
its file. Polling only has to get close; the exchange itself is then timed to land about
80 ms from the end. Overshooting is harmless — the far side of the loop point is just as
silent — so it can aim tight rather than settle for wherever a polling tick happens to fall.
The outgoing element stops and the replacement starts from zero, both at silence, which also
preserves the phase and so the stagger.

Measured, worst discontinuity at any handover:

| | worst |
|---|---|
| starting at the stagger offset | -1.2 dB (87% of full scale) |
| swapping within a 0.6 s tail | -22 dB |
| timed to ~80 ms from the end | **-38.5 dB** |

On the real output across a slider change the level stays within +/-1.14 dB, and the largest
step between 43 ms blocks is 1.76 dB — ordinary brown-noise variation rather than a jump.

### Several silent points per loop, so changes land quickly

Waiting for a voice to fall silent is only slow if it is silent rarely. With a single-lobe
`sin(pi*t/T)` envelope a voice is quiet just twice per file, so a change took a whole loop —
about 24 seconds — which is far too slow to dial in an equaliser.

The constant-sum property does not actually require one lobe. Summing `sin^2` at V equally
spaced phases stays constant for **any** lobe count k, as long as V does not divide k. So each
voice now has four lobes against three voices: it passes through silence four times per loop
and can be exchanged at any of them.

Measured, the same slider change:

| | first change | fully applied |
|---|---|---|
| one lobe | 8.0 s | 24 s |
| four lobes | 2.6 s | **6.5 s** |

Worst discontinuity is -34 dB, and across the change the output level holds within about
1 dB with a largest 43 ms step of 1.4 dB — ordinary noise variation. A single voice now
swings 22.5 dB as its lobes come and go, while the sum of the three stays flat to 0.96 dB.

The lobe count cannot climb without limit. Drift between voices shows up as a level ripple at
the lobe rate, and the faster that rate the more audible it becomes over a long night. Four
lobes puts any realistic overnight drift well under half a dB; eight would halve the latency
again and roughly double that ripple.

The transport says "easing in..." while a change is landing, because otherwise even a couple
of seconds reads as the app ignoring the slider.

### The curve shows what is audible, not what was asked for

Because voices take a change one at a time, part way through a change the sound really is a
mixture of old and new settings — and since voices sum as power, the audible spectrum is
their power average. That is what the response curve draws, stepping toward the new shape as
each voice hands over. The target is drawn behind it as a faint dashed line, which disappears
once everything has converged.

The settings behind each render travel with it rather than sitting in a shared variable.
Rendering blocks for a while, so moving a slider again during it means a handover from the
previous render can land while a newer one is already in flight; reading shared state there
credits a voice with settings it is not playing, and the display runs ahead of the sound.

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

- There is a known bug where lock-screen buttons stop responding after audio has been
  **paused** for a while in a home-screen web app. The silent keep-alive above should hold
  the session open through that, but if the controls ever do go dead, opening the site in
  Safari rather than from the home-screen icon avoids it. It does not affect continuous
  playback either way.
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
