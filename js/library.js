/* library.js — owns the collection: ingestion, indexes, artwork, playlists.
 *
 * Three ways in, because the filesystem APIs are not evenly supported:
 *   1. showDirectoryPicker()          — Chromium. Handles persist, so a folder
 *                                        added once is still there next launch.
 *   2. <input type=file webkitdirectory> — everyone else. Works fully for the
 *                                        session; metadata is remembered, and
 *                                        the folder is re-picked on return.
 *   3. drag and drop                  — either of the above, plus loose files.
 *
 * Indexes are plain arrays rebuilt in one pass. For 50k tracks that is a few
 * milliseconds, which is cheaper than maintaining incremental structures.
 */

import * as db from './db.js';
import { Emitter, LRU, AUDIO_EXT, hash32, albumKeyOf, norm, isAudio, isAudioFile, isLyric, sortName, cmpText, idle } from './util.js';

export const events = new Emitter();

/* ------------------------------------------------------------------ state */

export const state = {
  tracks: new Map(),            // id -> track record
  albums: [],                   // sorted
  artists: [],                  // sorted
  albumBy: new Map(),           // albumKey -> album
  artistBy: new Map(),          // artistKey -> artist
  playlists: [],
  roots: [],                    // { id, name, kind, handle?, count }
  scanning: false,
  progress: { done: 0, total: 0 },
};

/** Live file references. Not persisted — rebuilt by rescanning on launch. */
const handles = new Map();      // id -> FileSystemFileHandle | File

/**
 * Lyric files noticed beside the music, keyed by the track id with its
 * extension taken off — so `d:1/Petra Vance/04 Ferry Road.lrc` is filed under
 * `d:1/Petra Vance/04 Ferry Road` and found by the track of the same name.
 *
 * Not persisted, for the same reason handles are not: a File cannot be stored
 * and a handle without permission cannot be read. They are found again by the
 * same scan that finds the music.
 */
const sidecars = new Map();

/** The file that would hold this track's words, if one came in beside it. */
export function lyricFileFor(id) {
  const hit = sidecars.get(String(id).replace(/\.[^./]+$/, ''));
  if (!hit) return null;
  return hit instanceof File ? Promise.resolve(hit) : hit.getFile().catch(() => null);
}

let worker = null;
let workerReady = false;
let reindexQueued = false;
const pendingArt = [];          // [{key, blob, accent}] awaiting a DB write

/* ------------------------------------------------------------------ worker */

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./metadata.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[sonora] worker unavailable, parsing on main thread', err);
    worker = null;
    return null;
  }
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') { workerReady = true; return; }
    if (msg.type === 'tracks') return absorb(msg.tracks);
    if (msg.type === 'progress') {
      state.progress = { done: msg.done, total: msg.total };
      events.emit('progress', state.progress);
    } else if (msg.type === 'done') {
      flushArt();
      finishScan();
    }
  };
  worker.onerror = (err) => console.warn('[sonora] worker error', err);
  return worker;
}

/** Incoming batch from the parser: merge, persist, repaint. */
function absorb(batch) {
  const rows = [];
  for (const { track, art } of batch) {
    decorate(track);
    state.tracks.set(track.id, track);
    rows.push(track);
    if (art) pendingArt.push(art);
  }
  db.putTracks(rows).catch(() => {});
  if (pendingArt.length >= 24) flushArt();
  scheduleReindex();
}

function flushArt() {
  if (!pendingArt.length) return;
  const items = pendingArt.splice(0, pendingArt.length);
  for (const a of items) {
    db.putArt(a.key, a.blob).catch(() => {});
    if (a.accent) accents.set(a.key, a.accent);
    // Seed the cache from the blob we already hold: no round trip, and it
    // clears any "no art here" verdict reached while the import was running.
    artMisses.delete(a.key);
    artPending.delete(a.key);
    if (!artURLs.has(a.key)) artURLs.set(a.key, URL.createObjectURL(a.blob));
  }
  events.emit('art', items.map((a) => a.key));
}

/* ------------------------------------------------------------------ records */

