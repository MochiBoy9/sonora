/* looks.js — the interface, as settings.
 *
 * Everything visual that can reasonably be a preference is one here: the hue
 * the whole app is lit by, how sharp its corners are, how much glass and gloss
 * it wears, how dense the type is, how much of the 3D world is drawn behind it.
 *
 * All of it works the same way. A setting is a number or a word; `apply()`
 * turns the whole set into CSS custom properties on the root element; the
 * stylesheets read those properties and nothing else. No component knows a
 * setting exists, so adding one never means touching a component — and a
 * setting that fails to load leaves the defaults, which are a complete design
 * on their own.
 *
 * Colours are stored as hue, chroma and lightness and converted here, so one
 * slider moves the accent, its partner, every hairline, every glow and the
 * artwork tint together and they stay in the same family.
 */

import { Emitter, clamp } from './util.js';

export const events = new Emitter();

const KEY = 'sonora:look';

/**
 * Every setting, in the order it appears in the panel.
 *
 * `css` is what the setting writes. A setting with no `css` is read by JS
 * instead — the backdrop and the motion level are behaviour, not paint.
 */
export const SCHEMA = [
  { id: 'theme',    group: 'Base',    kind: 'choice', def: 'system',
    label: 'Theme', hint: 'Follow the system, or hold this window to dark or light',
    options: [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']] },
  { id: 'hue',      group: 'Colour',  kind: 'range',  def: 191, min: 0, max: 359, step: 1, unit: '°',
    label: 'Accent hue' },
  { id: 'spread',   group: 'Colour',  kind: 'range',  def: 27, min: -60, max: 60, step: 1, unit: '°',
    label: 'Second hue', hint: 'How far the gradient travels around the wheel' },
  { id: 'chroma',   group: 'Colour',  kind: 'range',  def: 100, min: 10, max: 130, step: 1, unit: '%',
    label: 'Saturation' },
  { id: 'tint',     group: 'Colour',  kind: 'range',  def: 100, min: 0, max: 100, step: 1, unit: '%',
    label: 'Surface tint', hint: 'How much of the accent bleeds into the panels' },
  { id: 'contrast', group: 'Colour',  kind: 'range',  def: 0, min: 0, max: 100, step: 1, unit: '%',
    label: 'Extra contrast' },

  { id: 'corner',   group: 'Form',    kind: 'choice', def: 'chamfer', label: 'Corners',
    options: [['chamfer', 'Chamfer'], ['round', 'Rounded'], ['square', 'Square']] },
  { id: 'cut',      group: 'Form',    kind: 'range',  def: 9, min: 0, max: 22, step: 1, unit: 'px',
    label: 'Corner size' },
  { id: 'density',  group: 'Form',    kind: 'choice', def: 'regular', label: 'Density',
    options: [['compact', 'Compact'], ['regular', 'Regular'], ['roomy', 'Roomy']] },
  { id: 'scale',    group: 'Form',    kind: 'range',  def: 100, min: 85, max: 125, step: 1, unit: '%',
    label: 'Text size' },

  { id: 'gloss',    group: 'Material', kind: 'range', def: 55, min: 0, max: 100, step: 1, unit: '%',
    label: 'Gloss', hint: 'The wet highlight along the top of raised surfaces' },
  { id: 'frost',    group: 'Material', kind: 'range', def: 24, min: 0, max: 40, step: 1, unit: 'px',
    label: 'Frost', hint: 'How far the glass blurs what is behind it' },
  { id: 'glow',     group: 'Material', kind: 'range', def: 100, min: 0, max: 200, step: 5, unit: '%',
    label: 'Bloom' },
  { id: 'grid',     group: 'Material', kind: 'range', def: 100, min: 0, max: 100, step: 1, unit: '%',
    label: 'Graph paper' },

  { id: 'scene',    group: 'Depth',   kind: 'choice', def: 'world', label: 'Backdrop',
    options: [['world', 'Full world'], ['tunnel', 'Tunnel'], ['grid', 'Grid only'],
              ['still', 'Still frame'], ['off', 'Off']] },
  { id: 'depth',    group: 'Depth',   kind: 'range',  def: 70, min: 0, max: 100, step: 1, unit: '%',
    label: 'Scene intensity' },
  { id: 'bubbles',  group: 'Depth',   kind: 'toggle', def: true, label: 'Bubbles' },
  { id: 'parallax', group: 'Depth',   kind: 'range',  def: 60, min: 0, max: 100, step: 1, unit: '%',
    label: 'Parallax', hint: 'How far panels lift off the world as you point at them' },
  { id: 'motion',   group: 'Depth',   kind: 'choice', def: 'full', label: 'Motion',
    options: [['full', 'Full'], ['calm', 'Calm'], ['none', 'None']] },

  /* R9: wear.
   *
   * Off by default, and this is the one piece of pure decoration in the whole
   * application that earns its place — the sleeve model already lights, shades
   * and relights itself from the artwork's own luminance, and `playCount` has
   * been kept since the first release. A record you have played four hundred
   * times looking played is the same fact the library already holds, said in
   * the material rather than in a number.
   *
   * Bounded, deliberately: at full strength a favourite record must still be
   * readable, so the ring never reaches the middle and the sheen never washes
   * out the picture. */
  { id: 'wear', group: 'Material', kind: 'range', def: 0, min: 0, max: 100, step: 1, unit: '%',
    label: 'Wear', hint: 'Ring wear on the records you have played most. Off at zero.' },

  /* R10: how long before the shop window. Zero is off, which is the default —
     a player that starts doing things on its own without being asked is a
     player somebody turns off. */
  { id: 'idle', group: 'Depth', kind: 'range', def: 0, min: 0, max: 30, step: 1, unit: ' min',
    label: 'Drift after', hint: 'Sit still for this long and Sonora drifts through your covers. Zero is off.' },
];

const BY_ID = new Map(SCHEMA.map((s) => [s.id, s]));

/** The shipped look, and the floor every other look is merged onto. */
export const defaults = () => {
  const out = {};
  for (const s of SCHEMA) out[s.id] = s.def;
  return out;
};

export const state = defaults();

/* ------------------------------------------------------------------ looks */

/**
 * Named looks. Each is a patch over the defaults, so a look only has to say
 * what makes it itself — and gains any setting added later for free.
 */
export const LOOKS = [
  { id: 'aero', label: 'Aqua', note: 'Wet glass and a deep horizon',
    patch: { hue: 191, spread: 27, chroma: 100, gloss: 70, frost: 28, corner: 'chamfer', cut: 9,
             scene: 'world', bubbles: true, glow: 110 } },
  { id: 'blueprint', label: 'Blueprint', note: 'Hairlines on a drafting table',
    patch: { hue: 199, spread: 8, chroma: 78, gloss: 14, frost: 14, corner: 'square', cut: 0,
             grid: 100, scene: 'grid', bubbles: false, glow: 60, tint: 60 } },
  { id: 'lagoon', label: 'Lagoon', note: 'Aqua going green at the edges',
    patch: { hue: 168, spread: 44, chroma: 118, gloss: 82, frost: 32, corner: 'round', cut: 14,
             scene: 'world', bubbles: true, glow: 130, tint: 110 } },
  { id: 'ultra', label: 'Ultraviolet', note: 'The old machine, one wavelength up',
    patch: { hue: 268, spread: -34, chroma: 112, gloss: 48, frost: 26, corner: 'chamfer', cut: 9,
             scene: 'tunnel', bubbles: true, glow: 140 } },
  { id: 'ember', label: 'Ember', note: 'Warm metal and a low sun',
    patch: { hue: 22, spread: 26, chroma: 108, gloss: 60, frost: 20, corner: 'chamfer', cut: 11,
             scene: 'world', bubbles: false, glow: 120, tint: 120 } },
  { id: 'solar', label: 'Solar', note: 'Daylight, and a lot of it',
    patch: { theme: 'light', hue: 201, spread: 22, chroma: 96, gloss: 42, frost: 18,
             corner: 'round', cut: 12, scene: 'grid', bubbles: true, glow: 70 } },
  { id: 'mono', label: 'Graphite', note: 'No colour at all, and nothing lost',
    patch: { hue: 210, spread: 0, chroma: 12, gloss: 20, frost: 12, corner: 'square', cut: 0,
             scene: 'still', bubbles: false, glow: 30, tint: 20, grid: 40 } },
  { id: 'plain', label: 'Plain', note: 'Everything switched off',
    patch: { gloss: 0, frost: 0, glow: 0, grid: 0, scene: 'off', bubbles: false,
             parallax: 0, motion: 'calm', corner: 'square', cut: 0, tint: 0 } },
];

/* ------------------------------------------------------------------ colour */

/**
 * HSL to RGB, returned as the "r g b" triplet the tokens are written in.
 *
 * Every colour in the app is stored as a channel triplet rather than a
 * finished colour, precisely so any rule can take an alpha of it. That is what
 * lets one hue slider move sixty tokens.
 */
function rgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `${Math.round((r + m) * 255)} ${Math.round((g + m) * 255)} ${Math.round((b + m) * 255)}`;
}

/* ------------------------------------------------------------------ apply */

const DENSITY = {
  compact: { row: 48, gutter: 24, pad: 14, player: 84 },
  regular: { row: 56, gutter: 34, pad: 18, player: 96 },
  roomy:   { row: 66, gutter: 46, pad: 24, player: 106 },
};

/** Writes the whole look onto the root element. Idempotent and cheap. */
export function apply(root = document.documentElement) {
  const s = state;
  const style = root.style;

  // Theme first: everything below is expressed in the same tokens either way.
  if (s.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);

  const light = s.theme === 'light' ||
    (s.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);

  const sat = clamp(s.chroma / 100, 0, 1.4);
  const h1 = s.hue;
  const h2 = s.hue + s.spread;

  // The accent has to stay legible on both grounds, so its lightness is not a
  // setting: it is whatever keeps the contrast, and only the hue moves.
  const l1 = light ? 0.40 : 0.51;
  const l2 = light ? 0.46 : 0.59;
  style.setProperty('--accent-rgb', rgb(h1, 0.86 * sat + 0.14, l1));
  style.setProperty('--accent-2-rgb', rgb(h2, 0.80 * sat + 0.12, l2));
  style.setProperty('--aero-rgb', rgb(h1 + 26, 0.92 * sat + 0.08, light ? 0.52 : 0.66));
  style.setProperty('--hue', String(h1));

  // Surfaces carry a little of the accent so the whole frame reads as one
  // material rather than as grey with a coloured button on it.
  const tint = clamp(s.tint / 100, 0, 1.2);
  const bump = clamp(s.contrast / 100, 0, 1);
  if (light) {
    style.setProperty('--bg-rgb', rgb(h1, 0.20 * sat * tint, 0.945 - bump * 0.045));
    style.setProperty('--bg-2-rgb', rgb(h1, 0.24 * sat * tint, 0.905 - bump * 0.05));
    style.setProperty('--surface-rgb', rgb(h1, 0.10 * sat * tint, 1 - bump * 0.015));
    style.setProperty('--surface-2-rgb', rgb(h1, 0.18 * sat * tint, 0.965 - bump * 0.03));
    style.setProperty('--surface-3-rgb', rgb(h1, 0.22 * sat * tint, 0.925 - bump * 0.04));
  } else {
    style.setProperty('--bg-rgb', rgb(h1, 0.52 * sat * tint, 0.035 - bump * 0.02));
    style.setProperty('--bg-2-rgb', rgb(h1 + 6, 0.50 * sat * tint, 0.058 - bump * 0.028));
    style.setProperty('--surface-rgb', rgb(h1, 0.46 * sat * tint, 0.069 - bump * 0.03));
    style.setProperty('--surface-2-rgb', rgb(h1, 0.44 * sat * tint, 0.096 - bump * 0.04));
    style.setProperty('--surface-3-rgb', rgb(h1, 0.42 * sat * tint, 0.139 - bump * 0.05));
  }

  // Geometry.
  const cut = s.corner === 'square' ? 0 : s.cut;
  style.setProperty('--cut', cut + 'px');
  style.setProperty('--cut-sm', Math.round(cut * 0.56) + 'px');
  style.setProperty('--cut-lg', Math.round(cut * 1.8) + 'px');
  style.setProperty('--radius', s.corner === 'round' ? cut + 'px' : '0px');
  root.setAttribute('data-corner', s.corner);

  const d = DENSITY[s.density] || DENSITY.regular;
  style.setProperty('--row-h', d.row + 'px');
  style.setProperty('--gutter', d.gutter + 'px');
  style.setProperty('--pad', d.pad + 'px');
  style.setProperty('--player-h', d.player + 'px');
  style.setProperty('--scale', String(clamp(s.scale / 100, 0.7, 1.4)));

  // Material.
  style.setProperty('--gloss', String(clamp(s.gloss / 100, 0, 1)));
  style.setProperty('--frost', clamp(s.frost, 0, 40) + 'px');
  style.setProperty('--glow', String(clamp(s.glow / 100, 0, 2)));
  style.setProperty('--grid-a', String(clamp(s.grid / 100, 0, 1)));
  style.setProperty('--parallax', String(clamp(s.parallax / 100, 0, 1)));
  // R9. Zero is off, and off is the default: nothing else in this application
  // is decoration, and this is opted into rather than out of.
  style.setProperty('--wear', String(clamp((s.wear ?? 0) / 100, 0, 1)));

  root.setAttribute('data-motion', s.motion);
  root.setAttribute('data-scene', s.scene);

  if (root === document.documentElement) cacheForNextLaunch(root);
  events.emit('change', s);
}

/**
 * The look, frozen for the next cold start.
 *
 * A module cannot run before first paint, so the document head carries four
 * lines of inline script that read exactly this and put it back. Caching the
 * *result* rather than re-deriving it there means the two can never disagree:
 * there is only one implementation of what a look looks like.
 */
function cacheForNextLaunch(root) {
  try {
    localStorage.setItem('sonora:look-css', root.getAttribute('style') || '');
    localStorage.setItem('sonora:look-attrs', JSON.stringify({
      theme: root.getAttribute('data-theme') || '',
      corner: root.getAttribute('data-corner') || '',
      motion: root.getAttribute('data-motion') || '',
      scene: root.getAttribute('data-scene') || '',
    }));
  } catch { /* private mode: one frame of the shipped colours, then ours */ }
}

/* ------------------------------------------------------------------ edits */

export function set(id, value) {
  const spec = BY_ID.get(id);
  if (!spec) return;
  if (spec.kind === 'range') value = clamp(Number(value), spec.min, spec.max);
  else if (spec.kind === 'toggle') value = !!value;
  else if (!spec.options.some(([v]) => v === value)) return;
  if (state[id] === value) return;
  state[id] = value;
  apply();
  save();
}

export function useLook(id) {
  const look = LOOKS.find((l) => l.id === id);
  if (!look) return;
  Object.assign(state, defaults(), look.patch);
  apply();
  save();
  events.emit('look', id);
}

export function reset() {
  Object.assign(state, defaults());
  apply();
  save();
  events.emit('look', null);
}

/** Which named look the current settings are, if any. */
export function currentLook() {
  for (const look of LOOKS) {
    const want = { ...defaults(), ...look.patch };
    if (SCHEMA.every((s) => state[s.id] === want[s.id])) return look.id;
  }
  const base = defaults();
  return SCHEMA.every((s) => state[s.id] === base[s.id]) ? 'default' : 'custom';
}

export const isDefault = () => currentLook() === 'default';

/* ------------------------------------------------------------------ store */

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

/**
 * Reads the stored look and applies it.
 *
 * Also called from the inline script in the document head, before the first
 * paint, so the app never flashes the shipped colours before switching to
 * yours. That copy is deliberately tiny and duplicated rather than imported:
 * a module cannot run before first paint.
 */
export function init() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const spec of SCHEMA) {
        if (raw[spec.id] === undefined) continue;
        const v = raw[spec.id];
        if (spec.kind === 'range' && typeof v === 'number') state[spec.id] = clamp(v, spec.min, spec.max);
        else if (spec.kind === 'toggle') state[spec.id] = !!v;
        else if (spec.kind === 'choice' && spec.options.some(([o]) => o === v)) state[spec.id] = v;
      }
    }
  } catch { /* a corrupt look is not worth a broken app */ }

  apply();

  // "System" means system, so it has to keep listening.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.theme === 'system') apply();
  });
  return state;
}

/** Everything the panel needs to draw itself. */
export const groups = () => {
  const out = new Map();
  for (const s of SCHEMA) {
    if (!out.has(s.group)) out.set(s.group, []);
    out.get(s.group).push(s);
  }
  return out;
};
