// Playback runs through ordinary <audio> elements, not a Web Audio graph, because iOS
// suspends AudioContext the moment the screen locks. A media element keeps going, which
// is the whole point of this app.
//
// But a media element's own `loop` is NOT gapless. Measured in Chrome with no Web Audio
// anywhere near the path — comparing media time against the wall clock — it stalls for
// about 95 ms at every restart, which is heard as a cut once per loop. It is the restart
// itself, not the source: blob: and data: URLs stall alike. Nothing can be scheduled in
// JavaScript to cover it either, because JavaScript is frozen once the phone is locked.
//
// So several independent loops play at once, evenly staggered. When one stalls the others
// are mid-file, and the level dips by 10*log10(V/(V-1)) dB instead of dropping out — 1.8 dB
// at three voices, which measures no deeper than the noise's own natural minima. Each voice
// is rendered 10*log10(V) dB down so they sum to the intended level.
//
// Each voice keeps two elements so a settings change can be preloaded and started before
// the old one is paused, leaving no gap there either.

import { ENVELOPE_LOBES, silentWavUrl } from './render.js';

export const VOICES = 3;

// Coarse polling only has to get near the end of a voice's file; the exchange itself is
// then timed. Overshooting is harmless — the far side of the loop point is just as silent —
// so this aims to land TARGET_LEAD_SEC from the end, where the envelope is about -40 dB on
// a 24 s loop, rather than settling for whatever a polling tick happens to catch.
const ARM_WITHIN_SEC = 0.8;
// Lobes are shorter than a whole file, so the envelope climbs away from each zero faster
// and the exchange has to be timed tighter to stay equally quiet.
const TARGET_LEAD_SEC = 0.03;
const POLL_MS = 50;

