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
import * as undo from './undo.js';
import { Emitter, LRU, AUDIO_EXT, hash32, albumKeyOf, norm, isAudio, isAudioFile, isLyric, sortName, cmpText, idle, ext } from './util.js';

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
    if (msg.type === 'cover') {
      const done = coverWaits.get(msg.id);
      if (done) { coverWaits.delete(msg.id); done(msg.blob ? msg : null); }
      return;
    }
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
    /* Corrections the listener made survive a rescan.
     *
     * The parser hands back what the file says, and what the file says has not
     * changed — Sonora does not write tags. So the edits are kept beside the
     * parsed values rather than replacing them, and re-applied on top here.
     * Clearing an edit therefore reveals the file's own tag again instead of
     * leaving a blank, which is the behaviour that makes the feature safe to
     * use on a library you care about. */
    const prior = state.tracks.get(track.id);
    if (prior && prior.edits) {
      track.edits = prior.edits;
      // The freshly parsed values are what the file says *now*, so they become
      // the new originals for the fields being overridden — a tag fixed in
      // another program and then reverted here lands on the corrected value
      // rather than on whatever it said the first time Sonora saw it.
      const orig = {};
      for (const k of Object.keys(prior.edits)) orig[k] = track[k];
      track.orig = orig;
      applyEdits(track);
    }
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
    /* An album whose cover the listener chose still stores what the files
       supplied — that is what "use the original again" restores — but the
       scanned one must not climb back into the caches on a rescan and quietly
       replace the chosen picture on screen. Store it, ignore it. */
    if (ownArt.has(a.key)) continue;
    if (a.accent) accents.set(a.key, a.accent);
    /* The surface, under its own key in the same store. A typed array goes
       into IndexedDB as itself, so it comes back out ready to read without a
       parse — and an album whose cover has no relief simply has no record,
       which is the same thing as "this one is flat". */
    if (a.relief) {
      reliefs.set(a.key, a.relief);
      db.putArt(a.key + '#relief', a.relief).catch(() => {});
    }
    // Seed the cache from the blob we already hold: no round trip, and it
    // clears any "no art here" verdict reached while the import was running.
    artMisses.delete(a.key);
    artPending.delete(a.key);
    if (!artURLs.has(a.key)) artURLs.set(a.key, URL.createObjectURL(a.blob));
  }
  events.emit('art', items.map((a) => a.key));
}

/* ------------------------------------------------------------------ records */

/* ------------------------------------------------------------------ edits
 *
 * Tag corrections, written to Sonora's index and never to the file.
 *
 * This is the whole design and it is a deliberate limit rather than a missing
 * feature. Writing tags means rewriting somebody's files in place, and a bug
 * in that costs them a library — Sonora has read the disk and not written to
 * it since the first line of it, and a spelling correction is not the reason
 * to change that.
 *
 * So an edit is an overlay. The parsed value stays where it was, the edit sits
 * beside it, and the edit wins when the record is read. Clearing a field
 * reveals the file's own tag again rather than leaving a blank, and a rescan
 * re-applies the overlay instead of losing it.
 */

/** Fields a listener may correct. Anything else is measured, not claimed. */
export const EDITABLE = ['title', 'artist', 'albumArtist', 'album', 'genre', 'track', 'disc', 'year'];

/** Lays a track's overlay over its parsed values. */
function applyEdits(t) {
  if (!t.edits) return t;
  for (const k of EDITABLE) {
    const v = t.edits[k];
    if (v === undefined) continue;
    t[k] = v;
  }
  return t;
}

/**
 * Corrects one or more tracks.
 *
 * `patch` holds only the fields being changed; a field set to `null` drops the
 * override and lets the file's own tag show through again. Returns the number
 * of tracks touched.
 */
/**
 * Everything about a track that an edit can move, as plain values.
 *
 * Deliberately a whole-state snapshot rather than a diff. Restoring `edits`
 * and `orig` alone is not enough — `applyEdits` only writes the fields that
 * are currently overridden, so a field whose override is being *removed* would
 * keep the new value with nothing left to say what it used to be. Eight
 * strings per corrected track is a rounding error against holding the file's
 * own tags, which we already do.
 */
function snapshotTracks(rows) {
  return rows.map((t) => {
    const s = { id: t.id, edits: t.edits ? { ...t.edits } : null, orig: t.orig ? { ...t.orig } : null };
    for (const k of EDITABLE) s[k] = t[k];
    return s;
  });
}

