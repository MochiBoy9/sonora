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

export const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus',
  'wav', 'wave', 'webm', 'weba', 'aiff', 'aif',
]);

export const ext = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

export const isAudio = (name) => AUDIO_EXT.has(ext(name));

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'], i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
