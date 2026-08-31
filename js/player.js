// Playback runs through ordinary <audio> elements, not a Web Audio graph, because iOS
// suspends AudioContext the moment the screen locks. A media element keeps going, which
// is the whole point of this app.
//
// Two elements are kept alive and ping-ponged so that changing a setting never leaves a
// gap: the new loop is preloaded and started before the old one is paused.

import { silentWavUrl } from './render.js';

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
    this.els = [this.#makeElement(), this.#makeElement()];
    this.active = 0;
    this.urls = [null, null];
    this.unlocked = false;
    this.wantPlaying = false;
    this.swapping = false;
    this.trackName = 'Noise';

    document.addEventListener('visibilitychange', () => {
      // Recover from interruptions (an alarm, a call) once we are back in the foreground.
      if (document.visibilityState === 'visible' && this.wantPlaying && this.current.paused) {
        this.current.play().catch(() => {});
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

  get current() {
    return this.els[this.active];
  }

  get idle() {
    return this.els[1 - this.active];
  }

  get playing() {
    return !this.current.paused;
  }

  #sync() {
    if (this.swapping) return;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
    this.onStateChange(this.playing);
  }

  /**
   * iOS grants playback permission per element, and only for a play() call made in the
   * same synchronous turn as the user's tap. The element the user is starting gets that
   * for free; this gives the *other* element its grant in the same turn, so later gapless
   * swaps are allowed to call play() on it programmatically.
   */
  #unlockIdleElement() {
    if (this.unlocked) return;
    this.unlocked = true;
    const other = this.idle;
    let temporary = null;
    if (!other.src) {
      temporary = silentWavUrl();
      other.src = temporary;
    }
    other
      .play()
      .then(() => other.pause())
      .catch(() => {})
      .finally(() => {
        if (temporary) setTimeout(() => URL.revokeObjectURL(temporary), 2000);
      });
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

  /** Swap in a freshly rendered loop without producing a gap. */
  async load(url) {
    const next = this.idle;
    const previous = this.urls[1 - this.active];
    next.src = url;
    this.urls[1 - this.active] = url;

    if (!this.playing) {
      next.load();
      this.active = 1 - this.active;
      if (previous) URL.revokeObjectURL(previous);
      return;
    }

    this.swapping = true;
    try {
      const old = this.current;
      // Both listeners go on before the action that fires them, otherwise the event is
      // missed and we sit waiting for the next fallback, overlapping the two loops for
      // far longer than necessary.
      const ready = once(next, ['canplaythrough', 'canplay', 'loadeddata'], 4000);
      next.load();
      await ready;
      const started = once(next, ['playing', 'timeupdate'], 1500);
      await next.play().catch(() => {});
      await started;
      old.pause();
      this.active = 1 - this.active;
    } finally {
      this.swapping = false;
    }
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
    this.#sync();
  }

  async play() {
    this.wantPlaying = true;
    this.#setMetadata();
    // Both play() calls must be issued before the first await, while still inside the tap.
    const started = this.current.play();
    this.#unlockIdleElement();
    try {
      await started;
      this.onError(null);
    } catch (err) {
      this.wantPlaying = false;
      this.onError(err.message || 'playback was blocked');
    }
    this.#sync();
  }

  pause() {
    this.wantPlaying = false;
    for (const el of this.els) el.pause();
    this.#sync();
  }

  async toggle() {
    if (this.playing) this.pause();
    else await this.play();
  }
}