/** Puts snapshots back. Returns how many tracks were still there to put back. */
async function restoreTracks(snaps) {
  const rows = [];
  for (const s of snaps) {
    const t = state.tracks.get(s.id);
    if (!t) continue;               // the folder went away; see undo.js on staleness
    for (const k of EDITABLE) t[k] = s[k];
    if (s.edits) t.edits = { ...s.edits }; else delete t.edits;
    if (s.orig) t.orig = { ...s.orig }; else delete t.orig;
    t.albumKey = albumKeyOf(t.albumArtist || t.artist || '', t.album);
    decorate(t);
    rows.push(t);
  }
  if (rows.length) {
    await db.putTracks(rows).catch(() => {});
    reindex();
    events.emit('change');
  }
  return rows.length;
}

export async function editTracks(tracks, patch) {
  const rows = [];
  const before = [];
  for (const t of tracks) {
    const track = typeof t === 'string' ? state.tracks.get(t) : t;
    if (!track) continue;
    // Taken before anything moves, and thrown away below if nothing does.
    const was = snapshotTracks([track])[0];
    const edits = { ...(track.edits || {}) };
    /* What the file said, kept for exactly the fields that were overridden.
     *
     * The first version re-read the tag to undo an edit, which is tidier right
     * up until the file cannot be read — a folder picked as loose files has no
     * handle after a reload, so `fileFor` returns null, the re-read is skipped
     * and the field silently keeps the value being reverted. Observed. Holding
     * the original costs a few bytes on the tracks somebody actually corrected
     * and makes the undo exact, offline, and synchronous. */
    const orig = { ...(track.orig || {}) };
    let changed = false;

    for (const k of EDITABLE) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === null || v === undefined || v === '') {
        if (k in edits) {
          delete edits[k];
          if (k in orig) { track[k] = orig[k]; delete orig[k]; }
          changed = true;
        }
      } else if (edits[k] !== v) {
        // Record what it was before the first override of this field.
        if (!(k in edits) && !(k in orig)) orig[k] = track[k];
        edits[k] = v;
        changed = true;
      }
    }
    if (!changed) continue;

    if (Object.keys(edits).length) track.edits = edits; else delete track.edits;
    if (Object.keys(orig).length) track.orig = orig; else delete track.orig;

    applyEdits(track);
    // The album key is derived from the artist and album, so correcting either
    // moves the track to a different album — which is usually the point.
    track.albumKey = albumKeyOf(track.albumArtist || track.artist || '', track.album);
    track.namedArtist = true;
    decorate(track);
    rows.push(track);
    before.push(was);
  }

  if (rows.length) {
    await db.putTracks(rows).catch(() => {});
    reindex();
    events.emit('change');
    const after = snapshotTracks(rows);
    const what = rows.length === 1 ? `the correction to “${rows[0].title}”` : `${rows.length} corrections`;
    undo.push({ label: what, undo: () => restoreTracks(before), redo: () => restoreTracks(after) });
  }
  return rows.length;
}

/** Whether a track carries any correction at all. */
export const isEdited = (t) => !!(t && t.edits && Object.keys(t.edits).length);

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

/* albumKey -> { map, size, density }, the cover's own surface. Held in memory
   only for albums that have been looked at; a library of four hundred at 8 KB
   each would be three megabytes of normals nobody is currently hovering. */
const reliefs = new Map();
const reliefMisses = new Set();

/**
 * The relief map for an album, or null.
 *
 * Synchronous when it is already warm, which is the case that matters — this
 * is asked for on pointerenter and an await there would light the sleeve one
 * frame after the pointer arrived.
 */
export function reliefFor(key) {
  if (!key || reliefMisses.has(key)) return null;
  return reliefs.get(key) || null;
}

/** Fetches it from the store, once, for a sleeve that is about to want it. */
export function loadRelief(key) {
  if (!key || reliefs.has(key) || reliefMisses.has(key)) {
    return Promise.resolve(reliefs.get(key) || null);
  }
  return db.getArt(artKeyFor(key) + '#relief').then((rec) => {
    if (rec && rec.map) { reliefs.set(key, rec); return rec; }
    reliefMisses.add(key);
    return null;
  }).catch(() => { reliefMisses.add(key); return null; });
}
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

  for (const t of state.tracks.values()) {
    const e = (t.name || '').slice((t.name || '').lastIndexOf('.') + 1).toLowerCase() || '?';
    formats.set(e, (formats.get(e) || 0) + 1);
    bytes += t.size || 0;
    /* The extension is not enough on its own. ALAC lives in `.m4a` and so does
       AAC, so a library ripped to Apple Lossless would report as 0% lossless
       on the suffix alone — a wrong number, shown confidently.
       The measured bitrate settles it: MP3 tops out at 320 kbps and AAC is not
       used above about 500, so anything past that threshold is lossless
       whatever it is wrapped in. */
    if (LOSSLESS.has(e) || t.bitrate > 500) lossless++;
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
/* Containers that hold the whole signal. Used by the census and by the
   `lossless` search filter, which have to agree about what the word means. */
const LOSSLESS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'ape', 'wv', 'tta']);