/** Adds the derived fields every view depends on. Called once per track. */
function decorate(t) {
  // `guessed` lists the fields the tag reader had to take from the folder tree.
  // Resolve it into one flag now, while the raw values are still distinguishable:
  // an ALBUMARTIST frame is always a real claim, and a bare artist is only a
  // real claim if it did not come from a parent directory's name.
  // Decided once and stored with the track: by the second call `albumArtist`
  // has already been filled in from `artist` below, so the evidence is gone.
  if (typeof t.namedArtist !== 'boolean') {
    const guessed = String(t.guessed || '').split(' ');
    t.namedArtist = !!t.albumArtist || !guessed.includes('artist');
  }

  t.artist ||= 'Unknown Artist';
  t.album ||= 'Unknown Album';
  t.title ||= t.name || 'Untitled';
  t.albumArtist ||= t.artist;
  t.artistKey = hash32(norm(t.albumArtist));
  t.search = norm(t.title + ' ' + t.artist + ' ' + t.album + ' ' + (t.genre || ''));
  t.sortTitle = norm(t.title);
  return t;
}

const accents = new Map();      // albumKey -> [r,g,b], filled during import
export const accentFor = (key) =>
  accents.get(key) || state.albumBy.get(key)?.accent || null;

/* ------------------------------------------------------------------ serial */

/**
 * This library's own number.
 *
 * Instruments have serial numbers, and this one has a use beyond the
 * conceit: an exported rack preset can say which machine made it, and a
 * support question can name a library without naming anything in it. It is
 * random, generated once and kept — derived from nothing, so it identifies
 * this installation and cannot be turned back into a fact about the listener.
 */
export let serial = '';

function makeSerial() {
  // Crockford's alphabet: no I, L, O or U, so nothing is misread aloud or
  // mistyped, and nothing accidentally spells anything.
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues
    ? crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = (Math.random() * 256) | 0; });
  let out = '';
  for (let i = 0; i < 8; i++) out += A[bytes[i] % 32];
  return `SNR-${out.slice(0, 4)}-${out.slice(4)}`;
}

/* ------------------------------------------------------------------ census */

/**
 * What the library is actually made of, counted in one pass.
 *
 * Everything here is already in the index — this only groups it. Tracks that
 * predate the reader keeping stream details simply do not appear in those
 * tallies, and the `known` counts are what let the page say so instead of
 * implying the collection is 90% "unknown".
 */
export function census() {
  const formats = new Map();
  const rates = new Map();
  const depths = new Map();
  let bytes = 0, known = { rate: 0, depth: 0 }, lossless = 0;
  const LOSSLESS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'alac', 'ape', 'wv', 'tta']);

  for (const t of state.tracks.values()) {
    const e = (t.name || '').slice((t.name || '').lastIndexOf('.') + 1).toLowerCase() || '?';
    formats.set(e, (formats.get(e) || 0) + 1);
    bytes += t.size || 0;
    if (LOSSLESS.has(e)) lossless++;
    if (t.sampleRate > 0) { rates.set(t.sampleRate, (rates.get(t.sampleRate) || 0) + 1); known.rate++; }
    if (t.bitDepth > 0) { depths.set(t.bitDepth, (depths.get(t.bitDepth) || 0) + 1); known.depth++; }
  }

  const rank = (m) => [...m].sort((a, b) => b[1] - a[1]);
  return {
    total: state.tracks.size, bytes, lossless,
    formats: rank(formats), rates: rank(rates), depths: rank(depths), known,
  };
}

/* ------------------------------------------------------------------ indexes */

function scheduleReindex() {
  if (reindexQueued) return;
  reindexQueued = true;
  requestAnimationFrame(() => { reindexQueued = false; reindex(); });
}