const ARTWORK = [
  // iOS before 18 uses the *first* entry and greys out anything over 128 px, so the
  // small one has to lead. iOS 18+ picks the 512 correctly.
  { src: 'icon-96.png', sizes: '96x96', type: 'image/png' },
  { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
];

function once(el, events, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      for (const e of events) el.removeEventListener(e, handler);
      clearTimeout(timer);
      resolve(why);
    };
    const handler = (ev) => finish(ev.type);
    for (const e of events) el.addEventListener(e, handler);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

export class Player {
  constructor({ onStateChange, onError, onTransition } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});
    this.onTransition = onTransition || (() => {});
    this.swapGeneration = 0;
    this.swapTimer = null;
    this.voices = [];
    for (let v = 0; v < VOICES; v++) {
      this.voices.push({
        els: [this.#makeElement(), this.#makeElement()],
        active: 0,
        urls: [null, null],
        armed: false,
        armTimer: null,
      });
    }
    // Silent, and playing whenever the voices are not. iOS tears down the Now Playing
    // session the moment nothing at all is playing, and a backgrounded page cannot get it
    // back — the lock screen goes dead and hands over to Music. Something must always hold it.
    this.silentUrl = null;
    this.keeper = this.#makeElement();
    this.keeper.dataset.role = 'keeper';
    this.keeper.addEventListener('pause', () => {
      // iOS pauses the element it is tracking when the lock-screen pause is used, which
      // can catch the keeper too. Put it straight back, slightly deferred so we are not
      // fighting iOS inside its own event.
      if (!this.holdSession) return;
      setTimeout(() => {
        if (this.holdSession && this.keeper.paused) this.#startKeeper();
      }, 120);
    });

    this.unlocked = false;
    this.wantPlaying = false;
    this.reassert = null;
    // Once the user has started us, this page must never again have a moment with no
    // media playing at all — that is the gap iOS uses to hand the lock screen to Music.
    this.holdSession = false;
    this.swapping = false;
    this.trackName = 'Noise';
    this.durationSec = 0;

    document.addEventListener('visibilitychange', () => {
      // Recover from interruptions (an alarm, a call) once we are back in the foreground.
      if (document.visibilityState !== 'visible' || !this.wantPlaying) return;
      for (const voice of this.voices) {
        const el = voice.els[voice.active];
        if (el.paused) el.play().catch(() => {});
      }
    });
  }

  #makeElement() {
    const el = document.createElement('audio');
    el.loop = true; // native looping — a JS 'ended' handler would stall on a locked phone
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.addEventListener('play', () => this.#sync());
    el.addEventListener('pause', () => this.#sync());
    el.addEventListener('error', () => {
      if (el.src) this.onError(el.error ? el.error.message : 'audio element error');
    });
    document.body.appendChild(el);
    return el;
  }

  /** The element currently carrying each voice. */
  get live() {
    return this.voices.map((v) => v.els[v.active]);
  }

  get playing() {
    return this.live.some((el) => !el.paused);
  }

  #sync() {
    if (this.swapping) return;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
    this.onStateChange(this.playing);
  }

  #setMetadata() {
    if (!('mediaSession' in navigator)) return;
    // Deliberately no seek handlers: registering them makes iOS hide the transport
    // buttons entirely. No album either — setting artist suppresses it on iOS anyway.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.trackName,
      artist: 'Salamander',
      artwork: ARTWORK,
    });
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('stop', () => this.pause());
  }

  setTrackName(name) {
    this.trackName = name;
    if (this.playing) this.#setMetadata();
  }

  /** Stagger the voices so their loop seams never coincide. */
  #offsetFor(index) {
    return this.durationSec ? (this.durationSec * index) / VOICES : 0;
  }

  /**
   * Swap in freshly rendered loops — one per voice — without a click or a level jump.
   *
   * Every voice is already faded to silence at the ends of its file, so that is the only
   * place it can be exchanged for free. Starting a replacement anywhere else jumps from
   * silence to whatever the envelope is at that point — 87% of full scale at a third of
   * the way in — and stopping the outgoing one mid-envelope drops full scale to zero.
   * Both are clicks. Overlapping them instead is worse: the voice runs at +3 dB until the
   * old one stops, and with three voices doing that at different moments the level steps
   * around.
   *
   * So each voice is preloaded, then held until it reaches its own quiet tail, and only
   * then exchanged: the outgoing one is stopped and the replacement started from zero,
   * both at silence, keeping the phase and so the stagger. A voice reaches that point once
   * per loop and they are staggered, so a change lands in three steps roughly T/V apart.
   */
  async load(urls, durationSec) {
    this.durationSec = durationSec || this.durationSec;
    const generation = ++this.swapGeneration;
    clearInterval(this.swapTimer);
    for (const voice of this.voices) {
      clearTimeout(voice.armTimer);
      voice.armed = false;
    }

    // Preload everything first, so a voice can hand over the moment it goes quiet rather
    // than starting to fetch and decode at that point.
    await Promise.all(
      this.voices.map(async (voice, index) => {
        const next = voice.els[1 - voice.active];
        next.muted = false;
        const ready = once(next, ['canplaythrough', 'canplay', 'loadeddata'], 4000);
        next.src = urls[index];
        next.load();
        await ready;
      }),
    );
    if (generation !== this.swapGeneration) return;

    if (!this.playing) {
      // Nothing audible yet, so take the new loops at once and set the stagger directly.
      this.voices.forEach((voice, index) => {
        const next = voice.els[1 - voice.active];
        try {
          next.currentTime = this.#offsetFor(index);
        } catch {
          /* metadata not in yet; the stagger is re-established on the next handover */
        }
        this.#commit(voice, index, urls[index]);
      });
      this.#sync();
      return;
    }
    this.#handOverWhenQuiet(generation, urls);
  }

  #commit(voice, index, url) {
    const previous = voice.urls[1 - voice.active];
    voice.urls[1 - voice.active] = url;
    voice.active = 1 - voice.active;
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
  }

  #handOverWhenQuiet(generation, urls) {
    const pending = new Set(this.voices.map((_, i) => i));
    this.onTransition(true);
    // If a voice never reports a quiet point — a stalled element, a throttled tab — take
    // the small artifact rather than leaving the change permanently unapplied.
    const deadline = performance.now() + Math.max(5000, (this.durationSec || 24) * 2000);

    this.swapTimer = setInterval(() => {
      if (generation !== this.swapGeneration) {
        clearInterval(this.swapTimer);
        return;
      }
      const forced = performance.now() > deadline;
      for (const index of [...pending]) {
        const voice = this.voices[index];
        if (voice.armed) continue;
        const old = voice.els[voice.active];
        const total = old.duration || this.durationSec;
        // A voice is silent at every lobe boundary, not just at the end of its file, so
        // wait only for the next one of those.
        const lobe = total / ENVELOPE_LOBES;
        const remaining = total ? lobe - (old.currentTime % lobe) : 0;
        if (total && !old.paused && !forced && remaining > ARM_WITHIN_SEC) continue;

        // Close enough to time the exchange precisely instead of waiting for a tick.
        voice.armed = true;
        const wait = forced || !total || old.paused ? 0 : Math.max(0, (remaining - TARGET_LEAD_SEC) * 1000);
        voice.armTimer = setTimeout(() => {
          voice.armed = false;
          if (generation !== this.swapGeneration) return;
          const next = voice.els[1 - voice.active];
          try {
            // Start from zero: that is a lobe boundary too, so the envelope carries on
            // from silence exactly as it would have, and the stagger survives.
            next.currentTime = 0;
          } catch {
            /* not fatal: it plays from wherever it is */
          }
          next.play().catch(() => {});
          voice.els[voice.active].pause();
          this.#commit(voice, index, urls[index]);
          pending.delete(index);
          if (!pending.size) {
            clearInterval(this.swapTimer);
            this.onTransition(false);
            this.#sync();
          }
        }, wait);
      }
    }, POLL_MS);
  }

  /**
   * iOS grants playback permission per element, and only for a play() call made in the
   * same synchronous turn as the user's tap. Every element therefore gets its grant here,
   * so later swaps are allowed to call play() programmatically.
   *
   * They are unlocked *muted*, and before the audible elements start. iOS picks its Now
   * Playing source from playback activity, so an unmuted element that plays and then
   * immediately pauses can end up owning the lock screen and showing "paused" over audio
   * that is still running.
   */
  #unlockIdle() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (!this.silentUrl) this.silentUrl = silentWavUrl();
    // The keeper is not in this list: it takes its grant from its own start call, which
    // also happens inside the tap. Unlocking it here would pause it a moment later and
    // fight the very thing it exists to do.
    const spares = this.voices.map((voice) => voice.els[1 - voice.active]);
    for (const el of spares) {
      el.muted = true;
      if (!el.src) el.src = this.silentUrl;
      el.play()
        .then(() => el.pause())
        .catch(() => {});
    }
  }

  /**
   * Hold the audio session open with silence so the lock screen stays ours. Unmuted on
   * purpose: a muted element does not hold an audio session, and the content is silence
   * anyway, so nothing is heard.
   */
  #startKeeper() {
    if (!this.silentUrl) this.silentUrl = silentWavUrl();
    if (!this.keeper.src) this.keeper.src = this.silentUrl;
    this.keeper.muted = false;
    this.keeper.loop = true;
    return this.keeper.play().catch(() => {});
  }

  async play() {
    this.wantPlaying = true;
    this.#setMetadata();
    // Order matters. Unlock the muted spares first so the LAST playback iOS sees is an
    // audible voice — that is what it attaches the lock screen to. Every play() has to be
    // issued before the first await, while still inside the tap.
    this.#unlockIdle();
    this.holdSession = true;
    this.#startKeeper();
    const started = this.live.map((el) => {
      el.muted = false;
      return el.play();
    });
    try {
      await Promise.all(started);
      this.onError(null);
    } catch (err) {
      this.wantPlaying = false;
      this.onError(err.message || 'playback was blocked');
    }
    // The keeper is deliberately NOT stopped. It is silent, and leaving it running means
    // this page always has media playing, so iOS never gets an opening to reassign the
    // lock screen. It also makes the keeper the stable thing iOS attaches to, rather than
    // voices that come and go.
    this.#setMetadata();
    this.#sync();
    // iOS settles Now Playing asynchronously and can overwrite a state set this early,
    // leaving the lock screen showing "paused" over audio that is plainly running.
    clearTimeout(this.reassert);
    this.reassert = setTimeout(() => {
      if (!this.wantPlaying) return;
      this.#setMetadata();
      this.#sync();
    }, 700);
  }

  async pause() {
    this.wantPlaying = false;
    this.holdSession = true;
    // Start the silence BEFORE stopping the voices: if nothing at all is playing, even
    // for an instant, iOS drops the session and the lock screen stops responding.
    await this.#startKeeper();
    for (const voice of this.voices) for (const el of voice.els) el.pause();
    this.#sync();
  }

  async toggle() {
    if (this.playing) await this.pause();
    else await this.play();
  }
}
