import { COLORS, EQ_BANDS } from './dsp.js';

const PRESET_KEY = 'salamander.presets.v1';
const SETTINGS_KEY = 'salamander.settings.v1';

export const LIMITS = {
  eq: [-12, 12],
  lowpass: [200, 20000],
  highpass: [20, 2000],
  width: [0, 1],
  volumeDb: [-30, 0],
};

export const DEFAULTS = {
  color: 'brown',
  eq: EQ_BANDS.map(() => 0),
  lowpass: 20000,
  highpass: 20,
  width: 0.8,
  volumeDb: 0,
};

export const BUILT_IN = [
  {
    name: 'Deep Brown',
    settings: { ...DEFAULTS },
  },
  {
    name: 'Bass Mask',
    settings: {
      color: 'brown',
      eq: [3, 6, 4, 1, -2, -4, -6, -8, -10, -12],
      lowpass: 6000,
      highpass: 22,
      width: 0.6,
      volumeDb: 0,
    },
  },
  {
    name: 'Ocean Floor',
    settings: {
      color: 'brown',
      eq: [4, 4, 2, 0, -2, -5, -8, -10, -12, -12],
      lowpass: 2200,
      highpass: 20,
      width: 1,
      volumeDb: 0,
    },
  },
  {
    name: 'Soft Rain',
    settings: {
      color: 'pink',
      eq: [-8, -6, -3, 0, 1, 2, 3, 2, 0, -3],
      lowpass: 14000,
      highpass: 120,
      width: 1,
      volumeDb: 0,
    },
  },
  {
    name: 'Fan',
    settings: {
      color: 'pink',
      eq: [2, 3, 2, 1, 0, -1, -3, -5, -8, -12],
      lowpass: 8000,
      highpass: 45,
      width: 0.5,
      volumeDb: 0,
    },
  },
  {
    name: 'Grey Blanket',
    settings: {
      color: 'grey',
      eq: EQ_BANDS.map(() => 0),
      lowpass: 20000,
      highpass: 20,
      width: 0.9,
      volumeDb: 0,
    },
  },
];

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** Anything coming out of localStorage or a shared link gets forced into range. */
export function sanitize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const eq = Array.isArray(s.eq) ? s.eq : [];
  return {
    color: Object.hasOwn(COLORS, s.color) ? s.color : DEFAULTS.color,
    eq: EQ_BANDS.map((_, i) => clamp(eq[i], LIMITS.eq, 0)),
    lowpass: clamp(s.lowpass, LIMITS.lowpass, DEFAULTS.lowpass),
    highpass: clamp(s.highpass, LIMITS.highpass, DEFAULTS.highpass),
    width: clamp(s.width, LIMITS.width, DEFAULTS.width),
    volumeDb: clamp(s.volumeDb, LIMITS.volumeDb, DEFAULTS.volumeDb),
  };
}

export const cloneSettings = (s) => ({ ...s, eq: [...s.eq] });

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing or a full quota — not worth interrupting the user over */
  }
}

export function loadUserPresets() {
  const list = read(PRESET_KEY, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({ name: p.name, settings: sanitize(p.settings) }));
}

export function saveUserPreset(name, settings) {
  const list = loadUserPresets().filter((p) => p.name !== name);
  list.push({ name, settings: sanitize(settings) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  write(PRESET_KEY, list);
  return list;
}

export function deleteUserPreset(name) {
  const list = loadUserPresets().filter((p) => p.name !== name);
  write(PRESET_KEY, list);
  return list;
}

export const loadSettings = () => sanitize(read(SETTINGS_KEY, DEFAULTS));
export const saveSettings = (s) => write(SETTINGS_KEY, s);
