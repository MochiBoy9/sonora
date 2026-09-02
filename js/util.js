/* util.js — tiny DOM + data helpers. No dependencies, no allocations in hot paths. */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Terse element factory. el('div', {class:'x', onclick:fn}, child, 'text') */
export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'data') for (const d in v) node.dataset[d] = v[d];
      else if (k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110) // "on..."
        node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k == null || k === false || k === '') continue;
    if (Array.isArray(k)) append(node, k);
    else node.append(k.nodeType ? k : String(k));
  }
}

/** Inline SVG sprite reference. */
export const ico = (name, cls) =>
  `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------------------------------------------------------------- formatting */

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  sec = Math.floor(sec);
  const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
  return h ? `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`
           : `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function fmtCount(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;
}

export function fmtTotal(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m || 1} min`;
}

/* ---------------------------------------------------------------- text */

const DIACRITICS = /[\u0300-\u036f]/g;
/** lowercase + strip accents; memoised through the caller's own field. */
export function norm(s) {
  return s ? s.normalize('NFD').replace(DIACRITICS, '').toLowerCase() : '';
}

/** FNV-1a — stable ids for album/artist keys. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** One definition of album identity, shared by the worker and the main thread. */
export const albumKeyOf = (artist, album) => hash32(norm(artist) + '||' + norm(album));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const cmpText = (a, b) => collator.compare(a || '', b || '');

/** Strips leading articles so "The Beatles" files under B. */
export function sortName(s) {
  return (s || '').replace(/^(the|a|an)\s+/i, '');
}

/* ---------------------------------------------------------------- timing */

export function debounce(fn, ms) {
  let t;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}

// globalThis, not window: this module is imported by the metadata worker too.
export const idle = typeof globalThis.requestIdleCallback === 'function'
  ? (fn, timeout = 1000) => globalThis.requestIdleCallback(fn, { timeout })
  : (fn) => setTimeout(fn, 1);

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* ---------------------------------------------------------------- structures */

/** Bounded cache that revokes evicted object URLs. */
export class LRU {
  constructor(limit = 240, onEvict) { this.limit = limit; this.map = new Map(); this.onEvict = onEvict; }
  get(k) {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k); this.map.set(k, v);          // refresh recency
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      const dead = this.map.get(oldest);
      this.map.delete(oldest);
      this.onEvict?.(dead, oldest);
    }
  }
  has(k) { return this.map.has(k); }
  delete(k) {
    if (!this.map.has(k)) return;
    const dead = this.map.get(k);
    this.map.delete(k);
    this.onEvict?.(dead, k);
  }
  clear() { for (const [k, v] of this.map) this.onEvict?.(v, k); this.map.clear(); }
}

/** Minimal pub/sub. Returns an unsubscribe function. */
export class Emitter {
  constructor() { this.h = new Map(); }
  on(evt, fn) {
    let set = this.h.get(evt);
    if (!set) this.h.set(evt, set = new Set());
    set.add(fn);
    return () => set.delete(fn);
  }
  emit(evt, ...args) {
    const set = this.h.get(evt);
    if (set) for (const fn of set) fn(...args);
  }
}

/* ---------------------------------------------------------------- files */

/**
 * Every audio container worth indexing, not just the ones this browser can
 * decode. A file we cannot play is still worth showing — with its tags, its
 * artwork and an honest label — rather than pretending it isn't there.
 */
export const AUDIO_EXT = new Set([
  // mpeg
  'mp3', 'mp2', 'mpga', 'mpeg',
  // mp4 family
  'm4a', 'm4b', 'm4r', 'm4p', 'mp4', 'aac', 'adts',
  // free formats
  'flac', 'ogg', 'oga', 'opus', 'spx', 'webm', 'weba', 'mka',
  // uncompressed
  'wav', 'wave', 'aiff', 'aif', 'aifc', 'caf', 'au', 'snd', 'pcm',
  // everything else people actually have on disk
  'wma', 'amr', '3gp', '3g2', 'ape', 'wv', 'mpc', 'tta', 'dsf', 'dff', 'ra', 'ac3', 'dts',
]);

/**
 * Containers no shipping browser decodes. This is a static list rather than a
 * `canPlayType` probe on purpose: that method answers for the MIME strings a
 * media stack happens to register, not for what it can actually decode, and it
 * says "no" to plenty it plays perfectly well — Chromium denies `audio/aiff`
 * and then plays AIFF. A wrong "no" hides a playable file, which is worse than
 * finding out from the decoder, so the only guesses made here are the safe ones
 * and everything else is learned by trying (see player.js).
 */
const UNDECODABLE = new Set(['ape', 'wv', 'mpc', 'tta', 'dsf', 'dff', 'ra', 'wma', 'dts']);

export const ext = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

export const isAudio = (name) => AUDIO_EXT.has(ext(name));

/**
 * Same question, asked of a real File: the extension decides first, but a file
 * the OS calls `audio/*` counts even when its suffix is unfamiliar. That is how
 * "any audio type" ends up meaning any audio type.
 */
export const isAudioFile = (file) =>
  isAudio(file.name || '') || (typeof file.type === 'string' && file.type.startsWith('audio/'));

/** The formats string the file picker offers, so nothing is greyed out. */
export const acceptAttr = () =>
  'audio/*,' + [...AUDIO_EXT].map((e) => '.' + e).join(',');

/** Is it worth handing this file to the decoder at all? */
export const canDecode = (name) => !UNDECODABLE.has(ext(name));

/** "FLAC", "M4A" — the format's name, for saying what went wrong. */
export const formatName = (name) => (ext(name) || 'audio').toUpperCase();

/**
 * How long ago, in a column two characters wide.
 *
 * A list of dates is unreadable — twenty rows of "14/03/2025" tell you nothing
 * you can compare at a glance. A list of ages is a shape: everything from this
 * week reads as days, everything from a while back reads as months, and the
 * gap between the two is what somebody scanning the column is looking for. The
 * exact date is in the tooltip for when it is actually wanted.
 */
export function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'now';
  const m = s / 60;
  if (m < 60) return Math.round(m) + 'm';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h';
  const d = h / 24;
  if (d < 7) return Math.round(d) + 'd';
  if (d < 60) return Math.round(d / 7) + 'w';
  if (d < 730) return Math.round(d / 30.44) + 'mo';
  return Math.round(d / 365.25) + 'y';
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'], i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * Lyric sidecars. `.lrc` carries timings, `.txt` almost never does — both are
 * read, and which one it turns out to be is decided by looking at the contents
 * rather than at the suffix.
 */
const LYRIC_EXT = new Set(['lrc', 'txt']);
export const isLyric = (name) => LYRIC_EXT.has(ext(name));

/* A playlist file. Here rather than in `m3u.js` so that `library.js` can ask
   the question without importing the module that answers it — the two would
   otherwise import each other, and a cycle that works only because nobody
   calls across it during evaluation is a cycle waiting to break. */
export const isPlaylistFile = (name) => /\.m3u8?$/i.test(String(name || ''));

/* A cue sheet: an index into an audio file rather than a track of its own. */
export const isCueFile = (name) => /\.cue$/i.test(String(name || ''));
