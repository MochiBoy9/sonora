/* db.js — IndexedDB persistence.
 *
 * The library survives reloads: metadata, cover thumbnails, playlists and (on
 * Chromium) the directory handles themselves, which are structured-cloneable.
 * Startup therefore paints a full library from disk before touching the
 * filesystem at all; rescanning happens afterwards, in the background.
 */

const NAME = 'sonora';
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