export function reindex() {
  const albumBy = new Map();

  for (const t of state.tracks.values()) {
    let al = albumBy.get(t.albumKey);
    if (!al) {
      albumBy.set(t.albumKey, al = {
        key: t.albumKey, title: t.album, artist: t.albumArtist,
        artistKey: t.artistKey, year: t.year || 0, tracks: [],
        duration: 0, addedAt: 0, sort: norm(t.album), accent: null,
        named: false,
      });
    }
    // `named` records whether any file in the album actually claimed this
    // artist. A name lifted off a parent folder is a placeholder wearing a
    // real name, and the merge pass has to be able to tell.
    if (!al.named && t.namedArtist) al.named = true;
    al.tracks.push(t);
    al.duration += t.duration || 0;
    if (!al.accent && t.accent) al.accent = t.accent;
    if (t.year && (!al.year || t.year < al.year)) al.year = t.year;
    if (t.addedAt > al.addedAt) al.addedAt = t.addedAt;
  }

  // Albums fold together before artists are counted, because folding one in
  // can hand its tracks a different artist — and an artist index built first
  // would keep a page for a folder name that no longer names anything.
  mergeAlbums(albumBy);

  const artistBy = new Map();
  for (const t of state.tracks.values()) {
    let ar = artistBy.get(t.artistKey);
    if (!ar) {
      artistBy.set(t.artistKey, ar = {
        key: t.artistKey, name: t.albumArtist, tracks: [],
        albums: new Set(), duration: 0, sort: norm(sortName(t.albumArtist)),
      });
    }
    ar.tracks.push(t);
    ar.albums.add(t.albumKey);
    ar.duration += t.duration || 0;
  }

  for (const al of albumBy.values()) {
    al.tracks.sort((a, b) => (a.disc - b.disc) || (a.track - b.track) || cmpText(a.title, b.title));
  }
  for (const ar of artistBy.values()) {
    ar.albumList = [...ar.albums].map((k) => albumBy.get(k)).filter(Boolean)
      .sort((a, b) => (b.year - a.year) || cmpText(a.title, b.title));
  }

  state.albumBy = albumBy;
  state.artistBy = artistBy;
  state.albums = [...albumBy.values()].sort((a, b) =>
    cmpText(a.artist, b.artist) || (a.year - b.year) || cmpText(a.title, b.title));
  state.artists = [...artistBy.values()].sort((a, b) => cmpText(a.sort, b.sort));

  events.emit('change');
}

/** Albums folded together since the current import began: key -> title. */
const mergedThisScan = new Map();

/**
 * Folds albums that are the same album back together.
 *
 * Grouping is by hash of (album artist + album title), which is right until the
 * tags disagree — and across a library assembled by hand they disagree
 * constantly. Half a record ripped with an ALBUMARTIST frame and half without
 * lands as two albums called Graduation; so does one folder tagged "Kanye West"
 * and another tagged "Kanye west".
 *
 * So after the index is built, albums whose normalised titles match are
 * reconsidered: they merge when their artists also match once normalised, or
 * when one side has no artist worth the name. That last phrase does a lot of
 * work, because an untagged rip is never nameless — the tag reader falls back
 * to the folder tree, so half of Graduation sitting in Unsorted/Rips arrives
 * claiming to be by "Unsorted". Tracks record whether their artist was read or
 * guessed, and a guessed one counts as no artist here. Two different records
 * that happen to share a title — every "Greatest Hits" ever pressed — still do
 * not merge, because both sides named themselves and the names differ.
 *
 * The surviving album keeps the key most of its tracks already carry, so
 * artwork stored under that key stays attached.
 */
function mergeAlbums(albumBy) {
  const byTitle = new Map();
  for (const al of albumBy.values()) {
    const title = al.sort;                       // already normalised
    if (!title || title === norm('Unknown Album')) continue;
    let list = byTitle.get(title);
    if (!list) byTitle.set(title, list = []);
    list.push(al);
  }

  // "No artist worth the name": absent, a placeholder, or a folder name that
  // was pressed into service because the files carried no artist at all.
  const vague = (al) => {
    const n = norm(al.artist);
    return !n || !al.named || n === 'unknown artist' || n === 'various artists' || n === 'va';
  };

  const merged = [];

  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    // Biggest first: it wins the key, and its artwork with it.
    list.sort((a, b) => b.tracks.length - a.tracks.length);

    for (let i = 0; i < list.length; i++) {
      const keep = list[i];
      if (!albumBy.has(keep.key)) continue;      // already absorbed
      for (let j = i + 1; j < list.length; j++) {
        const other = list[j];
        if (!albumBy.has(other.key) || other === keep) continue;
        const same = norm(keep.artist) === norm(other.artist);
        if (!same && !vague(keep) && !vague(other)) continue;

        for (const t of other.tracks) {
          t.albumKey = keep.key;                 // rows follow the survivor
          keep.tracks.push(t);
        }
        keep.duration += other.duration;
        keep.addedAt = Math.max(keep.addedAt, other.addedAt);
        keep.year = keep.year || other.year;
        keep.accent = keep.accent || other.accent;
        if (vague(keep) && !vague(other)) {
          keep.artist = other.artist;
          keep.artistKey = other.artistKey;
          keep.named = other.named;
        }
        keep.merged = (keep.merged || 1) + 1;
        // Noted here, where it happens, rather than read back off the index
        // afterwards. A merge rewrites `albumKey` on the tracks it moves, so by
        // the second pass over the same library there is nothing left to find —
        // and whether `finishScan` saw the pass that did the folding used to
        // depend on which side of a requestAnimationFrame the worker finished.
        mergedThisScan.set(keep.key, keep.title);
        merged.push(keep);
        albumBy.delete(other.key);
      }
    }
  }

  // Last, because the survivor's own artist can be filled in by any of the
  // albums it absorbs: a track whose "artist" was only the folder it sat in
  // belongs to whoever actually made the record.
  for (const al of merged) {
    if (vague(al)) continue;
    for (const t of al.tracks) {
      if (t.namedArtist) continue;
      t.artist = al.artist;
      t.albumArtist = al.artist;
      t.artistKey = al.artistKey;
      t.search = norm(t.title + ' ' + al.artist + ' ' + t.album + ' ' + (t.genre || ''));
    }
  }
}