/* ------------------------------------------------------------------ filters
 *
 * The one box people actually use only ever matched text in a title, an artist
 * and an album, while everything else the app knows sat unreachable from it.
 *
 * These are the questions worth being able to ask in passing — the ones that
 * would otherwise mean building a smart shelf for a thing you wanted to know
 * once. Each is a single comparison over a field that is already indexed, and
 * anything not recognised as a filter stays part of the text query, so typing
 * an ordinary search still behaves exactly as it always did.
 */
const FILTERS = [
  [/^before:(\d{4})$/, (t, m) => t.year > 0 && t.year < +m[1]],
  [/^after:(\d{4})$/, (t, m) => t.year > 0 && t.year > +m[1]],
  [/^year:(\d{4})$/, (t, m) => t.year === +m[1]],
  [/^>(\d+(?:\.\d+)?)min$/, (t, m) => (t.duration || 0) > +m[1] * 60],
  [/^<(\d+(?:\.\d+)?)min$/, (t, m) => (t.duration || 0) > 0 && t.duration < +m[1] * 60],
  [/^dr>(\d+(?:\.\d+)?)$/, (t, m) => t.dr > 0 && t.dr > +m[1]],
  [/^dr<(\d+(?:\.\d+)?)$/, (t, m) => t.dr > 0 && t.dr < +m[1]],
  [/^bpm>(\d+)$/, (t, m) => t.bpm > 0 && t.bpm > +m[1]],
  [/^bpm<(\d+)$/, (t, m) => t.bpm > 0 && t.bpm < +m[1]],
  [/^format:([a-z0-9]+)$/, (t, m) => ext(t.name || '') === m[1]],
  [/^fav(?:ourite)?$/, (t) => isFavourite(t.id)],
  [/^unplayed$/, (t) => !(t.playCount > 0)],
  [/^guessed$/, (t) => !!(t.guessed && t.guessed.length)],
  [/^edited$/, (t) => isEdited(t)],
  [/^lossless$/, (t) => LOSSLESS.has(ext(t.name || '')) || t.bitrate > 500],
  /* Suspected transcodes, from the encoder shelf the analysis measures. Only
     ever true for tracks that have actually been analysed, so this finds what
     is known rather than implying the rest are clean. */
  [/^suspect$/, (t) => t.truncated === true],
];

/** Splits a query into the filters it names and the words it does not. */
export function parseQuery(query) {
  const words = [];
  const filters = [];
  for (const raw of String(query || '').trim().split(/\s+/)) {
    if (!raw) continue;
    const token = raw.toLowerCase();
    let claimed = false;
    for (const [re, test] of FILTERS) {
      const m = token.match(re);
      if (!m) continue;
      filters.push({ token, test: (t) => test(t, m) });
      claimed = true;
      break;
    }
    if (!claimed) words.push(raw);
  }
  return { words, filters, text: words.join(' ') };
}

