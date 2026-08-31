import { COLORS, EQ_BANDS, magnitudeDb } from './dsp.js';
import { LIMITS } from './presets.js';

const CURVE_POINTS = 320;
const CURVE_LO = 20;
const CURVE_HI = 20000;
const CURVE_SPAN_DB = 72; // window height, so the shape stays readable as levels move

const freqLabel = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${+f.toFixed(1)} Hz`);
// Cramped to fit ten faders across a 375 px screen without scrolling.
const freqShort = (f) => (f >= 1000 ? `${Math.round(f / 1000)}k` : `${Math.round(f)}`);
const dbLabel = (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} dB`;
const dbShort = (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`;

// Frequency sliders travel in log space so the low end is not crammed into a few pixels.
const toLog = (v, lo, hi) => (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
const fromLog = (t, lo, hi) => Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));

export class UI {
  constructor({ onChange, onToggle, onSelectPreset, onSavePreset, onDeletePreset }) {
    this.onChange = onChange;
    this.onSelectPreset = onSelectPreset;
    this.controls = [];
    this.activePreset = null;
    this.presetList = [];

    this.el = {
      play: document.getElementById('playToggle'),
      status: document.getElementById('status'),
      detail: document.getElementById('detail'),
      error: document.getElementById('error'),
      color: document.getElementById('colorSelect'),
      preset: document.getElementById('presetSelect'),
      colorBlurb: document.getElementById('colorBlurb'),
      curve: document.getElementById('curve'),
      eq: document.getElementById('eq'),
      shaping: document.getElementById('shaping'),
      save: document.getElementById('savePreset'),
      delete: document.getElementById('deletePreset'),
    };

    this.el.play.addEventListener('click', onToggle);
    this.el.save.addEventListener('click', onSavePreset);
    this.el.delete.addEventListener('click', () => onDeletePreset(this.activePreset));

    this.el.color.addEventListener('change', () => this.onChange({ color: this.el.color.value }));
    this.el.preset.addEventListener('change', () => {
      const chosen = this.presetList.find((p) => p.name === this.el.preset.value);
      if (chosen) this.onSelectPreset(chosen);
    });

    this.#buildColorOptions();
    this.#buildEq();
    this.#buildShaping();

    this.ctx = this.el.curve.getContext('2d');
    this.lastSettings = null;
    // What is actually sounding: one entry per voice. Voices take a change one at a time,
    // so until they all have, the audible spectrum is the average of a mixture.
    this.voiceSettings = null;

    // Resizing a canvas clears it, so every resize has to redraw. A ResizeObserver also
    // covers the first layout pass, when the canvas still has no width to draw into.
    new ResizeObserver(() => {
      this.#resizeCurve();
      if (this.lastSettings) this.drawCurve(this.lastSettings);
    }).observe(this.el.curve);
  }

  #buildColorOptions() {
    for (const [key, def] of Object.entries(COLORS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = def.label;
      this.el.color.appendChild(option);
    }
  }

  #addFader(band, index) {
    const fader = document.createElement('div');
    fader.className = 'fader';

    const value = document.createElement('span');
    value.className = 'value';

    const slot = document.createElement('div');
    slot.className = 'fader-slot';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(LIMITS.eq[0]);
    input.max = String(LIMITS.eq[1]);
    input.step = '1';
    input.setAttribute('aria-label', freqLabel(band));
    slot.appendChild(input);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = freqShort(band);

    input.addEventListener('input', () =>
      this.onChange({ eqBand: { index, value: Number(input.value) } }),
    );

    fader.append(value, slot, name);
    this.el.eq.appendChild(fader);

    this.controls.push({
      syncInput: (s) => {
        input.value = String(s.eq[index]);
      },
      syncLabel: (s) => {
        value.textContent = dbShort(s.eq[index]);
      },
    });
  }

  #buildEq() {
    EQ_BANDS.forEach((band, i) => this.#addFader(band, i));
  }

  #addRow(parent, { name, get, set, format, min, max, step = 1, log = false }) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;

    const input = document.createElement('input');
    input.type = 'range';
    input.setAttribute('aria-label', name);
    if (log) {
      input.min = '0';
      input.max = '1000';
      input.step = '1';
    } else {
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
    }

    const value = document.createElement('span');
    value.className = 'value';

    input.addEventListener('input', () => {
      const raw = Number(input.value);
      this.onChange(set(log ? fromLog(raw / 1000, min, max) : raw));
    });

    row.append(label, input, value);
    parent.appendChild(row);

    this.controls.push({
      // Kept separate so a live drag only repaints its own label. Writing input.value
      // back while the thumb is under a finger makes the slider feel like it is fighting.
      syncInput: (s) => {
        const v = get(s);
        input.value = String(log ? Math.round(toLog(v, min, max) * 1000) : v);
      },
      syncLabel: (s) => {
        value.textContent = format(get(s));
      },
    });
  }

  #buildShaping() {
    this.#addRow(this.el.shaping, {
      name: 'Muffle',
      min: LIMITS.lowpass[0],
      max: LIMITS.lowpass[1],
      log: true,
      get: (s) => s.lowpass,
      set: (v) => ({ lowpass: Math.round(v) }),
      format: (v) => (v >= 19500 ? 'off' : freqLabel(Math.round(v))),
    });
    this.#addRow(this.el.shaping, {
      name: 'Rumble',
      min: LIMITS.highpass[0],
      max: LIMITS.highpass[1],
      log: true,
      get: (s) => s.highpass,
      set: (v) => ({ highpass: Math.round(v) }),
      format: (v) => (v <= 21 ? 'full' : freqLabel(Math.round(v))),
    });
    this.#addRow(this.el.shaping, {
      name: 'Width',
      min: 0,
      max: 100,
      get: (s) => Math.round(s.width * 100),
      set: (v) => ({ width: v / 100 }),
      format: (v) => (v === 0 ? 'mono' : `${v}%`),
    });
    this.#addRow(this.el.shaping, {
      name: 'Volume',
      min: LIMITS.volumeDb[0],
      max: LIMITS.volumeDb[1],
      get: (s) => Math.round(s.volumeDb),
      set: (v) => ({ volumeDb: v }),
      format: dbLabel,
    });
  }

  setPresets(list, activeName) {
    this.activePreset = activeName;
    this.presetList = list;
    this.el.preset.replaceChildren();

    // Edited settings match no preset, so the picker needs somewhere to point.
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Custom';
    this.el.preset.appendChild(custom);

    const groups = [
      ['Built in', list.filter((p) => p.builtIn)],
      ['Yours', list.filter((p) => !p.builtIn)],
    ];
    for (const [label, members] of groups) {
      if (!members.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const p of members) {
        const option = document.createElement('option');
        option.value = p.name;
        option.textContent = p.name;
        group.appendChild(option);
      }
      this.el.preset.appendChild(group);
    }

    this.el.preset.value = activeName ?? '';
    const active = list.find((p) => p.name === activeName);
    this.el.delete.hidden = !active || active.builtIn;
  }

  /** What each voice is currently playing, so the curve can follow the sound. */
  setVoiceSettings(list) {
    this.voiceSettings = list && list.length ? list : null;
    if (this.lastSettings) this.drawCurve(this.lastSettings);
  }

  /** Everything that is safe to repaint mid-drag. */
  reflect(s) {
    this.lastSettings = s;
    for (const c of this.controls) c.syncLabel(s);
    this.el.color.value = s.color;
    this.el.colorBlurb.textContent = COLORS[s.color]?.blurb ?? '';
    this.#resizeCurve();
    this.drawCurve(s);
  }

  /** Full sync, including slider positions. For init and preset loads. */
  setSettings(s) {
    for (const c of this.controls) c.syncInput(s);
    this.reflect(s);
  }

  setPlaying(playing) {
    this.el.play.dataset.state = playing ? 'playing' : 'stopped';
    this.el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setStatus(status, detail = '') {
    this.el.status.textContent = status;
    this.el.detail.textContent = detail;
  }

  setBusy(busy) {
    this.el.play.disabled = busy;
  }

  setError(message) {
    this.el.error.hidden = !message;
    this.el.error.textContent = message || '';
  }

  #resizeCurve() {
    const c = this.el.curve;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  drawCurve(s) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.el.curve;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const pad = 6 * dpr;

    const logLo = Math.log(CURVE_LO);
    const logHi = Math.log(CURVE_HI);
    const voices = this.voiceSettings;
    const db = new Float64Array(CURVE_POINTS); // what is audible right now
    const target = new Float64Array(CURVE_POINTS); // where it is heading
    let top = -Infinity;
    let divergence = 0;
    for (let i = 0; i < CURVE_POINTS; i++) {
      const f = Math.exp(logLo + ((logHi - logLo) * i) / (CURVE_POINTS - 1));
      target[i] = magnitudeDb(f, s);
      if (voices) {
        // Voices sum as power, so the audible spectrum is their power average.
        let power = 0;
        for (const v of voices) power += Math.pow(10, magnitudeDb(f, v) / 10);
        db[i] = 10 * Math.log10(power / voices.length);
      } else {
        db[i] = target[i];
      }
      const diff = Math.abs(db[i] - target[i]);
      if (diff > divergence) divergence = diff;
      if (db[i] > top) top = db[i];
      if (target[i] > top) top = target[i];
    }
    top += 6;
    const showTarget = divergence > 0.25;

    const x = (i) => pad + ((w - 2 * pad) * i) / (CURVE_POINTS - 1);
    const y = (v) => pad + ((h - 2 * pad) * (top - v)) / CURVE_SPAN_DB;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(148,156,171,0.16)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (const f of [100, 1000, 10000]) {
      const px = pad + ((w - 2 * pad) * (Math.log(f) - logLo)) / (logHi - logLo);
      ctx.moveTo(px, pad);
      ctx.lineTo(px, h - pad);
    }
    for (let d = top; d > top - CURVE_SPAN_DB; d -= 12) {
      const py = y(d);
      ctx.moveTo(pad, py);
      ctx.lineTo(w - pad, py);
    }
    ctx.stroke();

    const clampY = (v) => Math.max(pad, Math.min(h - pad, y(v)));
    const line = new Path2D();
    line.moveTo(x(0), clampY(db[0]));
    for (let i = 1; i < CURVE_POINTS; i++) line.lineTo(x(i), clampY(db[i]));

    const area = new Path2D(line);
    area.lineTo(x(CURVE_POINTS - 1), h - pad);
    area.lineTo(x(0), h - pad);
    area.closePath();

    const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
    fill.addColorStop(0, 'rgba(255,138,61,0.30)');
    fill.addColorStop(1, 'rgba(255,138,61,0.02)');
    ctx.fillStyle = fill;
    ctx.fill(area);

    // Where it is heading, drawn faint and dashed behind the audible curve.
    if (showTarget) {
      const ghost = new Path2D();
      ghost.moveTo(x(0), clampY(target[0]));
      for (let i = 1; i < CURVE_POINTS; i++) ghost.lineTo(x(i), clampY(target[i]));
      ctx.save();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(255,138,61,0.45)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke(ghost);
      ctx.restore();
    }

    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke(line);

    // Halo behind the axis labels so they stay readable where the curve runs through them.
    ctx.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(11,14,19,0.85)';
    ctx.fillStyle = 'rgba(148,156,171,0.75)';
    for (const [f, label] of [
      [100, '100'],
      [1000, '1k'],
      [10000, '10k'],
    ]) {
      const px = pad + ((w - 2 * pad) * (Math.log(f) - logLo)) / (logHi - logLo);
      ctx.strokeText(label, px + 4 * dpr, h - pad - 4 * dpr);
      ctx.fillText(label, px + 4 * dpr, h - pad - 4 * dpr);
    }
  }
}