/* ------------------------------------------------------------------ queries */

export const allTracks = () => [...state.tracks.values()];
export const getTrack = (id) => state.tracks.get(id);
export const isAvailable = (id) => handles.has(id);
export const trackCount = () => state.tracks.size;

export function sortTracks(list, key, dir = 1) {
  const by = {
    title:  (a, b) => cmpText(a.title, b.title),
    artist: (a, b) => cmpText(a.artist, b.artist) || cmpText(a.album, b.album) || (a.track - b.track),
    album:  (a, b) => cmpText(a.album, b.album) || (a.disc - b.disc) || (a.track - b.track),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    added:  (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    year:   (a, b) => (a.year || 0) - (b.year || 0),
    // Unmeasured tracks sort as zero, which puts them at the quiet end
    // ascending and out of the way descending — either is better than
    // pretending they are the most squashed masters in the library.
    dr:     (a, b) => (a.dr || 0) - (b.dr || 0),
  }[key] || ((a, b) => cmpText(a.title, b.title));
  return list.slice().sort((a, b) => by(a, b) * dir);
}

/**
 * Ranked search across tracks, albums and artists. One linear pass with
 * precomputed haystacks; ~2 ms over 50k tracks, so it runs on every keystroke.
 */
export function search(query, limit = 60) {
  const q = norm(query).trim();
  if (!q) return { tracks: [], albums: [], artists: [], query: '' };
  const terms = q.split(/\s+/);

  const scoreOf = (hay, name) => {
    let score = 0;
    for (const term of terms) {
      const i = hay.indexOf(term);
      if (i < 0) return 0;
      score += i === 0 ? 12 : hay[i - 1] === ' ' ? 8 : 3;
    }
    if (name && norm(name) === q) score += 40;
    else if (name && norm(name).startsWith(q)) score += 16;
    return score;
  };

  const tracks = [];
  for (const t of state.tracks.values()) {
    const s = scoreOf(t.search, t.title);
    if (s) tracks.push({ s: s + (t.playCount || 0) * 0.5, t });
  }
  tracks.sort((a, b) => b.s - a.s);

  const albums = [];
  for (const a of state.albums) {
    const s = scoreOf(a.sort + ' ' + norm(a.artist), a.title);
    if (s) albums.push({ s, a });
  }
  albums.sort((x, y) => y.s - x.s);

  const artists = [];
  for (const a of state.artists) {
    const s = scoreOf(a.sort, a.name);
    if (s) artists.push({ s, a });
  }
  artists.sort((x, y) => y.s - x.s);

  return {
    query,
    tracks: tracks.slice(0, limit).map((x) => x.t),
    albums: albums.slice(0, 24).map((x) => x.a),
    artists: artists.slice(0, 12).map((x) => x.a),
  };
}

/* ------------------------------------------------------------------ artwork */

const artURLs = new LRU(320, (url) => URL.revokeObjectURL(url));
const artMisses = new Set();
const artPending = new Map();

/** Cached object URL for an album cover, or null when there is no art. */
export function artURL(key) {
  if (!key || artMisses.has(key)) return null;
  return artURLs.get(key) || null;
}

export function loadArt(key) {
  if (!key || artMisses.has(key)) return Promise.resolve(null);
  const hit = artURLs.get(key);
  if (hit) return Promise.resolve(hit);
  let p = artPending.get(key);
  if (p) return p;
  p = db.getArt(key).then((blob) => {
    artPending.delete(key);
    const raced = artURLs.get(key);          // an import may have won the race
    if (raced) return raced;
    if (!blob) { artMisses.add(key); return null; }
    const url = URL.createObjectURL(blob);
    artURLs.set(key, url);
    return url;
  }).catch(() => { artPending.delete(key); return null; });
  artPending.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ files */

/** Resolves a playable File for a track, re-checking permission if needed. */
export async function fileFor(id) {
  const h = handles.get(id);
  if (!h) return null;
  if (h instanceof File) return h;
  try {
    return await h.getFile();
  } catch {
    handles.delete(id);
    return null;
  }
}

/* ------------------------------------------------------------------ scanning */

const MAX_DEPTH = 12;

async function* walkDirectory(dir, prefix = '', depth = 0) {
  if (depth > MAX_DEPTH) return;
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') {
      if (entry.name.startsWith('.')) continue;
      yield* walkDirectory(entry, prefix + entry.name + '/', depth + 1);
    } else if (isAudio(entry.name)) {
      yield { handle: entry, path: prefix + entry.name, name: entry.name };
    } else if (isLyric(entry.name)) {
      yield { handle: entry, path: prefix + entry.name, name: entry.name, lyric: true };
    }
  }
}

