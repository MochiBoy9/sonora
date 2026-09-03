/* db.js — IndexedDB persistence.
 *
 * The library survives reloads: metadata, cover thumbnails, playlists and (on
 * Chromium) the directory handles themselves, which are structured-cloneable.
 * Startup therefore paints a full library from disk before touching the
 * filesystem at all; rescanning happens afterwards, in the background.
 */

/* ------------------------------------------------------------------ I3
 *
 * More than one library.
 *
 * One index, one set of settings and one listening history per browser
 * profile, which is fine until two people share a machine — or until one
 * person wants their own records kept apart from the ones on the house
 * speakers. Everything Sonora stores goes through this file, so a library is
 * exactly one IndexedDB database and switching is choosing a different name.
 *
 * The list of them lives in `localStorage` rather than in a database, because
 * it has to be readable before any database is opened — a chicken-and-egg the
 * other way round would need a database to find out which database to open.
 *
 * Switching reloads. The whole application is built from one library at boot —
 * the index, the roots, the racks, the day log — and swapping it underneath a
 * running app would mean re-initialising every module in the right order for
 * no benefit over a reload that takes half a second.
 */
const LIBRARY_KEY = 'sonora:library';
const LIBRARY_LIST = 'sonora:libraries';
const BASE = 'sonora';

/** The library in use, as an id. The empty string is the original one. */
export function activeLibrary() {
  try { return localStorage.getItem(LIBRARY_KEY) || ''; } catch { return ''; }
}

/** Every library this browser knows about, the original one first. */
export function libraries() {
  let extra = [];
  try { extra = JSON.parse(localStorage.getItem(LIBRARY_LIST) || '[]'); } catch { extra = []; }
  if (!Array.isArray(extra)) extra = [];
  return [{ id: '', name: 'Main library' }].concat(
    extra.filter((l) => l && typeof l.id === 'string' && l.id && typeof l.name === 'string'));
}

/** Adds one and returns it. Does not switch to it. */
export function addLibrary(name) {
  const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const list = libraries().slice(1).concat([{ id, name: String(name || 'Library').slice(0, 60) }]);
  try { localStorage.setItem(LIBRARY_LIST, JSON.stringify(list)); } catch { /* private */ }
  return { id, name };
}

export function renameLibrary(id, name) {
  if (!id) return;
  const list = libraries().slice(1).map((l) => (l.id === id ? { ...l, name: String(name).slice(0, 60) } : l));
  try { localStorage.setItem(LIBRARY_LIST, JSON.stringify(list)); } catch { /* private */ }
}

/**
 * Throws one away, database and all.
 *
 * Refuses to delete the one in use: the application is holding it open, the
 * delete would block until every tab closed, and the result would be a browser
 * that appears to have hung. Switch away first.
 */
export async function dropLibrary(id) {
  if (!id || id === activeLibrary()) return false;
  const list = libraries().slice(1).filter((l) => l.id !== id);
  try { localStorage.setItem(LIBRARY_LIST, JSON.stringify(list)); } catch { /* private */ }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(BASE + ':' + id);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  return true;
}

/** Chooses which library the *next* load will open. */
export function useLibrary(id) {
  try {
    if (id) localStorage.setItem(LIBRARY_KEY, id);
    else localStorage.removeItem(LIBRARY_KEY);
  } catch { /* private */ }
}

const NAME = (() => {
  const id = (() => { try { return localStorage.getItem(LIBRARY_KEY) || ''; } catch { return ''; } })();
  return id ? BASE + ':' + id : BASE;
})();
/* v2 adds the `band` store for cached online lookups. v3 adds `peaks`, the
   per-track waveform and spectrogram computed on first listen. Both upgrades
   are additive and guarded, so a v1 database opens, gains two stores and keeps
   every track, cover and playlist it already had — there is no migration to
   run and nothing to lose if either feature is never used. */
