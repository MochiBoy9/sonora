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
import { Emitter, LRU, hash32, albumKeyOf, norm, isAudio, sortName, cmpText, idle } from './util.js';

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

/* ------------------------------------------------------------------ indexes */

function scheduleReindex() {
  if (reindexQueued) return;
  reindexQueued = true;
  requestAnimationFrame(() => { reindexQueued = false; reindex(); });
}

export function reindex() {
  const albumBy = new Map();
  const artistBy = new Map();

  for (const t of state.tracks.values()) {
    let al = albumBy.get(t.albumKey);
    if (!al) {
      albumBy.set(t.albumKey, al = {
        key: t.albumKey, title: t.album, artist: t.albumArtist,
        artistKey: t.artistKey, year: t.year || 0, tracks: [],
        duration: 0, addedAt: 0, sort: norm(t.album), accent: null,
      });
    }
    al.tracks.push(t);
    al.duration += t.duration || 0;
    if (!al.accent && t.accent) al.accent = t.accent;
    if (t.year && (!al.year || t.year < al.year)) al.year = t.year;
    if (t.addedAt > al.addedAt) al.addedAt = t.addedAt;

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

/** Universal path: a folder chosen through <input webkitdirectory>. */
export async function addFileList(fileList, label) {
  const files = Array.from(fileList).filter((f) => isAudio(f.name));
  if (!files.length) return null;

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

  const entries = files.map((f) => {
    const rel = f.webkitRelativePath || f.name;
    const cut = rel.indexOf('/');
    return { file: f, path: cut >= 0 ? rel.slice(cut + 1) : rel, name: f.name };
  });
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
        roots.push({ id: 'd:loose', name: 'Dropped files', kind: 'handle', loose: h });
      }
    }
    events.emit('roots');
    const dirs = roots.filter((r) => r.handle);
    if (dirs.length) { for (const r of dirs) await scanRoot(r); return dirs[0]; }

    const loose = roots.filter((r) => r.loose);
    if (loose.length) {
      let root = state.roots.find((r) => r.id === 'd:loose');
      if (!root) {
        root = { id: 'd:loose', name: 'Dropped files', kind: 'handle', count: 0 };
        state.roots.push(root);
        events.emit('roots');
      }
      await ingest(root, loose.map((r) => ({ handle: r.loose, path: r.loose.name, name: r.loose.name })));
      return root;
    }
  }

  const files = Array.from(dt.files || []).filter((f) => isAudio(f.name));
  if (files.length) return addFileList(files, 'Dropped files');
  return null;
}

/** Walks a handle root, diffs against what we already know, imports the rest. */
export async function scanRoot(root) {
  if (!root.handle) return;
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
  state.progress = { done: 0, total: 0 };
  events.emit('scan', true);
}

function finishScan() {
  if (!state.scanning) return;
  state.scanning = false;
  events.emit('scan', false);
  reindex();
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

/* ------------------------------------------------------------------ boot */

/** Paints the stored library first, then reconnects to disk in the background. */
export async function init() {
  const [tracks, roots, playlists, recent] = await Promise.all([
    db.getAllTracks().catch(() => []),
    db.getRoots().catch(() => []),
    db.getPlaylists().catch(() => []),
    db.getKV('recent').catch(() => null),
  ]);

  for (const t of tracks) { decorate(t); state.tracks.set(t.id, t); }
  state.roots = roots;
  state.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
  history.recent = Array.isArray(recent) ? recent : [];
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
