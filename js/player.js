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

import { silentWavUrl } from './render.js';

export const VOICES = 3;

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
  constructor({ onStateChange, onError } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});
    this.voices = [];
    for (let v = 0; v < VOICES; v++) {
      this.voices.push({ els: [this.#makeElement(), this.#makeElement()], active: 0, urls: [null, null] });
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

  /** Swap in freshly rendered loops — one per voice — without producing a gap. */
  async load(urls, durationSec) {
    this.durationSec = durationSec || this.durationSec;
    const wasPlaying = this.playing;
    this.swapping = true;
    try {
      await Promise.all(
        this.voices.map(async (voice, index) => {
          const next = voice.els[1 - voice.active];
          const old = voice.els[voice.active];
          const previous = voice.urls[1 - voice.active];
          next.src = urls[index];
          voice.urls[1 - voice.active] = urls[index];

          // Both listeners go on before the action that fires them, otherwise the event
          // is missed and we sit waiting for a fallback, overlapping far longer.
          next.muted = false;
          const ready = once(next, ['canplaythrough', 'canplay', 'loadeddata'], 4000);
          next.load();
          await ready;
          try {
            next.currentTime = this.#offsetFor(index);
          } catch {
            /* seeking before metadata lands is not fatal — the stagger is an optimisation */
          }

          if (wasPlaying) {
            const started = once(next, ['playing', 'timeupdate'], 1500);
            await next.play().catch(() => {});
            await started;
            old.pause();
          }
          voice.active = 1 - voice.active;
          if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
        }),
      );
    } finally {
      this.swapping = false;
    }
    this.#sync();
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