const VERSION = 3;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('albumKey', 'albumKey');
        s.createIndex('rootId', 'rootId');
      }
      if (!db.objectStoreNames.contains('art'))       db.createObjectStore('art');
      if (!db.objectStoreNames.contains('roots'))     db.createObjectStore('roots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv'))        db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('band'))      db.createObjectStore('band', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('peaks'))     db.createObjectStore('peaks', { keyPath: 'id' });
      void e;
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  }).catch((err) => { dbp = null; throw err; });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    // `out` may be a value or a promise; resolve() adopts thenables either way.
    const out = fn(t.objectStore(store), t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ------------------------------------------------------------------ tracks */

export const getAllTracks = () => tx('tracks', 'readonly', (s) => wrap(s.getAll()));

/** Bulk upsert. One transaction for the whole batch — thousands of rows in ms. */
export function putTracks(list) {
  return tx('tracks', 'readwrite', (s) => { for (const t of list) s.put(t); });
}

export function deleteTracks(ids) {
  return tx('tracks', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
}

export const clearTracks = () => tx('tracks', 'readwrite', (s) => s.clear());

/* ------------------------------------------------------------------ artwork */

export const getArt    = (key) => tx('art', 'readonly',  (s) => wrap(s.get(key)));
export const putArt    = (key, blob) => tx('art', 'readwrite', (s) => s.put(blob, key));
export const artKeys   = () => tx('art', 'readonly', (s) => wrap(s.getAllKeys()));
export const deleteArt = (keys) => tx('art', 'readwrite', (s) => { for (const k of keys) s.delete(k); });

/* ------------------------------------------------------------------ roots */

export const getRoots   = () => tx('roots', 'readonly', (s) => wrap(s.getAll()));
export const putRoot    = (r) => tx('roots', 'readwrite', (s) => s.put(r));
export const deleteRoot = (id) => tx('roots', 'readwrite', (s) => s.delete(id));

/* ------------------------------------------------------------------ playlists */

export const getPlaylists  = () => tx('playlists', 'readonly', (s) => wrap(s.getAll()));
export const putPlaylist   = (p) => tx('playlists', 'readwrite', (s) => s.put(p));
export const deletePlaylist = (id) => tx('playlists', 'readwrite', (s) => s.delete(id));

/* ------------------------------------------------------------------ band */

/* Cached answers from the online Band Overview. Keyed by the query that
   produced them, stamped so they can expire. */
export const getBand   = (key) => tx('band', 'readonly',  (s) => wrap(s.get(key)));
export const putBand   = (rec) => tx('band', 'readwrite', (s) => s.put(rec));
export const clearBands = () => tx('band', 'readwrite', (s) => s.clear());
export const bandCount = () => tx('band', 'readonly', (s) => wrap(s.count()));

/* ------------------------------------------------------------------ peaks */

/* One waveform and one coarse spectrogram per track, computed the first time
   the track is played and kept for good. Typed arrays go into IndexedDB as
   themselves — the structured clone keeps them typed — so what comes back out
   can be drawn without a parse. */
export const getPeaks    = (id) => tx('peaks', 'readonly',  (s) => wrap(s.get(id)));
export const putPeaks    = (rec) => tx('peaks', 'readwrite', (s) => s.put(rec));
export const peaksKeys   = () => tx('peaks', 'readonly', (s) => wrap(s.getAllKeys()));
export const deletePeaks = (ids) => tx('peaks', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
export const clearPeaks  = () => tx('peaks', 'readwrite', (s) => s.clear());
export const peaksCount  = () => tx('peaks', 'readonly', (s) => wrap(s.count()));

/* ------------------------------------------------------------------ kv */

export const getKV = (k) => tx('kv', 'readonly',  (s) => wrap(s.get(k)));
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

export async function wipe() {
  const db = await open();
  db.close();
  dbp = null;
  await new Promise((res, rej) => {
    const req = indexedDB.deleteDatabase(NAME);
    req.onsuccess = res; req.onerror = () => rej(req.error); req.onblocked = res;
  });
}

/** Rough on-disk footprint, for the settings panel. */
export async function usage() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? { used: est.usage || 0, quota: est.quota || 0 } : null;
  } catch { return null; }
}

/*
 * Whether the browser has promised to keep any of this.
 *
 * Everything Sonora lets you change is an overlay in here — playlists,
 * favourites, tag corrections, the covers you chose, racks bound to records,
 * every hour of listening it has ever counted. None of it is written to your
 * files, which is the whole point and is also the risk: without a persistence
 * grant an origin's storage is *best-effort*, and a browser short of room may
 * evict the lot without asking and without a way back. There is no server copy,
 * because there is no server.
 *
 * Asking is cheap and the answer is worth showing rather than assuming. On
 * Firefox this prompts; on Chromium it is decided from how the site is used, so
 * the honest thing is to ask once there is something to lose and then report
 * whatever came back.
 */
export async function persisted() {
  try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
}

export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return { supported: false, granted: false };
    if (await navigator.storage.persisted()) return { supported: true, granted: true };
    return { supported: true, granted: !!(await navigator.storage.persist()) };
  } catch { return { supported: false, granted: false }; }
}
