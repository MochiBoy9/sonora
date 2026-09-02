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
import * as cue from './cue.js';
import { Emitter, LRU, AUDIO_EXT, hash32, albumKeyOf, norm, isAudio, isAudioFile, isLyric, sortName, cmpText, idle, ext, canDecode, isPlaylistFile, isCueFile } from './util.js';

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
    if (msg.type === 'failed') {
      noteScanFailure(msg.name, msg.reason);
      return;
    }
    if (msg.type === 'progress') {
      state.progress = { done: msg.done, total: msg.total, file: msg.file || '' };
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
/* ------------------------------------------------------------------ moves */

/**
 * B7: a track that moved, rather than one that vanished and one that arrived.
 *
 * A track's id is its root plus its path, so renaming a folder deletes every
 * row under it and creates an identical set with different names — and every
 * correction, favourite, play count, rating and measurement attached to the
 * old ids goes with them. The file is the same file. Sonora had no way to know
 * that, and quietly threw away a year of somebody's work for the crime of
 * tidying up a directory.
 *
 * A move is recognised by the file itself: same byte length, same modification
 * time, same duration, and — where the tagger wrote one — the same MusicBrainz
 * recording id, which is B6 earning its keep. All four have to agree, because
 * the cost of a false positive is a track wearing somebody else's history.
 * Duration is checked in `absorb`, not here, because the new file has not been
 * parsed yet when the match is proposed.
 *
 * The candidates are keyed by size and mtime and hold at most one track each:
 * two files that are byte-identical and stamped identically are a duplicate,
 * not a move, and guessing which of them moved where would be a coin toss.
 */
const moveCandidates = new Map();     // 'size:mtime' -> saved history, or null
const pendingMoves = new Map();       // new track id -> saved history
let movedCount = 0;                   // carried across in this scan, for the report

/** Everything about a track that belongs to the listener rather than the file. */
const HISTORY_KEYS = ['playCount', 'lastPlayed', 'rating', 'dr', 'bpm', 'bpmConfidence',
                      'centroid', 'truncated', 'analysedAt', 'accent'];

function saveHistory(t) {
  const out = { id: t.id, mb: t.mbTrack || '', duration: t.duration || 0 };
  if (t.edits) out.edits = { ...t.edits };
  if (t.orig) out.orig = { ...t.orig };
  for (const k of HISTORY_KEYS) if (t[k] !== undefined) out[k] = t[k];
  out.favourite = isFavourite(t.id);
  return out;
}

/** True where the saved history is worth carrying at all. */
const worthCarrying = (h) =>
  !!(h && (h.edits || h.favourite || h.playCount > 0 || h.rating > 0 || h.dr > 0 || h.bpm > 0));

function absorb(batch) {
  const rows = [];
  for (const { track, art } of batch) {
    /* Nothing from the file itself.
     *
     * Not "no artist and no album": the reader falls back to the folder tree,
     * so `Broken/Album/03 Bogus.mp3` arrives with an artist and an album that
     * were never in the file. `guessed` is the list of fields it had to take
     * from the path, and a track where that covers both is a track the reader
     * learned nothing from — which is exactly the file somebody is looking for
     * when their library has come out wrong.
     *
     * Counted while the batch is in hand rather than by walking the library
     * afterwards, and only during a scan, so a rescan that touches nothing
     * reports nothing. */
    if (state.scanning) {
      const g = String(track.guessed || '').split(' ');
      if (g.includes('artist') && g.includes('album')) {
        noteScanFailure(track.name || track.path || track.id, 'nothing in the file — read from the folder name');
      }
    }
    /* Corrections the listener made survive a rescan.
     *
     * The parser hands back what the file says, and what the file says has not
     * changed — Sonora does not write tags. So the edits are kept beside the
     * parsed values rather than replacing them, and re-applied on top here.
     * Clearing an edit therefore reveals the file's own tag again instead of
     * leaving a blank, which is the behaviour that makes the feature safe to
     * use on a library you care about. */
    /* A file that moved rather than appeared. The proposal was made from the
       size and the timestamp; the duration and the recording id are checked
       here, now that the file has actually been read. */
    const moved = pendingMoves.get(track.id);
    if (moved) {
      pendingMoves.delete(track.id);
      const sameLength = Math.abs((moved.duration || 0) - (track.duration || 0)) < 0.75;
      const sameWork = !moved.mb || !track.mbTrack || moved.mb === track.mbTrack;
      if (sameLength && sameWork) {
        if (moved.edits) track.edits = moved.edits;
        for (const k of HISTORY_KEYS) if (moved[k] !== undefined) track[k] = moved[k];
        if (moved.favourite) toggleFavourite(track.id, true);
        movedCount++;
      }
    }

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

    /* L15: a file with a cue sheet beside it is a side, not a song.
     *
     * Expanded here rather than in the worker, because the last index runs to
     * the file's own duration and the parser has only just worked that out.
     * The file itself stays in the index as the thing that actually gets
     * decoded; it is hidden from the library, because a side listed beside its
     * own eleven tracks is the same record twice. */
    const sheetKey = track.id.replace(/\.[^./]+$/, '');
    if (cueSheets.has(sheetKey) && !track.fromCue) {
      pendingCues.push({ track, handle: cueSheets.get(sheetKey) });
    }
  }
  db.putTracks(rows).catch(() => {});
  if (pendingCues.length) flushCues();
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
/**
 * Writes whole tracks back to the index, for the backup importer.
 *
 * `restoreTracks` below is the undo path and only touches the editable fields,
 * because that is all an undo of a correction may touch. A backup carries play
 * counts and ratings as well, and the rows it hands over have already been
 * merged field by field — so this writes what it is given and reindexes.
 */
export async function restoreFromBackup(rows) {
  const out = [];
  for (const row of rows) {
    const t = state.tracks.get(row.id);
    if (!t) continue;
    Object.assign(t, row);
    /* Assigned *and* cleared. `Object.assign` writes what the row has and
       leaves everything it does not, so restoring a snapshot taken before a
       correction left the correction's `edits` in place — and `applyEdits`
       below then put the corrected title straight back. A restore that cannot
       remove a field is not a restore. */
    if (!row.edits) delete t.edits;
    if (!row.orig) delete t.orig;
    applyEdits(t);
    t.albumKey = albumKeyOf(t.albumArtist || t.artist || '', t.album);
    decorate(t);
    out.push(t);
  }
  if (out.length) {
    await db.putTracks(out).catch(() => {});
    reindex();
    events.emit('change');
  }
  return out.length;
}

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

/* Bumped by every reindex. Anything derived from the index — the genre map
   below is the first — can cache against it rather than rebuilding on every
   read or listening for an event it would then have to unsubscribe from. */
let indexSerial = 0;

export function reindex() {
  indexSerial++;
  const albumBy = new Map();

  /* I4: a folder switched off is not in the library today. Filtered rather
     than deleted, which is the whole point — the tracks stay in the index with
     every correction, favourite and play count attached, and turning the
     folder back on is this function running again rather than twenty minutes
     of rescanning. */
  for (const t of live()) {
    let al = albumBy.get(t.albumKey);
    if (!al) {
      albumBy.set(t.albumKey, al = {
        key: t.albumKey, title: t.album, artist: t.albumArtist,
        artistKey: t.artistKey, year: t.year || 0, tracks: [],
        duration: 0, addedAt: 0, sort: norm(t.album), accent: null,
        named: false,
        // Rolled up from the tracks below, so a wall of records can be ordered
        // by listening without walking every track again per sort.
        plays: 0, lastPlayed: 0,
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
    /* B4: when the record came out, which is not when this copy was made. The
       earliest wins for the same reason the year does — a set where one file
       carries the original date and the rest don't is still that record. */
    if (t.originalYear && (!al.originalYear || t.originalYear < al.originalYear)) {
      al.originalYear = t.originalYear;
    }
    if (t.addedAt > al.addedAt) al.addedAt = t.addedAt;
    al.plays += t.playCount || 0;
    if ((t.lastPlayed || 0) > al.lastPlayed) al.lastPlayed = t.lastPlayed;
  }

  // Albums fold together before artists are counted, because folding one in
  // can hand its tracks a different artist — and an artist index built first
  // would keep a page for a folder name that no longer names anything.
  mergeAlbums(albumBy);
  markCompilations(albumBy);

  const artistBy = new Map();
  for (const t of live()) {
    /* L8: a compilation is filed under itself.
     *
     * `artistKey` comes from the album artist, which falls back to the track
     * artist — so a compilation with no ALBUMARTIST frame gives every one of
     * its twenty tracks a different album artist, and the Artists page grows
     * twenty entries with one track each. The album knows better than the
     * track does here, so the album decides. The track's own artist is
     * untouched: it still prints on every row, sorts, and is searchable. */
    const own = albumBy.get(t.albumKey);
    const key = own && own.compilation ? own.artistKey : t.artistKey;
    const name = own && own.compilation ? own.artist : t.albumArtist;

    let ar = artistBy.get(key);
    if (!ar) {
      artistBy.set(key, ar = {
        key, name, tracks: [],
        albums: new Set(), duration: 0, sort: norm(sortName(name)),
        compilation: !!(own && own.compilation),
        // Rolled up here rather than recomputed per sort: every list that wants
        // to order by listening asks the same question of the same objects, and
        // the reindex is already walking every track.
        plays: 0, lastPlayed: 0,
      });
    }
    ar.tracks.push(t);
    ar.albums.add(t.albumKey);
    ar.duration += t.duration || 0;
    ar.plays += t.playCount || 0;
    if ((t.lastPlayed || 0) > ar.lastPlayed) ar.lastPlayed = t.lastPlayed;
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

/* Files waiting for their cue sheet to be read. Reading one is asynchronous
   and `absorb` is not, so they queue and are drained after the batch. */
const pendingCues = [];
let drainingCues = false;

async function flushCues() {
  if (drainingCues) return;
  drainingCues = true;
  try {
    const rows = [];
    while (pendingCues.length) {
      const { track, handle } = pendingCues.shift();
      let text = null;
      try {
        const file = handle.getFile ? await handle.getFile() : handle;
        text = await file.text();
      } catch { /* the sheet went away */ }
      if (!text) continue;
      const sheet = cue.parse(text);
      /* A sheet that names several files is a folder of tracks described in
         one place, which this library already reads as a folder of tracks.
         Expanding it would double every one of them. */
      if (!sheet || sheet.multiFile) continue;

      for (const piece of cue.expand(sheet, track)) {
        const prior = state.tracks.get(piece.id);
        // Corrections survive, exactly as they do for a parsed file.
        if (prior && prior.edits) {
          piece.edits = prior.edits;
          const orig = {};
          for (const k of Object.keys(piece.edits)) orig[k] = piece[k];
          piece.orig = orig;
          applyEdits(piece);
        }
        if (prior) {
          piece.playCount = prior.playCount || 0;
          piece.lastPlayed = prior.lastPlayed || 0;
        }
        decorate(piece);
        state.tracks.set(piece.id, piece);
        rows.push(piece);
      }

      /* The side itself is kept — it is the file that gets decoded, and
         `fileFor` resolves a cue track through it — and marked so the library
         does not list it beside its own pieces. */
      track.cueSource = true;
      rows.push(track);
    }
    if (rows.length) {
      await db.putTracks(rows).catch(() => {});
      reindex();
      events.emit('change');
    }
  } finally {
    drainingCues = false;
    if (pendingCues.length) flushCues();
  }
}

/* L15: the cue sheets seen during a scan, by the path they share with their
   audio file. Kept, not cleared per scan: a sheet found on Monday still
   indexes the same file on Tuesday, and a rescan that only re-reads changed
   files would otherwise lose it. */
const cueSheets = new Map();

/* L14: the .m3u files this scan walked past. Cleared at the start of a scan
   like `mergedThisScan` is, for the same reason: they are this import's news. */
let foundPlaylists = [];
export const playlistFilesFound = () => foundPlaylists.slice();

/** Reads one of them. Returns its text, or null if the file has gone. */
export async function readPlaylistFile(entry) {
  try {
    const file = entry.handle.getFile ? await entry.handle.getFile() : entry.handle;
    return await file.text();
  } catch { return null; }
}

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
/* L8: which records are compilations.
 *
 * The merge logic next door is careful and right: a guessed artist counts as
 * no artist, and two records that both name themselves never merge. But a
 * Various Artists compilation is the one case where the album artist and the
 * track artists are *supposed* to disagree, and nothing in the model said so —
 * so a twenty-track compilation with no ALBUMARTIST frame read as twenty
 * artists with one track each, which is the Artists page shattered by one
 * record.
 *
 * Two ways in, because tagging practice is not consistent:
 *
 *   — the album says so. "Various Artists", "VA", "Various" in the album
 *     artist is a claim, and it is believed.
 *   — the tracks say so. Several different artists, no consistent album artist
 *     to hold them together, and enough of them that this is the shape of the
 *     record rather than one guest verse on it.
 *
 * The second test is deliberately not "more than one artist". A record with a
 * feature on two of twelve tracks has three artists and is not a compilation,
 * and calling it one would file Kanye West under Various. Requiring the
 * distinct artists to cover at least two fifths of the tracks is what separates
 * "a record by somebody, with guests" from "a record by nobody in particular".
 */
const VARIOUS = new Set(['various artists', 'various', 'va', 'v.a.', 'diverse interpreten', 'compilation']);

/** The directory a track sits in, which is the strongest signal on disk. */
const folderOf = (t) => (t.rootId || '') + '/' + String(t.path || '').replace(/[^/]*$/, '');

function markCompilations(albumBy) {
  /* First, put the record back together.
   *
   * The album key is a hash of (album artist + album title), and on a
   * compilation with no ALBUMARTIST frame every track's album artist is its
   * own — so the record does not merely read as twenty artists, it reads as
   * twenty *albums*, each holding one track. `mergeAlbums` above deliberately
   * refuses to fold those: both sides named themselves and the names differ,
   * which is exactly the rule that keeps two different "Greatest Hits" apart.
   *
   * The evidence it does not use is the folder. Files sitting in one directory
   * under one album title are one album, whatever their artist tags say — that
   * is what a compilation looks like on disk, and it is not what two different
   * records that share a title look like. So the fold is by title *and*
   * directory, which is narrow enough to be safe. */
  const byPlace = new Map();
  for (const al of albumBy.values()) {
    if (!al.sort || al.sort === norm('Unknown Album')) continue;
    // One directory, or this is not the case being caught.
    const dirs = new Set(al.tracks.map(folderOf));
    if (dirs.size !== 1) continue;
    const place = [...dirs][0] + '\u0000' + al.sort;
    let list = byPlace.get(place);
    if (!list) byPlace.set(place, list = []);
    list.push(al);
  }

  for (const list of byPlace.values()) {
    if (list.length < 3) continue;               // not a shape, just a stray
    const keep = list[0];
    for (const other of list.slice(1)) {
      for (const t of other.tracks) { t.albumKey = keep.key; keep.tracks.push(t); }
      keep.duration += other.duration;
      keep.addedAt = Math.max(keep.addedAt, other.addedAt);
      keep.year = keep.year || other.year;
      keep.accent = keep.accent || other.accent;
      albumBy.delete(other.key);
    }
    mergedThisScan.set(keep.key, keep.title);
  }

  for (const al of albumBy.values()) {
    if (al.tracks.length < 3) continue;          // too small to be a shape

    const artists = new Set();
    let claimed = 0;                             // tracks with a real ALBUMARTIST
    for (const t of al.tracks) {
      artists.add(norm(t.artist));
      // `albumArtist` is filled from `artist` when the file carried none, so a
      // real claim is one that differs from the track's own artist.
      if (t.albumArtist && norm(t.albumArtist) !== norm(t.artist)) claimed++;
    }

    const said = VARIOUS.has(norm(al.artist));
    const shape = artists.size >= 3 &&
                  artists.size >= al.tracks.length * 0.4 &&
                  claimed === 0;

    if (!said && !shape) continue;

    al.compilation = true;
    /* Named, so the Artists page has something to call it. A record that
       already says "Various Artists" keeps its own spelling; one detected by
       shape is given the name the rest of the world uses for it. */
    if (!said) al.artist = 'Various Artists';
    al.artistKey = hash32(norm(al.artist));
    al.named = true;
  }
}

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

/* ------------------------------------------------------------------ L18
 *
 * Backfilling the guessed marks.
 *
 * `guessed` — which fields the tag reader had to take from the folder tree
 * rather than from the file — has only been recorded since 2.6. A library
 * imported before that has none, so `namedArtist` defaults to true for every
 * track in it, and the album merge treats a folder name pressed into service
 * as a real claim. The result is silently worse merging on exactly the
 * libraries that have been around longest.
 *
 * The fix is to re-read the tags of the files that have no mark, which is a
 * scan — so it borrows the scan's own discipline: it does only what has not
 * been done, it can be stopped, and it survives being interrupted, because
 * each batch is written before the next is asked for.
 */
export function needsBackfill() {
  let n = 0;
  for (const t of state.tracks.values()) {
    // `guessed` is a string that is empty when nothing was guessed and absent
    // when nobody ever asked — and those are different facts. `backfilled`
    // marks the ones this pass has already answered for.
    if (t.guessed === undefined && !t.backfilled) n++;
  }
  return n;
}

let backfilling = false;

export async function backfillGuessed(onProgress) {
  if (backfilling) return { ok: false, reason: 'already running' };
  backfilling = true;
  let done = 0;
  let total = 0;
  try {
    const todo = [];
    for (const t of state.tracks.values()) {
      if (t.guessed === undefined && !t.backfilled) todo.push(t);
    }
    total = todo.length;
    if (!total) return { ok: true, done: 0, total: 0 };

    const w = ensureWorker();
    for (let i = 0; i < todo.length; i += 60) {
      const batch = todo.slice(i, i + 60);
      const jobs = [];
      for (const t of batch) {
        const file = await fileFor(t.id);
        // A file that cannot be reached is not a failure to record — the
        // folder is simply not connected, and the next run will find it.
        if (!file) continue;
        jobs.push({ id: t.id, path: t.path, name: t.name, size: t.size,
                    mtime: t.mtime, rootId: t.rootId, file });
      }
      if (jobs.length && w) {
        /* Through the same parser the import uses, so the answer is the same
           answer — a second implementation of "which of these came from the
           folder" would drift from the first within a release. */
        w.postMessage({ type: 'scan', jobs });
      } else if (jobs.length) {
        await parseOnMainThread(jobs);
      }
      for (const t of batch) t.backfilled = true;
      await db.putTracks(batch).catch(() => {});
      done += batch.length;
      if (onProgress) onProgress(done, total);
      // A breath between batches, so a library of twenty thousand does not
      // hold the main thread for a minute.
      await new Promise((r) => setTimeout(r, 0));
    }
    reindex();
    events.emit('change');
    return { ok: true, done, total };
  } finally {
    backfilling = false;
  }
}

/* ------------------------------------------------------------------ L12
 *
 * Playlist folders, and an order you chose.
 *
 * Playlists were a flat list in creation order. Past about fifteen that is a
 * pile rather than a structure, and there was no way to move one — a list you
 * cannot arrange is a list that gets worse every time you add to it.
 *
 * Folders one level deep, deliberately: two levels is a file manager, and
 * nobody has ever wanted a file manager for forty playlists. A folder is a
 * name and an order, stored beside the playlists themselves.
 */
let folders = [];
export const playlistFolders = () => folders.slice();

const saveFolders = () => db.setKV('playlistFolders', folders).catch(() => {});

export async function createFolder(name) {
  const folder = { id: 'pf:' + hash32(name + ':' + Date.now()), name: String(name).slice(0, 60) };
  folders.push(folder);
  await saveFolders();
  events.emit('playlists');
  undo.push({
    label: `the folder “${folder.name}”`,
    undo: async () => { folders = folders.filter((f) => f.id !== folder.id); await saveFolders(); events.emit('playlists'); return 1; },
    redo: async () => { folders.push(folder); await saveFolders(); events.emit('playlists'); return 1; },
  });
  return folder;
}

export async function renameFolder(id, name) {
  const f = folders.find((x) => x.id === id);
  if (!f) return false;
  const was = f.name;
  f.name = String(name).slice(0, 60);
  await saveFolders();
  events.emit('playlists');
  undo.push({
    label: `renaming “${was}”`,
    undo: async () => { f.name = was; await saveFolders(); events.emit('playlists'); return 1; },
    redo: async () => { f.name = name; await saveFolders(); events.emit('playlists'); return 1; },
  });
  return true;
}

/**
 * Removes a folder. Its playlists come out of it rather than going with it —
 * deleting a container should never delete the contents, and a folder here is
 * a label rather than a place.
 */
export async function removeFolder(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return false;
  const inside = state.playlists.filter((p) => p.folder === id);
  folders = folders.filter((x) => x.id !== id);
  for (const p of inside) { delete p.folder; await db.putPlaylist(p).catch(() => {}); }
  await saveFolders();
  events.emit('playlists');
  undo.push({
    label: `the folder “${f.name}”`,
    undo: async () => {
      folders.push(f);
      for (const p of inside) { p.folder = id; await db.putPlaylist(p).catch(() => {}); }
      await saveFolders();
      events.emit('playlists');
      return 1;
    },
    redo: () => removeFolder(id),
  });
  return true;
}

/** Puts a playlist in a folder, or takes it out with `null`. */
export async function movePlaylist(id, folderId) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return false;
  const was = p.folder || null;
  if (folderId) p.folder = folderId; else delete p.folder;
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  undo.push({
    label: `moving “${p.name}”`,
    undo: () => movePlaylistQuiet(id, was),
    redo: () => movePlaylistQuiet(id, folderId),
  });
  return true;
}

async function movePlaylistQuiet(id, folderId) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return 0;
  if (folderId) p.folder = folderId; else delete p.folder;
  await db.putPlaylist(p).catch(() => {});
  events.emit('playlists');
  return 1;
}

/**
 * Reorders the sidebar.
 *
 * `order` is a number on each playlist rather than a separate list of ids: a
 * list would have to be kept in step with every create and delete, and a
 * playlist that is not in it would have nowhere to sort. Sparse, so moving one
 * writes one row rather than renumbering forty.
 */
export async function reorderPlaylists(ids) {
  let n = 0;
  const changed = [];
  for (const id of ids) {
    const p = state.playlists.find((x) => x.id === id);
    if (!p) continue;
    const next = (n += 10);
    if (p.order === next) continue;
    p.order = next;
    changed.push(p);
  }
  for (const p of changed) await db.putPlaylist(p).catch(() => {});
  sortPlaylists();
  events.emit('playlists');
  return changed.length;
}

/** Creation order until somebody says otherwise, then whatever they said. */
function sortPlaylists() {
  state.playlists.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : Infinity;
    const bo = typeof b.order === 'number' ? b.order : Infinity;
    return ao - bo || a.createdAt - b.createdAt;
  });
}

/* ------------------------------------------------------------------ L11
 *
 * Find and replace, across a field.
 *
 * Every real library has one systematic mistake in it — "feat." against "ft.",
 * an artist misspelled the same way across three albums, a label that put the
 * year in the title — and correcting one track at a time cannot reach that.
 *
 * Preview then commit, always: this returns what *would* change and changes
 * nothing, and `editTracks` does the writing, so the whole run is one undo
 * entry and the files are never touched. Text, not a regular expression: a
 * find-and-replace that can be given `.*` is a find-and-replace that can empty
 * a library by accident, and nobody typing "feat." wants a character class.
 */
export function findReplace(field, find, replace, { caseSensitive = false, whole = false } = {}) {
  const out = [];
  if (!EDITABLE.includes(field) || !find) return out;

  const needle = caseSensitive ? find : find.toLowerCase();
  for (const t of live()) {
    const value = String(t[field] ?? '');
    if (!value) continue;
    const hay = caseSensitive ? value : value.toLowerCase();

    let next;
    if (whole) {
      // The whole field, or nothing: "Various" should not rewrite "Various
      // Artists" when what was meant was the field that says exactly Various.
      if (hay !== needle) continue;
      next = replace;
    } else {
      if (!hay.includes(needle)) continue;
      /* Split and join rather than a regular expression, so every character in
         the search text means itself. `String.replaceAll` would need the same
         escaping and reads no better. */
      if (caseSensitive) {
        next = value.split(find).join(replace);
      } else {
        // Case-insensitive, but the surrounding text keeps its own case: only
        // the matched runs are replaced, found by walking the lowered copy.
        let at = 0, built = '';
        for (;;) {
          const i = hay.indexOf(needle, at);
          if (i < 0) { built += value.slice(at); break; }
          built += value.slice(at, i) + replace;
          at = i + needle.length;
        }
        next = built;
      }
    }
    if (next === value) continue;
    out.push({ track: t, from: value, to: next });
  }
  return out;
}

/** Applies what `findReplace` previewed. One undo entry for the whole run. */
export async function applyReplace(field, changes) {
  if (!changes.length) return 0;
  let n = 0;
  await undo.silence(async () => {
    /* Grouped by the value being written, so a hundred tracks going to the
       same artist are one call rather than a hundred — `editTracks` writes,
       reindexes and emits once per call. */
    const byValue = new Map();
    for (const c of changes) {
      let list = byValue.get(c.to);
      if (!list) byValue.set(c.to, list = []);
      list.push(c.track);
    }
    for (const [value, tracks] of byValue) n += await editTracks(tracks, { [field]: value });
  });
  if (n) {
    const before = changes.map((c) => ({ id: c.track.id, value: c.from }));
    undo.push({
      label: `replacing “${changes[0].from}” in ${fieldLabel(field)}`,
      undo: async () => {
        await undo.silence(async () => {
          const byValue = new Map();
          for (const b of before) {
            let list = byValue.get(b.value);
            if (!list) byValue.set(b.value, list = []);
            const t = state.tracks.get(b.id);
            if (t) list.push(t);
          }
          for (const [value, tracks] of byValue) await editTracks(tracks, { [field]: value });
        });
        return before.length;
      },
      redo: async () => {
        await undo.silence(async () => {
          const byValue = new Map();
          for (const c of changes) {
            let list = byValue.get(c.to);
            if (!list) byValue.set(c.to, list = []);
            list.push(c.track);
          }
          for (const [value, tracks] of byValue) await editTracks(tracks, { [field]: value });
        });
        return changes.length;
      },
    });
  }
  return n;
}

const FIELD_LABELS = { title: 'the title', artist: 'the artist', albumArtist: 'the album artist',
                       album: 'the album', genre: 'the genre' };
const fieldLabel = (f) => FIELD_LABELS[f] || f;

/** Which fields find-and-replace can work on. */
export const replaceableFields = () =>
  EDITABLE.filter((f) => FIELD_LABELS[f]).map((f) => [f, FIELD_LABELS[f]]);

/* ------------------------------------------------------------------ L9
 *
 * Everything that needs a human, in one place.
 *
 * The application already knows which files are untagged, which fields it had
 * to guess, which have no cover, which this browser cannot decode, which look
 * like transcodes and which are duplicates — and every one of those findings
 * lived somewhere different: a badge on a row, a tab on Files, a marker you
 * only see if you happen to open that album. Nobody has ever found all of them
 * on purpose.
 *
 * Each finding is a count, a list and one thing to do about it. The counts are
 * computed together in one walk, because six separate passes over a
 * twenty-thousand-track library to draw one page is six passes too many.
 */
export function attention() {
  const guessed = [];
  const untagged = [];
  const undecodable = [];
  const suspect = [];
  const byName = new Map();          // artist + title -> tracks, for duplicates

  for (const t of live()) {
    const g = String(t.guessed || '').split(' ').filter(Boolean);
    if (g.includes('artist') && g.includes('album')) untagged.push(t);
    else if (g.length) guessed.push(t);
    if (!canDecode(t.name || t.path || '')) undecodable.push(t);
    if (t.truncated === true) suspect.push(t);

    /* Duplicates by what they claim to be, not by content: two files of the
       same song at different bitrates are the case people actually have, and
       they are not byte-identical. Duration is in the key at whole seconds so
       that a live version and a studio one do not read as the same track. */
    const key = norm(t.artist) + '\u0000' + norm(t.title) + '\u0000' + Math.round(t.duration || 0);
    let list = byName.get(key);
    if (!list) byName.set(key, list = []);
    list.push(t);
  }

  const duplicates = [];
  for (const list of byName.values()) if (list.length > 1) duplicates.push(list);

  /* Albums with no cover. Asked of the album rather than the track, because a
     record with no artwork is one thing to fix and not eleven. */
  const noArt = state.albums.filter((al) => !ownArt.has(al.key) && !accents.has(al.key));

  return { guessed, untagged, undecodable, suspect, duplicates, noArt };
}

/* ------------------------------------------------------------------ L4
 *
 * Genre, as somewhere you can go.
 *
 * Every container the tag reader handles gives up a genre, and the Circle
 * Analysis Center will draw your listening by it — but there was no genre
 * route, no genre on an album page, and no way to say "everything ambient"
 * except by typing it into search and hoping.
 *
 * Genre in the wild is free text and frequently a list: "Rock; Alternative",
 * "Electronic/Ambient", "Jazz, Vocal". Split on the three separators everybody
 * uses, fold case for grouping, and keep the best-looking spelling for
 * display — the first one seen with a capital letter, because "Post-Rock" is
 * what somebody typed and "post-rock" is what the sort key is.
 */
const genreCache = { serial: -1, list: null, by: null };

const splitGenres = (v) =>
  String(v || '')
    .split(/[;/,]|\s+\+\s+/)
    .map((g) => g.trim())
    .filter((g) => g && g.length < 40);

function buildGenres() {
  if (genreCache.serial === indexSerial) return genreCache;
  const by = new Map();
  for (const t of live()) {
    for (const raw of splitGenres(t.genre)) {
      const key = norm(raw);
      if (!key) continue;
      let g = by.get(key);
      if (!g) by.set(key, g = { key, label: raw, tracks: [], albums: new Set(), duration: 0 });
      // The nicest spelling wins: one with a capital beats one without.
      if (/[A-Z]/.test(raw) && !/[A-Z]/.test(g.label)) g.label = raw;
      g.tracks.push(t);
      g.albums.add(t.albumKey);
      g.duration += t.duration || 0;
    }
  }
  const list = [...by.values()].sort((a, b) => b.tracks.length - a.tracks.length || cmpText(a.label, b.label));
  genreCache.serial = indexSerial;
  genreCache.by = by;
  genreCache.list = list;
  return genreCache;
}

/** Every genre in the library, heaviest first. */
export const genres = () => buildGenres().list;

/** One genre by its normalised key, or null. */
export const genreOf = (key) => buildGenres().by.get(norm(key)) || null;

/* ------------------------------------------------------------------ queries */

/* I4: what is in the library *today*.
 *
 * `state.tracks` is the index, which holds everything ever scanned including
 * the tracks of a folder that has been switched off — that is the whole point
 * of switching one off rather than removing it, since the corrections and
 * favourites hang on those rows. Everything that answers "what is in the
 * library" goes through here; `getTrack` deliberately does not, because a
 * queued or favourited track from a folder that is off is still a track that
 * exists and asking for it by id should find it. */
function* live() {
  const off = offRoots();
  for (const t of state.tracks.values()) {
    if (off.size && off.has(t.rootId)) continue;
    // L15: a file that a cue sheet has split into pieces is not itself a
    // track. It stays in the index because it is what gets decoded.
    if (t.cueSource) continue;
    yield t;
  }
}
const offRoots = () => {
  const out = new Set();
  for (const r of state.roots) if (r.off) out.add(r.id);
  return out;
};

export const allTracks = () => [...live()];
export const getTrack = (id) => state.tracks.get(id);
export const isAvailable = (id) => {
  const t = state.tracks.get(id);
  return handles.has(t && t.sourceId ? t.sourceId : id);
};
export const trackCount = () => {
  const off = offRoots();
  if (!off.size) return state.tracks.size;
  let n = 0;
  for (const _ of live()) n++;
  return n;
};

export function sortTracks(list, key, dir = 1) {
  const by = {
    title:  (a, b) => cmpText(a.title, b.title),
    artist: (a, b) => cmpText(a.artist, b.artist) || cmpText(a.album, b.album) || (a.track - b.track),
    album:  (a, b) => cmpText(a.album, b.album) || (a.disc - b.disc) || (a.track - b.track),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    added:  (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    year:   (a, b) => (a.year || 0) - (b.year || 0),
    /* B4: sorted by when the music is from, not when this copy was pressed —
       a 2015 remaster of a 1971 record belongs with 1971, which is the whole
       reason the original date is worth reading. */
    released: (a, b) => (a.originalYear || a.year || 0) - (b.originalYear || b.year || 0),
    rating: (a, b) => (a.rating || 0) - (b.rating || 0),
    // Unmeasured tracks sort as zero, which puts them at the quiet end
    // ascending and out of the way descending — either is better than
    // pretending they are the most squashed masters in the library.
    dr:     (a, b) => (a.dr || 0) - (b.dr || 0),
    /* Both of these were counted from the first release and shown nowhere. A
       never-played track and a never-played *anything* sort as zero, which puts
       the untouched part of a collection together at one end — which is the
       question people are usually asking when they sort by either. */
    plays:  (a, b) => (a.playCount || 0) - (b.playCount || 0),
    played: (a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0),
  }[key] || ((a, b) => cmpText(a.title, b.title));
  return list.slice().sort((a, b) => by(a, b) * dir);
}

/*
 * Ordering a wall of records, and a page of artists.
 *
 * Songs has had sortable columns since the first release; Albums had four
 * *view modes* and not one sort, and Artists had neither — so the wall was
 * always in whatever order the index happened to hold it and there was no way
 * to ask for 1978, or for the longest record, or for the one nobody has played.
 *
 * The comparators are written so that a missing value sorts as zero rather than
 * dropping the row: an album with no year is a real album, and hiding it because
 * a tag is absent would be the library lying about what is in it.
 */
export function sortAlbums(list, key, dir = 1) {
  const by = {
    artist: (a, b) => cmpText(a.artist, b.artist) || (a.year - b.year) || cmpText(a.title, b.title),
    title:  (a, b) => cmpText(a.title, b.title),
    year:   (a, b) => (a.year || 0) - (b.year || 0) || cmpText(a.artist, b.artist),
    released: (a, b) => ((a.originalYear || a.year || 0) - (b.originalYear || b.year || 0))
                        || cmpText(a.artist, b.artist),
    added:  (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    length: (a, b) => (a.duration || 0) - (b.duration || 0),
    tracks: (a, b) => a.tracks.length - b.tracks.length,
    plays:  (a, b) => (a.plays || 0) - (b.plays || 0),
    played: (a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0),
  }[key] || ((a, b) => cmpText(a.artist, b.artist));
  return list.slice().sort((a, b) => by(a, b) * dir || cmpText(a.title, b.title));
}

export function sortArtists(list, key, dir = 1) {
  const by = {
    name:   (a, b) => cmpText(a.sort, b.sort),
    albums: (a, b) => a.albums.size - b.albums.size,
    tracks: (a, b) => a.tracks.length - b.tracks.length,
    length: (a, b) => (a.duration || 0) - (b.duration || 0),
    plays:  (a, b) => (a.plays || 0) - (b.plays || 0),
    played: (a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0),
  }[key] || ((a, b) => cmpText(a.sort, b.sort));
  return list.slice().sort((a, b) => by(a, b) * dir || cmpText(a.sort, b.sort));
}

/**
 * Ranked search across tracks, albums and artists. One linear pass with
 * precomputed haystacks; ~2 ms over 50k tracks, so it runs on every keystroke.
 */
/* Containers that hold the whole signal. Used by the census and by the
   `lossless` search filter, which have to agree about what the word means. */
const LOSSLESS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'ape', 'wv', 'tta']);

/**
 * B2: the tempo, measured for preference and tagged as a fallback.
 *
 * Sonora derives BPM from the audio, which is the honest number and also the
 * one that isn't there until the track has been analysed. A fully tagged
 * library already knows, and refusing to read it means a DJ's collection
 * starts from nothing. The measurement wins wherever it exists; anywhere the
 * two are shown rather than compared, `tempoSource` says which this is.
 */
export const tempoOf = (t) => (t && t.bpm > 0 ? t.bpm : (t && t.bpmTag) || 0);
export const tempoSource = (t) => (t && t.bpm > 0 ? 'measured' : t && t.bpmTag ? 'tagged' : '');

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
  [/^bpm>(\d+)$/, (t, m) => tempoOf(t) > +m[1]],
  [/^bpm<(\d+)$/, (t, m) => tempoOf(t) > 0 && tempoOf(t) < +m[1]],
  /* B4: the year the music is from, which for a reissue is not `year:`. Falls
     back to the release date so `orig:1971` still finds a 1971 pressing that
     was never remastered. */
  [/^orig(?:inal)?:(\d{4})$/, (t, m) => (t.originalYear || t.year) === +m[1]],
  [/^reissue$/, (t) => t.originalYear > 0 && t.year > 0 && t.originalYear < t.year],
  /* B1: the comment, which is prose and so is searched rather than matched.
     Kept out of the general haystack on purpose — a paragraph about a vinyl
     rip should not outrank a song with the word in its title. */
  [/^note:(.+)$/, (t, m) => !!t.comment && norm(t.comment).includes(norm(m[1]))],
  [/^noted$/, (t) => !!t.comment],
  /* B3: the stars. `rated` is any of them; the comparisons take one. */
  [/^rated$/, (t) => (t.rating || 0) > 0],
  [/^unrated$/, (t) => !(t.rating > 0)],
  [/^rating>=?(\d)$/, (t, m) => (t.rating || 0) >= +m[1]],
  [/^rating<=?(\d)$/, (t, m) => (t.rating || 0) > 0 && (t.rating || 0) <= +m[1]],
  [/^rating:(\d)$/, (t, m) => (t.rating || 0) === +m[1]],
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
    const hits = [...live()].filter((t) => parsed.filters.every((f) => f.test(t)));
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
  for (const t of live()) {
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

/* L17: the covers you chose, listed.
 *
 * An override is invisible until you walk into the record that has one — which
 * makes it an override you cannot find, and therefore one you cannot undo six
 * months later when you have forgotten you set it. */
export const chosenCovers = () =>
  [...ownArt.keys()].map((key) => ({ key, album: state.albumBy.get(key) || null }));

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
  /* L15: a cue track has no file of its own — it is a range inside the side
     it came from, and `sourceId` names that. Resolved here rather than at
     every call site, so playback, the waveform and the analysis all reach the
     same file without any of them knowing about cue sheets. */
  const t = state.tracks.get(id);
  if (t && t.sourceId) id = t.sourceId;
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
    } else if (isPlaylistFile(entry.name)) {
      // L14: noticed, not imported. See `foundPlaylists` below.
      yield { handle: entry, path: prefix + entry.name, name: entry.name, playlist: true };
    } else if (isCueFile(entry.name)) {
      // L15: an index into the audio file beside it, not a track.
      yield { handle: entry, path: prefix + entry.name, name: entry.name, cue: true };
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
  // L14, and for the same reason: a playlist file sitting beside the music is
  // only reachable while the upload dialog's own list is still in hand.
  const lists = all.filter((f) => isPlaylistFile(f.name));
  // L15, and for the same reason again: a cue sheet is only reachable while
  // the dialog's own list is in hand.
  const cues = all.filter((f) => isCueFile(f.name));

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
  for (const f of lists) entries.push({ file: f, path: relative(f), name: f.name, playlist: true });
  for (const f of cues) entries.push({ file: f, path: relative(f), name: f.name, cue: true });
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
/* ------------------------------------------------------------------ I1
 *
 * Checking for new files.
 *
 * The library rescans at launch and never again: add an album to the folder
 * while the application is open and nothing happens, with no way to ask short
 * of reloading the page. The scan already re-parses only what changed — size
 * and modification time decide — so asking again is cheap and the answer is
 * usually "nothing".
 */
export async function rescanAll() {
  const roots = state.roots.filter((r) => r.handle && !r.off);
  if (!roots.length) return { ok: false, reason: 'nothing to scan' };
  for (const root of roots) await scanRoot(root);
  lastCheck = Date.now();
  return { ok: true, roots: roots.length };
}

let lastCheck = 0;
export const lastChecked = () => lastCheck;

/* And automatically, when the window comes back after a while.
 *
 * "A while" rather than every focus: alt-tabbing to a browser and back is not
 * a reason to walk twenty thousand files, and a scan that runs every time you
 * glance at another window is a scan that is always running. Two minutes is
 * long enough that this is a return rather than a glance. */
const AUTO_CHECK_AFTER = 2 * 60 * 1000;

export function watchForChanges() {
  const onFocus = () => {
    if (state.scanning) return;
    if (Date.now() - lastCheck < AUTO_CHECK_AFTER) return;
    if (!state.roots.some((r) => r.handle && !r.off)) return;
    lastCheck = Date.now();
    idle(() => { rescanAll().catch(() => {}); });
  };
  addEventListener('focus', onFocus);
  return () => removeEventListener('focus', onFocus);
}

/* ------------------------------------------------------------------ I4
 *
 * Turning a folder off without removing it.
 *
 * Multiple folders are supported and the only two options were keep and
 * remove — and removing empties everything that came from it, corrections and
 * favourites included. A drive that is not plugged in today is not a folder
 * you want to forget.
 *
 * Off means hidden from the library and left in the index: the tracks stay in
 * IndexedDB with everything attached to them, and turning it back on is a
 * reindex rather than a rescan.
 */
export async function setRootOff(id, off) {
  const root = state.roots.find((r) => r.id === id);
  if (!root) return false;
  root.off = !!off;
  await db.putRoot(serialiseRoot(root)).catch(() => {});
  reindex();
  events.emit('roots');
  events.emit('change');
  return true;
}

export const isRootOff = (id) => !!state.roots.find((r) => r.id === id)?.off;

export async function scanRoot(root) {
  // A folder that has been switched off is not scanned. It still has its
  // tracks in the index; they are simply not in the library today.
  if (root.off) return;
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

    /* L14: a playlist file is not a track either. Collected for the import to
       offer at the end — every collection that has been through another player
       has these, and the scan used to walk straight past them. Offered rather
       than imported, because a music folder can also contain a player's own
       auto-generated "Recently Added.m3u" and creating four playlists nobody
       asked for is worse than not looking. */
    if (e.playlist) {
      foundPlaylists.push({ rootId: root.id, path: e.path, name: e.name, handle: e.handle || e.file });
      continue;
    }

    /* L15: a cue sheet indexes the audio file beside it. Filed by the path
       they share up to the extension, exactly as a lyric sidecar is, and read
       after the audio has been parsed — the last track's length depends on
       the file's own duration, which the parser is about to work out. */
    if (e.cue) {
      cueSheets.set(root.id + '/' + e.path.replace(/\.[^./]+$/, ''), e.handle || e.file);
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

  /* Anything under this root we no longer see on disk is gone — or has moved,
     which looks exactly the same from here. B7: what the listener put on it is
     held aside under the file's own fingerprint before the row is dropped, and
     claimed below by whichever new file turns out to be the same recording. */
  const stale = [];
  moveCandidates.clear();
  for (const [id, t] of state.tracks) {
    if (t.rootId !== root.id || seen.has(id)) continue;
    stale.push(id);
    state.tracks.delete(id);
    handles.delete(id);
    const history = saveHistory(t);
    if (!worthCarrying(history)) continue;
    const key = t.size + ':' + t.mtime;
    // A second file with the same fingerprint makes the first ambiguous, and
    // an ambiguous match is worse than none: both are struck out.
    moveCandidates.set(key, moveCandidates.has(key) ? null : history);
  }
  if (stale.length) db.deleteTracks(stale).catch(() => {});

  /* Now the other half: a job with no track behind it, whose file matches one
     of the rows that just went. Claimed rather than copied — one departure can
     only account for one arrival. */
  if (moveCandidates.size) {
    for (const job of jobs) {
      if (state.tracks.has(job.id)) continue;
      const key = job.size + ':' + job.mtime;
      const history = moveCandidates.get(key);
      if (!history) continue;
      moveCandidates.delete(key);
      pendingMoves.set(job.id, history);
    }
    moveCandidates.clear();
  }

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

const serialiseRoot = (r) =>
  ({ id: r.id, name: r.name, kind: r.kind, handle: r.handle, count: r.count, off: !!r.off });

/* I2: what this run could not do.
 *
 * The scan bar shows progress, which on a twenty-thousand-file import is
 * twenty minutes of a bar — and anything unreadable was folded into a count
 * nobody could open. A file that failed has a name and a reason, and both are
 * worth more than the number.
 *
 * Capped, because a folder of the wrong kind of file produces one failure per
 * file and a list of nine thousand is not a list. The count is exact; the
 * names stop at fifty. */
const FAILURE_CAP = 50;
let scanFailures = [];
let scanFailCount = 0;

/** Files this run could not read, and why. */
export const lastFailures = () => ({ list: scanFailures.slice(), total: scanFailCount });

/**
 * Called for a file the import could not read properly.
 *
 * Two different things end up here and both belong in the same list, because
 * the question being answered is "which files came in badly":
 *
 *   — the tag reader threw. Rare: it is deliberately forgiving and returns
 *     something for a truncated FLAC, an empty MP3 and a file of pure noise,
 *     all of which were tried. This is the safety net for a real read error —
 *     a file that vanishes mid-scan, a permission withdrawn, a device that
 *     stops answering.
 *   — the file was read and said nothing. This is the common one, and it is
 *     the one that leaves a library looking mysteriously wrong: a track with
 *     a filename for a title, no artist and no album is indistinguishable
 *     from a badly tagged rip until somebody says which files they were.
 */
export function noteScanFailure(name, reason) {
  scanFailCount++;
  if (scanFailures.length < FAILURE_CAP) scanFailures.push({ name, reason });
}

function startScan() {
  if (state.scanning) return;
  state.scanning = true;
  // Folds from before this import — the ones the launch reindex did — are the
  // library's history, not this import's news.
  mergedThisScan.clear();
  foundPlaylists = [];
  scanFailures = [];
  scanFailCount = 0;
  movedCount = 0;
  pendingMoves.clear();
  scanStartedAt = Date.now();
  state.progress = { done: 0, total: 0, file: '' };
  events.emit('scan', true);
}
let scanStartedAt = 0;

function finishScan() {
  if (!state.scanning) return;
  state.scanning = false;
  reindex();

  // What the import actually did, in the terms the person cares about: how
  // many tracks arrived, and which albums got put back together.
  const added = state.progress.total || 0;
  const merged = [...mergedThisScan].map(([key, title]) => ({ key, title }));
  mergedThisScan.clear();
  const report = {
    at: Date.now(),
    ms: scanStartedAt ? Date.now() - scanStartedAt : 0,
    added,
    merged,
    failed: scanFailCount,
    failures: scanFailures.slice(),
    playlistFiles: foundPlaylists.slice(),
    // B7: files that turned out to have moved rather than been replaced. Worth
    // saying out loud — it is the difference between a rename and a loss, and
    // silence would leave the listener no way to tell which just happened.
    moved: movedCount,
  };
  pendingMoves.clear();
  /* I3: kept, not just toasted. "Added 50 tracks · merged Graduation" named
     the merge, which is exactly right, and then it was gone in four seconds
     and the merge was unreviewable. The last few runs are written down. */
  rememberRun(report);
  events.emit('scan', false, report);
  state.progress = { done: 0, total: 0, file: '' };
}

/* ------------------------------------------------------------------ I3
 *
 * The last few import runs, kept. Five, because the question this answers is
 * "what did that last import do" and the answer stops being interesting well
 * before it stops being storable. */
const RUN_LIMIT = 5;
let runs = [];

export const importRuns = () => runs.slice();

function rememberRun(report) {
  // A run that did nothing is not news. Startup rescans of an unchanged folder
  // are most of the runs there are, and a history of "added 0" is a history of
  // nothing.
  if (!report.added && !report.failed && !report.merged.length && !report.moved) return;
  runs.unshift({
    at: report.at,
    ms: report.ms,
    added: report.added,
    failed: report.failed,
    moved: report.moved || 0,
    merged: report.merged.map((m) => m.title),
    failures: report.failures.slice(0, 12),
  });
  runs = runs.slice(0, RUN_LIMIT);
  db.setKV('importRuns', runs).catch(() => {});
  events.emit('runs');
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

/** Returns how many were actually new to the playlist. */
export async function addToPlaylist(id, trackIds) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return 0;
  const have = new Set(p.tracks);
  // Only the ones that were not already in it: undoing an add of a track that
  // was in the playlist beforehand must not remove it.
  const added = [...new Set(trackIds)].filter((t) => !have.has(t));
  for (const t of added) p.tracks.push(t);
  if (!added.length) return 0;
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
  return added.length;
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

/* ------------------------------------------------------------------ ratings */

/**
 * B3: stars, because a favourite is one bit.
 *
 * One bit can say "I love this" and cannot say "worth keeping but I never
 * reach for it", which is most of a library. Zero to five, zero meaning
 * unrated rather than bad — there is no way to express "actively hate" and
 * there shouldn't be, since the answer to that is to delete the file.
 *
 * Unlike a favourite this lives *on* the track rather than in a list beside
 * it, because unlike a favourite it is a judgment about the recording and not
 * a shortlist with an order. Files arrive with a rating already in them —
 * POPM, `rate`, `RATING` — and the tag is the starting position, not the
 * final word: setting one here overwrites it and a rescan will not undo that,
 * which is the same bargain every other correction makes.
 */
export async function setRating(ids, stars) {
  const list = Array.isArray(ids) ? ids : [ids];
  const n = Math.max(0, Math.min(5, Math.round(stars || 0)));
  const rows = [];
  const before = [];
  for (const each of list) {
    const t = typeof each === 'string' ? state.tracks.get(each) : each;
    if (!t || (t.rating || 0) === n) continue;
    before.push({ id: t.id, rating: t.rating || 0 });
    if (n) t.rating = n; else delete t.rating;
    rows.push(t);
  }
  if (!rows.length) return 0;

  const apply = async (snap) => {
    const back = [];
    for (const { id, rating } of snap) {
      const t = state.tracks.get(id);
      if (!t) continue;
      if (rating) t.rating = rating; else delete t.rating;
      back.push(t);
    }
    await db.putTracks(back).catch(() => {});
    events.emit('change');
    return back.length;
  };

  await db.putTracks(rows).catch(() => {});
  events.emit('change');
  const after = rows.map((t) => ({ id: t.id, rating: t.rating || 0 }));
  undo.push({
    label: rows.length === 1 ? `the rating on “${rows[0].title}”` : `${rows.length} ratings`,
    undo: () => apply(before),
    redo: () => apply(after),
  });
  return rows.length;
}

/** The stars on a track, or on the tracks of an album where they agree. */
export function ratingOf(tracks) {
  const list = Array.isArray(tracks) ? tracks : [tracks];
  const seen = new Set(list.filter(Boolean).map((t) => t.rating || 0));
  return seen.size === 1 ? [...seen][0] : 0;
}

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
  const [tracks, roots, playlists, recent, faves, sn, own, savedRuns, savedFolders] = await Promise.all([
    db.getAllTracks().catch(() => []),
    db.getRoots().catch(() => []),
    db.getPlaylists().catch(() => []),
    db.getKV('recent').catch(() => null),
    db.getKV('favourites').catch(() => null),
    db.getKV('serial').catch(() => null),
    db.getKV('ownArt').catch(() => null),
    db.getKV('importRuns').catch(() => null),
    db.getKV('playlistFolders').catch(() => null),
  ]);

  serial = typeof sn === 'string' && sn ? sn : makeSerial();
  if (serial !== sn) db.setKV('serial', serial).catch(() => {});

  for (const t of tracks) { decorate(t); state.tracks.set(t.id, t); }
  state.roots = roots;
  state.playlists = playlists;
  sortPlaylists();
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
  // I3: what the last few imports did, across sessions — the question "what
  // did that import do" is usually asked after a reload.
  if (Array.isArray(savedFolders)) {
    folders = savedFolders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string');
  }
  if (Array.isArray(savedRuns)) {
    runs = savedRuns.filter((r) => r && typeof r.at === 'number').slice(0, RUN_LIMIT);
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