export function search(query, limit = 60) {
  const parsed = parseQuery(query);

  /* A query that is nothing but filters is still a query. "unplayed dr>14"
     names no words at all and should return every track that satisfies both,
     rather than the empty result an all-text search would give. */
  if (parsed.filters.length && !parsed.words.length) {
    const hits = [...state.tracks.values()].filter((t) => parsed.filters.every((f) => f.test(t)));
    return {
      query,
      tracks: sortTracks(hits, 'title', 1).slice(0, limit),
      albums: [], artists: [],
      filtered: parsed.filters.map((f) => f.token),
    };
  }

  const q = norm(parsed.text).trim();
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
    // Words and filters are an AND: "beatles unplayed" means both.
    if (parsed.filters.length && !parsed.filters.every((f) => f.test(t))) continue;
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
    filtered: parsed.filters.map((f) => f.token),
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
  p = db.getArt(artKeyFor(key)).then((blob) => {
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

/* ---------------------------------------------------------- chosen artwork
 *
 * A picture you dropped on an album, and the same promise as a tag edit: it is
 * an overlay, and the cover that came out of the files is still underneath it.
 *
 * Two records rather than one. The scanned cover keeps the album key it always
 * had; yours goes under `key + '#own'`. That costs a set membership test on
 * every read and buys the thing that matters — "use the original again" is a
 * delete of one record, not an apology, and a rescan that finds a better
 * embedded cover cannot silently overwrite the one you chose.
 *
 * The picture is handed to the metadata worker rather than processed here, and
 * comes back through the identical pipeline a scanned cover uses: downscaled
 * the same way, encoded the same way, sampled for the same accent colour, and
 * run through the same relief pass. So a cover you chose tints its own page
 * and lights under the pointer exactly as one found in a file does, and no
 * view has to learn the difference.
 */

/**
 * Album keys whose art the listener chose, each with the colour sampled from
 * that picture.
 *
 * The colour is here rather than derived on demand because of where the other
 * one lives: a scanned cover's accent is written onto the track records at
 * import, so it comes back with the library, and a chosen cover has no track
 * record to ride home on. Without this the album page came back untinted after
 * every reload — the picture was right and the colour beside it was not, which
 * is worse than either being wrong on its own.
 */
const ownArt = new Map();       // albumKey -> [r,g,b] | null

const ownKey = (key) => key + '#own';

export const hasOwnArt = (key) => ownArt.has(key);

/** The record `loadArt` should read for this album. */
const artKeyFor = (key) => (ownArt.has(key) ? ownKey(key) : key);

function saveOwnArt() {
  const out = {};
  for (const [k, accent] of ownArt) out[k] = accent || null;
  return db.setKV('ownArt', out).catch(() => {});
}

/** Drops every cached derivation of an album's cover, so the next read rebuilds. */
function forgetArt(key) {
  const url = artURLs.get(key);
  if (url) { URL.revokeObjectURL(url); artURLs.delete(key); }
  artMisses.delete(key);
  artPending.delete(key);
  reliefs.delete(key);
  reliefMisses.delete(key);
}

/* Sent to the worker and awaited by id, because a `cover` reply arrives on the
   same channel as scan traffic and must not be mistaken for it. */
let coverSeq = 0;
const coverWaits = new Map();

function processCover(key, blob) {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const id = ++coverSeq;
  return new Promise((resolve) => {
    coverWaits.set(id, resolve);
    // If the worker dies mid-flight nothing ever resolves, so bound the wait.
    setTimeout(() => { if (coverWaits.delete(id)) resolve(null); }, 20000);
    w.postMessage({ type: 'cover', id, key, blob });
  });
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif|bmp|tiff?)$/i;

/**
 * Gives an album a cover of your choosing.
 *
 * Returns true if it took. A file that is not an image, or one the browser
 * cannot decode, is refused rather than stored — a broken record here would
 * show up as a blank sleeve with no way to tell whether the picture or the
 * album was at fault.
 */
export async function setArtwork(key, file) {
  if (!key || !file) return false;
  if (file.type && !IMAGE_TYPES.test(file.type)) return false;

  const made = await processCover(key, file);
  if (!made || !made.blob) return false;

  // What is there now, so the undo can put it back exactly.
  const hadOwn = ownArt.has(key);
  const prevBlob = hadOwn ? await db.getArt(ownKey(key)).catch(() => null) : null;
  const prevAccent = accents.get(key) || null;
  const prevRelief = hadOwn ? reliefs.get(key) || await db.getArt(ownKey(key) + '#relief').catch(() => null) : null;

  await putOwnArt(key, made);
  const album = state.albumBy.get(key);
  undo.push({
    label: `the cover for “${album ? album.title : 'that album'}”`,
    undo: () => (hadOwn && prevBlob
      ? putOwnArt(key, { blob: prevBlob, accent: prevAccent, relief: prevRelief })
      : dropOwnArt(key)),
    redo: () => putOwnArt(key, made),
  });
  return true;
}

/** Writes the chosen cover and everything derived from it. */
async function putOwnArt(key, made) {
  ownArt.set(key, made.accent || null);
  saveOwnArt();
  await db.putArt(ownKey(key), made.blob).catch(() => {});
  if (made.relief) {
    await db.putArt(ownKey(key) + '#relief', made.relief).catch(() => {});
  } else {
    await db.deleteArt([ownKey(key) + '#relief']).catch(() => {});
  }
  forgetArt(key);
  if (made.accent) accents.set(key, made.accent); else accents.delete(key);
  if (made.relief) reliefs.set(key, made.relief); else reliefMisses.add(key);
  artURLs.set(key, URL.createObjectURL(made.blob));
  events.emit('art', [key]);
  events.emit('change');
  return 1;
}

/** Removes the chosen cover, revealing whatever the files supplied. */
async function dropOwnArt(key) {
  if (!ownArt.has(key)) return 0;
  ownArt.delete(key);
  saveOwnArt();
  await db.deleteArt([ownKey(key), ownKey(key) + '#relief']).catch(() => {});
  forgetArt(key);
  /* The scanned cover's accent went into the album record at import and is
     still there, so the colour comes back with the picture. */
  accents.delete(key);
  events.emit('art', [key]);
  events.emit('change');
  return 1;
}

/** Puts the album back to the cover its files came with. */
export async function clearArtwork(key) {
  if (!ownArt.has(key)) return false;
  const blob = await db.getArt(ownKey(key)).catch(() => null);
  const accent = accents.get(key) || null;
  const relief = reliefs.get(key) || await db.getArt(ownKey(key) + '#relief').catch(() => null);
  const album = state.albumBy.get(key);
  await dropOwnArt(key);
  undo.push({
    label: `putting back the cover for “${album ? album.title : 'that album'}”`,
    undo: () => (blob ? putOwnArt(key, { blob, accent, relief }) : 0),
    redo: () => dropOwnArt(key),
  });
  return true;
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

/* The four writers below all record an inverse. A playlist is small and
   entirely ours, so the inverses hold whole copies rather than diffs: a
   deleted playlist comes back with its id, its contents and its place in the
   sidebar, which is what "undo" has to mean for something you can see. */

/** Re-inserts a playlist where it was, id and all. */
async function restorePlaylist(p, at) {
  const copy = { ...p, tracks: (p.tracks || []).slice() };
  state.playlists.splice(Math.min(at, state.playlists.length), 0, copy);
  await db.putPlaylist(copy).catch(() => {});
  events.emit('playlists');
  return 1;
}

async function dropPlaylist(id) {
  const had = state.playlists.some((p) => p.id === id);
  state.playlists = state.playlists.filter((p) => p.id !== id);
  await db.deletePlaylist(id).catch(() => {});
  events.emit('playlists');
  return had ? 1 : 0;
}

/** Writes a set of fields onto a playlist. Returns 1 if it was still there. */
async function patchPlaylist(id, patch) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return 0;
  for (const [k, v] of Object.entries(patch)) p[k] = Array.isArray(v) ? v.slice() : v;
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  return 1;
}

export async function createPlaylist(name, trackIds = []) {
  const p = { id: 'p:' + hash32(name + Date.now()), name, tracks: trackIds.slice(), createdAt: Date.now() };
  state.playlists.push(p);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  undo.push({
    label: `the playlist “${name}”`,
    undo: () => dropPlaylist(p.id),
    redo: () => restorePlaylist(p, state.playlists.length),
  });
  return p;
}

export async function updatePlaylist(id, patch) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return null;
  // Only the keys actually being written, so undoing a rename does not also
  // revert a reorder that happened in between.
  const was = {};
  for (const k of Object.keys(patch)) was[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
  const now = {};
  for (const [k, v] of Object.entries(patch)) now[k] = Array.isArray(v) ? v.slice() : v;
  Object.assign(p, patch);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  undo.push({
    label: 'name' in patch ? `the rename to “${p.name}”` : `the change to “${p.name}”`,
    undo: () => patchPlaylist(id, was),
    redo: () => patchPlaylist(id, now),
  });
  return p;
}

export async function addToPlaylist(id, trackIds) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const have = new Set(p.tracks);
  // Only the ones that were not already in it: undoing an add of a track that
  // was in the playlist beforehand must not remove it.
  const added = [...new Set(trackIds)].filter((t) => !have.has(t));
  for (const t of added) p.tracks.push(t);
  if (!added.length) return;
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  undo.push({
    label: added.length === 1 ? `adding it to “${p.name}”` : `adding ${added.length} tracks to “${p.name}”`,
    undo: async () => {
      const cur = state.playlists.find((x) => x.id === id);
      if (!cur) return 0;
      const drop = new Set(added);
      return patchPlaylist(id, { tracks: cur.tracks.filter((t) => !drop.has(t)) });
    },
    redo: async () => {
      const cur = state.playlists.find((x) => x.id === id);
      if (!cur) return 0;
      const back = new Set(cur.tracks);
      return patchPlaylist(id, { tracks: cur.tracks.concat(added.filter((t) => !back.has(t))) });
    },
  });
}

export async function removePlaylist(id) {
  const at = state.playlists.findIndex((p) => p.id === id);
  const gone = at >= 0 ? { ...state.playlists[at], tracks: (state.playlists[at].tracks || []).slice() } : null;
  state.playlists = state.playlists.filter((p) => p.id !== id);
  await db.deletePlaylist(id).catch(() => {});
  events.emit('playlists');
  if (gone) {
    undo.push({
      label: `deleting “${gone.name}”`,
      undo: () => restorePlaylist(gone, at),
      redo: () => dropPlaylist(id),
    });
  }
}

/**
 * The tracks in a playlist.
 *
 * A hand-made playlist is a list of ids. A smart one is a description, and its
 * contents are worked out fresh every time they are asked for — so favouriting
 * a track puts it in a "favourites added this year" list immediately, and
 * playing one takes it out of "never played" the moment the count changes.
 * Nothing is materialised, so nothing can go stale.
 *
 * The evaluator is imported lazily, and deliberately: rules.js reads the
 * listening stats, stats.js reads the library, and a static import here would
 * close that ring at module-load time.
 */
export const playlistTracks = (p) => {
  if (!p) return [];
  if (p.smart) return smartEval ? smartEval(p, allTracks()) : [];
  return p.tracks.map((id) => state.tracks.get(id)).filter(Boolean);
};

/** Set by rules.js on load; see the note above for why it is not imported. */
let smartEval = null;
export const useRuleEngine = (fn) => { smartEval = fn; };

/** Creates a playlist that describes itself rather than listing itself. */
export async function createSmartPlaylist(name, set = {}) {
  const p = {
    id: 'p:' + hash32(name + Date.now()),
    name,
    smart: true,
    match: set.match || 'all',
    rules: set.rules || [],
    sort: set.sort || 'none',
    sortDir: set.sortDir || 1,
    limit: set.limit || 0,
    tracks: [],
    createdAt: Date.now(),
  };
  state.playlists.push(p);
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  undo.push({
    label: `the smart shelf “${name}”`,
    undo: () => dropPlaylist(p.id),
    redo: () => restorePlaylist(p, state.playlists.length),
  });
  return p;
}

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
  /* The inverse of a toggle is the toggle back, but pinned to a value rather
     than flipped: undoing after the same track was favourited again by hand
     should land on "not favourited", not on whatever the flip happens to give. */
  const name = (state.tracks.get(id) || {}).title;
  undo.push({
    label: on ? `favouriting${name ? ` “${name}”` : ''}` : `unfavouriting${name ? ` “${name}”` : ''}`,
    undo: () => { toggleFavourite(id, !on); return 1; },
    redo: () => { toggleFavourite(id, on); return 1; },
  });
  return on;
}

/** Only the ones the library can actually reach, newest mark first. */
export const favouriteTracks = () =>
  favourites.ids.map((id) => state.tracks.get(id)).filter(Boolean);

/* ------------------------------------------------------------------ boot */

/** Paints the stored library first, then reconnects to disk in the background. */
export async function init() {
  const [tracks, roots, playlists, recent, faves, sn, own] = await Promise.all([
    db.getAllTracks().catch(() => []),
    db.getRoots().catch(() => []),
    db.getPlaylists().catch(() => []),
    db.getKV('recent').catch(() => null),
    db.getKV('favourites').catch(() => null),
    db.getKV('serial').catch(() => null),
    db.getKV('ownArt').catch(() => null),
  ]);

  serial = typeof sn === 'string' && sn ? sn : makeSerial();
  if (serial !== sn) db.setKV('serial', serial).catch(() => {});

  for (const t of tracks) { decorate(t); state.tracks.set(t.id, t); }
  state.roots = roots;
  state.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
  history.recent = Array.isArray(recent) ? recent : [];
  favourites.ids = Array.isArray(faves) ? faves.filter((id) => typeof id === 'string') : [];
  favourites.set = new Set(favourites.ids);
  /* Chosen covers, and the colour each one was sampled for. Accepts a bare
     array of keys as well as the map, because the first shape this was written
     in had nowhere to put the colour. */
  if (Array.isArray(own)) for (const k of own) ownArt.set(k, null);
  else if (own && typeof own === 'object') {
    for (const [k, accent] of Object.entries(own)) {
      ownArt.set(k, accent || null);
      if (accent) accents.set(k, accent);
    }
  }
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