export const canPickDirectory = () => typeof window.showDirectoryPicker === 'function';

/** Chromium path: a real directory handle we can persist and re-open. */
export async function addDirectory() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'sonora-music', mode: 'read' });
  } catch { return null; }             // user cancelled

  const id = 'd:' + hash32(dir.name + ':' + Date.now());
  const root = { id, name: dir.name, kind: 'handle', handle: dir, count: 0 };
  state.roots.push(root);
  await db.putRoot(root).catch(() => {});
  events.emit('roots');
  await scanRoot(root);
  return root;
}

/** Can this browser hand us individual files with real handles? */
export const canPickFiles = () => typeof window.showOpenFilePicker === 'function';

/**
 * Individual files rather than a folder. Everything picked lands under one
 * root, wherever on disk it came from — the album grouping does the rest.
 */
export async function addFiles() {
  if (!canPickFiles()) return null;
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      id: 'sonora-files',
      multiple: true,
      types: [{
        description: 'Audio',
        accept: { 'audio/*': [...AUDIO_EXT].map((e) => '.' + e) },
      }],
      excludeAcceptAllOption: false,
    });
  } catch { return null; }                        // user cancelled
  if (!handles || !handles.length) return null;

  const root = ensureLooseRoot();
  await ingest(root, handles
    .filter((h) => isAudio(h.name))
    .map((h) => ({ handle: h, path: h.name, name: h.name })));
  return root;
}

/** The bucket loose files live in, created on demand. */
function ensureLooseRoot() {
  let root = state.roots.find((r) => r.id === LOOSE_ID);
  if (!root) {
    root = { id: LOOSE_ID, name: 'Selected files', kind: 'handle', count: 0 };
    state.roots.push(root);
    db.putRoot(serialiseRoot(root)).catch(() => {});
    events.emit('roots');
  }
  return root;
}

const LOOSE_ID = 'd:loose';

/** Universal path: a folder chosen through <input webkitdirectory>. */
export async function addFileList(fileList, label) {
  const all = Array.from(fileList);
  // isAudioFile, not isAudio: a File knows its own type, so a container with an
  // unfamiliar suffix still counts if the OS calls it audio.
  const files = all.filter(isAudioFile);
  if (!files.length) return null;

  // Lyric sidecars come in with the music or not at all. A folder handed over
  // by an upload dialog cannot be reopened to look for them afterwards, so the
  // one chance to notice `04 Ferry Road.lrc` sitting beside `04 Ferry Road.mp3`
  // is right now, while the browser still has both.
  const lyrics = all.filter((f) => isLyric(f.name));

  const first = files[0].webkitRelativePath || '';
  const name = label || first.split('/')[0] || 'Files';
  const id = 'f:' + hash32(name);
  let root = state.roots.find((r) => r.id === id);
  if (!root) {
    root = { id, name, kind: 'files', count: 0 };
    state.roots.push(root);
    await db.putRoot({ id, name, kind: 'files', count: 0 }).catch(() => {});
    events.emit('roots');
  }

  const relative = (f) => {
    const rel = f.webkitRelativePath || f.name;
    const cut = rel.indexOf('/');
    return cut >= 0 ? rel.slice(cut + 1) : rel;
  };
  const entries = files.map((f) => ({ file: f, path: relative(f), name: f.name }));
  for (const f of lyrics) entries.push({ file: f, path: relative(f), name: f.name, lyric: true });
  await ingest(root, entries);
  return root;
}

