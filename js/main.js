import { COLORS } from './dsp.js';
import { Player } from './player.js';
import { renderLoop } from './render.js';
import { UI } from './ui.js';
import * as store from './presets.js';

const RENDER_DEBOUNCE = 250;

let settings = store.loadSettings();
let userPresets = store.loadUserPresets();
let activePreset = null;
let lastRender = null;
let pendingRender = null;
let ui = null;

const player = new Player({
  onStateChange: () => {
    if (!ui) return;
    ui.setPlaying(player.playing);
    updateStatus();
  },
  onError: (message) => ui?.setError(message),
});

// Yield long enough for the status text to paint before the transform blocks the thread.
// A hidden tab never fires requestAnimationFrame, so the timeout is not a nicety: without
// it, backgrounding the app between a slider move and its debounced render would wedge the
// render forever and leave the play button disabled.
const nextPaint = () =>
  new Promise((resolve) => {
    let settled = false;
    const go = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });

const allPresets = () => [
  ...store.BUILT_IN.map((p) => ({ ...p, builtIn: true })),
  ...userPresets.map((p) => ({ ...p, builtIn: false })),
];

function sameSettings(a, b) {
  return (
    a.color === b.color &&
    a.lowpass === b.lowpass &&
    a.highpass === b.highpass &&
    a.volumeDb === b.volumeDb &&
    Math.abs(a.width - b.width) < 1e-9 &&
    a.eq.every((v, i) => v === b.eq[i])
  );
}

const matchPreset = () =>
  allPresets().find((p) => sameSettings(store.sanitize(p.settings), settings))?.name ?? null;

const trackName = () => activePreset ?? `${COLORS[settings.color].label} noise`;

function updateStatus(override) {
  const state = player.playing ? 'Playing' : 'Ready';
  if (override) {
    ui.setStatus(state, override);
    return;
  }
  if (!lastRender) {
    ui.setStatus(state, '');
    return;
  }
  ui.setStatus(
    state,
    `${COLORS[settings.color].label} · ${lastRender.durationSec.toFixed(1)} s seamless loop`,
  );
}

function scheduleRender() {
  clearTimeout(pendingRender);
  updateStatus('shaping…');
  pendingRender = setTimeout(runRender, RENDER_DEBOUNCE);
}

async function runRender() {
  pendingRender = null;
  ui.setBusy(true);
  updateStatus('shaping…');
  // Let the status paint before the transform blocks the main thread.
  await nextPaint();

  let result;
  try {
    result = renderLoop(settings);
  } catch (err) {
    ui.setError(`Could not render the loop: ${err.message}`);
    ui.setBusy(false);
    return;
  }

  lastRender = result;
  player.setTrackName(trackName());
  await player.load(result.url);
  ui.setBusy(false);
  updateStatus();
}

function onChange(patch) {
  if (patch.eqBand) settings.eq[patch.eqBand.index] = patch.eqBand.value;
  else Object.assign(settings, patch);
  settings = store.sanitize(settings);

  const next = matchPreset();
  if (next !== activePreset) {
    activePreset = next;
    ui.setPresets(allPresets(), activePreset);
  }
  ui.reflect(settings);
  store.saveSettings(settings);
  scheduleRender();
}

function selectPreset(preset) {
  settings = store.sanitize(preset.settings);
  activePreset = preset.name;
  ui.setSettings(settings);
  ui.setPresets(allPresets(), activePreset);
  store.saveSettings(settings);
  scheduleRender();
}

function savePreset() {
  const name = (window.prompt('Name this preset', activePreset ?? '') ?? '').trim();
  if (!name) return;
  if (store.BUILT_IN.some((p) => p.name === name)) {
    ui.setError(`"${name}" is a built-in preset name. Pick another.`);
    return;
  }
  userPresets = store.saveUserPreset(name, settings);
  activePreset = name;
  ui.setPresets(allPresets(), activePreset);
  ui.setError(null);
}

function deletePreset(name) {
  if (!name) return;
  userPresets = store.deleteUserPreset(name);
  activePreset = matchPreset();
  ui.setPresets(allPresets(), activePreset);
}

async function onToggle() {
  // Never render inside this handler: iOS only honours a play() issued in the same
  // turn as the tap, and a loop is always already loaded by the time the button unlocks.
  if (player.playing) player.pause();
  else await player.play();
}

async function init() {
  ui = new UI({
    onChange,
    onToggle,
    onSelectPreset: selectPreset,
    onSavePreset: savePreset,
    onDeletePreset: deletePreset,
  });

  activePreset = matchPreset();
  ui.setSettings(settings);
  ui.setPresets(allPresets(), activePreset);
  ui.setPlaying(false);
  ui.setBusy(true);
  updateStatus('preparing…');
  await nextPaint();
  await runRender();
}

init();