/** Drag-and-drop: prefers real handles, falls back to the legacy entry API. */
export async function addDataTransfer(dt) {
  const items = Array.from(dt.items || []).filter((i) => i.kind === 'file');
  if (!items.length) return null;

  if (typeof items[0].getAsFileSystemHandle === 'function') {
    const roots = [];
    for (const item of items) {
      let h = null;
      try { h = await item.getAsFileSystemHandle(); } catch { /* not supported */ }
      if (!h) continue;
      if (h.kind === 'directory') {
        const id = 'd:' + hash32(h.name + ':' + Date.now());
        const root = { id, name: h.name, kind: 'handle', handle: h, count: 0 };
        state.roots.push(root);
        await db.putRoot(root).catch(() => {});
        roots.push(root);
      } else if (isAudio(h.name)) {
        roots.push({ id: LOOSE_ID, name: 'Selected files', kind: 'handle', loose: h });
      }
    }
    events.emit('roots');
    const dirs = roots.filter((r) => r.handle);
    if (dirs.length) { for (const r of dirs) await scanRoot(r); return dirs[0]; }

    const loose = roots.filter((r) => r.loose);
    if (loose.length) {
      const root = ensureLooseRoot();
      await ingest(root, loose.map((r) => ({ handle: r.loose, path: r.loose.name, name: r.loose.name })));
      return root;
    }
  }

  // Handed over whole rather than pre-filtered: addFileList picks the audio out
  // itself, and it also picks out the lyric sidecars — which a filter to
  // `isAudioFile` here would have thrown away before it ever saw them.
  const all = Array.from(dt.files || []);
  if (all.some(isAudioFile)) return addFileList(all, 'Dropped files');
  return null;
}

/** Walks a handle root, diffs against what we already know, imports the rest. */
export async function scanRoot(root) {
  // The loose-files bucket has no directory to walk: its handles are held
  // individually, and re-scanning it would diff against an empty listing and
  // delete every track in it.
  if (root.id === LOOSE_ID || !root.handle) return;
  if (root.handle.queryPermission) {
    let perm = await root.handle.queryPermission({ mode: 'read' });
    if (perm === 'prompt') {
      try { perm = await root.handle.requestPermission({ mode: 'read' }); } catch { perm = 'denied'; }
    }
    if (perm !== 'granted') {
      root.needsPermission = true;
      events.emit('roots');
      return;
    }
    root.needsPermission = false;
  }
  const entries = [];
  for await (const e of walkDirectory(root.handle)) entries.push(e);
  await ingest(root, entries);
}

/**
 * Diffs a set of entries against the stored library: unchanged files only get
 * their handle re-attached, new or modified files go to the parser, and files
 * that vanished from disk are dropped.
 */
async function ingest(root, entries) {
  startScan();
  const jobs = [];
  const seen = new Set();

  for (const e of entries) {
    // A lyric file is not a track. It is filed under the audio file it sits
    // beside, by the path they share up to the extension, and never given an
    // id of its own — otherwise "04 Ferry Road.lrc" turns up in the library as
    // a song nobody can play.
    if (e.lyric) {
      sidecars.set(root.id + '/' + e.path.replace(/\.[^./]+$/, ''), e.handle || e.file);
      continue;
    }

    const id = root.id + '/' + e.path;
    seen.add(id);
    let file = e.file;
    if (!file && e.handle) {
      try { file = await e.handle.getFile(); } catch { continue; }
    }
    if (!file) continue;

    handles.set(id, e.handle || file);

    const known = state.tracks.get(id);
    if (known && known.size === file.size && known.mtime === file.lastModified) continue;

    jobs.push({
      id, path: e.path, name: e.name, size: file.size,
      mtime: file.lastModified, rootId: root.id, file,
    });
  }

  // Anything under this root we no longer see on disk is gone.
  const stale = [];
  for (const [id, t] of state.tracks) {
    if (t.rootId === root.id && !seen.has(id)) { stale.push(id); state.tracks.delete(id); handles.delete(id); }
  }
  if (stale.length) db.deleteTracks(stale).catch(() => {});

  root.count = seen.size;
  root.needsReconnect = false;
  root.needsPermission = false;
  db.putRoot(serialiseRoot(root)).catch(() => {});
  events.emit('roots');

  if (!jobs.length) { scheduleReindex(); finishScan(); return; }

  const w = ensureWorker();
  if (w) {
    w.postMessage({ type: 'knownAlbums', keys: [...state.albumBy.keys()] });
    for (let i = 0; i < jobs.length; i += 150) {
      w.postMessage({ type: 'scan', jobs: jobs.slice(i, i + 150) });
    }
  } else {
    await parseOnMainThread(jobs);
    finishScan();
  }
  scheduleReindex();
}

const serialiseRoot = (r) => ({ id: r.id, name: r.name, kind: r.kind, handle: r.handle, count: r.count });

function startScan() {
  if (state.scanning) return;
  state.scanning = true;
  // Folds from before this import — the ones the launch reindex did — are the
  // library's history, not this import's news.
  mergedThisScan.clear();
  state.progress = { done: 0, total: 0 };
  events.emit('scan', true);
}

function finishScan() {
  if (!state.scanning) return;
  state.scanning = false;
  reindex();

  // What the import actually did, in the terms the person cares about: how
  // many tracks arrived, and which albums got put back together.
  const added = state.progress.total || 0;
  const merged = [...mergedThisScan].map(([key, title]) => ({ key, title }));
  mergedThisScan.clear();
  events.emit('scan', false, { added, merged });
  state.progress = { done: 0, total: 0 };
}

/** Fallback for browsers without module workers. Chunked so the UI survives. */
async function parseOnMainThread(jobs) {
  const { readTags } = await import('./tags.js');
  const rows = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    let tags = {};
    try { tags = await readTags(j.file, j.path, j.name); } catch {}
    const t = decorate({
      id: j.id, path: j.path, name: j.name, size: j.size, mtime: j.mtime, rootId: j.rootId,
      title: tags.title, artist: tags.artist, album: tags.album, albumArtist: tags.albumArtist,
      track: parseInt(tags.track, 10) || 0, disc: parseInt(tags.disc, 10) || 1,
      year: parseInt(String(tags.year || '').slice(0, 4), 10) || 0,
      genre: tags.genre || '', duration: tags.duration || 0, addedAt: Date.now(),
      guessed: tags.guessed || '',
      // Same spec fields the worker keeps, so the fallback path produces the
      // same record rather than a quietly poorer one.
      sampleRate: tags.sampleRate > 0 ? tags.sampleRate | 0 : undefined,
      channels: tags.channels > 0 ? tags.channels | 0 : undefined,
      bitDepth: tags.bitDepth > 0 ? tags.bitDepth | 0 : undefined,
      bitrate: tags.duration > 0 && j.size > 0
        ? Math.round((j.size * 8) / tags.duration / 1000)
        : (tags.bitrate > 0 ? Math.round(tags.bitrate / 1000) : undefined),
    });
    t.albumKey = albumKeyOf(t.albumArtist || t.artist || '', t.album);
    state.tracks.set(t.id, t);
    rows.push(t);
    state.progress = { done: i + 1, total: jobs.length };
    if ((i & 31) === 0) { events.emit('progress', state.progress); await new Promise(requestAnimationFrame); }
  }
  await db.putTracks(rows).catch(() => {});
}

export async function removeRoot(rootId) {
  const stale = [];
  for (const [id, t] of state.tracks) {
    if (t.rootId === rootId) { stale.push(id); state.tracks.delete(id); handles.delete(id); }
  }
  state.roots = state.roots.filter((r) => r.id !== rootId);
  await Promise.all([db.deleteTracks(stale), db.deleteRoot(rootId)]).catch(() => {});
  events.emit('roots');
  reindex();

  // Cover art outlives its tracks unless we sweep it.
  const keys = await db.artKeys().catch(() => []);
  const orphans = keys.filter((k) => !state.albumBy.has(k));
  if (orphans.length) {
    for (const k of orphans) { artMisses.delete(k); artURLs.delete(k); }
    db.deleteArt(orphans).catch(() => {});
  }
}

export async function rescanAll() {
  for (const root of state.roots) {
    if (root.handle) await scanRoot(root);
  }
}

/* ------------------------------------------------------------------ playlists */

export async function createPlaylist(name, trackIds = []) {
  const p = { id: 'p:' + hash32(name + Date.now()), name, tracks: trackIds.slice(), createdAt: Date.now() };
  state.playlists.push(p);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  return p;
}

export async function updatePlaylist(id, patch) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  return p;
}

export async function addToPlaylist(id, trackIds) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const have = new Set(p.tracks);
  for (const t of trackIds) if (!have.has(t)) p.tracks.push(t);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
}

export async function removePlaylist(id) {
  state.playlists = state.playlists.filter((p) => p.id !== id);
  await db.deletePlaylist(id).catch(() => {});
  events.emit('playlists');
}

export const playlistTracks = (p) =>
  p.tracks.map((id) => state.tracks.get(id)).filter(Boolean);

/* ------------------------------------------------------------------ history */

export const history = { recent: [], plays: new Map() };

export function notePlay(track) {
  if (!track) return;
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayed = Date.now();
  history.recent = [track.id, ...history.recent.filter((id) => id !== track.id)].slice(0, 60);
  db.setKV('recent', history.recent).catch(() => {});
  db.putTracks([track]).catch(() => {});
  events.emit('history');
}

export const recentTracks = () => history.recent.map((id) => state.tracks.get(id)).filter(Boolean);

export function recentAlbums(limit = 12) {
  const seen = new Set(), out = [];
  for (const id of history.recent) {
    const t = state.tracks.get(id);
    if (!t || seen.has(t.albumKey)) continue;
    seen.add(t.albumKey);
    const al = state.albumBy.get(t.albumKey);
    if (al) out.push(al);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ favourites */

/**
 * The tracks worth keeping to hand.
 *
 * Held as an ordered list of ids beside the library rather than as a flag on
 * each record, for two reasons. A favourite is a fact about the listener, not
 * about the file, so it has to survive a re-import that rewrites every row it
 * would otherwise be stored on. And the order they were marked in is the order
 * the page wants them in — newest first, the same way `recent` works.
 *
 * An id whose track is not in the library right now is kept, not swept: a
 * folder that is disconnected today is reconnected tomorrow, and throwing the
 * mark away because the file is momentarily out of reach would be the one
 * thing the listener cannot undo.
 */
export const favourites = { ids: [], set: new Set() };

export const isFavourite = (id) => favourites.set.has(id);

/** Marks or unmarks a track. Returns the state it landed in. */
export function toggleFavourite(id, force) {
  if (!id) return false;
  const on = force === undefined ? !favourites.set.has(id) : !!force;
  if (on === favourites.set.has(id)) return on;
  if (on) {
    favourites.set.add(id);
    favourites.ids.unshift(id);
  } else {
    favourites.set.delete(id);
    const i = favourites.ids.indexOf(id);
    if (i >= 0) favourites.ids.splice(i, 1);
  }
  db.setKV('favourites', favourites.ids).catch(() => {});
  events.emit('favourites', id, on);
  return on;
}

/** Only the ones the library can actually reach, newest mark first. */
export const favouriteTracks = () =>
  favourites.ids.map((id) => state.tracks.get(id)).filter(Boolean);

/* ------------------------------------------------------------------ boot */

/** Paints the stored library first, then reconnects to disk in the background. */
export async function init() {
  const [tracks, roots, playlists, recent, faves, sn] = await Promise.all([
    db.getAllTracks().catch(() => []),
    db.getRoots().catch(() => []),
    db.getPlaylists().catch(() => []),
    db.getKV('recent').catch(() => null),
    db.getKV('favourites').catch(() => null),
    db.getKV('serial').catch(() => null),
  ]);

  serial = typeof sn === 'string' && sn ? sn : makeSerial();
  if (serial !== sn) db.setKV('serial', serial).catch(() => {});

  for (const t of tracks) { decorate(t); state.tracks.set(t.id, t); }
  state.roots = roots;
  state.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
  history.recent = Array.isArray(recent) ? recent : [];
  favourites.ids = Array.isArray(faves) ? faves.filter((id) => typeof id === 'string') : [];
  favourites.set = new Set(favourites.ids);
  reindex();
  events.emit('ready');

  // Reconnecting can prompt for permission, so it happens after first paint.
  idle(async () => {
    for (const root of state.roots) {
      if (root.kind === 'handle' && root.handle) await scanRoot(root);
      else if (root.kind === 'files') root.needsReconnect = true;
    }
    events.emit('roots');
  }, 400);
}
