/* backup.js — everything you have told Sonora, as one file.
 *
 * D3 and D4. This application has no account and no server: the library is a
 * folder on your disk and everything the application knows *about* it lives in
 * one browser's IndexedDB. That is the whole design, and it has one corollary
 * nobody had drawn — there is no other copy anywhere. "Clear library" is
 * honest about destroying the overlays, and there was no way to take a copy
 * first. An eviction, a cleared profile or a new machine took months of
 * corrections, favourites and chosen covers with it.
 *
 * WHAT IS IN IT, and what is not.
 *
 * In: the things you authored. Playlists, favourites, tag corrections (with
 * what each one replaced, so an import can be undone), chosen covers and their
 * sampled colours, saved racks and rack bindings, listening totals, the Look,
 * and the settings. All of it small — a twenty-thousand-track library with
 * heavy corrections is a few megabytes of JSON.
 *
 * Not in: the audio, obviously, and not the artwork thumbnails either unless
 * they are asked for. Thumbnails are the only large thing here and they can be
 * rebuilt from the files in seconds, so including them by default would turn a
 * 2 MB backup into a 300 MB one to save a rescan.
 *
 * Not in: the folder handles. A File System Access handle is bound to the
 * browser profile that granted it and means nothing anywhere else, so a
 * restored backup names the folders it expects and asks you to point at them.
 *
 * HOW IT COMES BACK. Merged, never replaced, and previewed first. A backup is
 * usually older than the library it is being read into — the common case is a
 * new browser on the same machine, where the tracks have just been rescanned
 * and only the overlays are missing — so an import that replaced would throw
 * away everything done since. Every merge is one undo entry.
 */

import * as db from './db.js';
import * as lib from './library.js';
import * as looks from './looks.js';
import * as undo from './undo.js';

export const KIND = 'sonora.backup';
const VERSION = 1;

/* The settings worth carrying. Named rather than swept up, because `kv` also
   holds the session, the queue and the resume marks — state about this
   moment rather than about you, and restoring a six-month-old playhead onto a
   different machine is not a restore, it is a surprise. */
const SETTINGS = [
  'volume', 'shuffle', 'repeat', 'crossfade', 'seamless', 'levelling',
  'shuffleMode', 'trimSilence', 'beatMatch', 'fadeCurve', 'sink',
  'audio:v1', 'looks:v1', 'ownArt', 'sleep',
];

/* ------------------------------------------------------------------ writing */

/**
 * Builds the backup.
 *
 * @param {{art?: boolean}} opts  `art: true` includes the artwork thumbnails,
 *   which is almost always the wrong trade — see the note at the top.
 */
export async function build({ art = false } = {}) {
  const tracks = await db.getAllTracks().catch(() => []);

  /* Only the tracks that carry something of yours. A backup of the scan is a
     backup of the folder, which you already have; what cannot be rebuilt is
     what you told the application. */
  const overlays = [];
  for (const t of tracks) {
    const has = (t.edits && Object.keys(t.edits).length) ||
                t.playCount || t.lastPlayed || t.rating;
    if (!has) continue;
    overlays.push({
      id: t.id,
      path: t.path || '',
      title: t.title || '',
      artist: t.artist || '',
      edits: t.edits || undefined,
      orig: t.orig || undefined,
      playCount: t.playCount || undefined,
      lastPlayed: t.lastPlayed || undefined,
      rating: t.rating || undefined,
    });
  }

  const settings = {};
  for (const k of SETTINGS) {
    const v = await db.getKV(k).catch(() => undefined);
    if (v !== undefined && v !== null) settings[k] = v;
  }

  const doc = {
    kind: KIND,
    version: VERSION,
    app: 'Sonora',
    saved: new Date().toISOString(),
    counts: {},
    roots: (await db.getRoots().catch(() => []))
      // The handle is deliberately dropped: see the note at the top.
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    playlists: await db.getPlaylists().catch(() => []),
    favourites: lib.favourites.ids.slice(),
    overlays,
    racks: await db.getKV('racks').catch(() => null) || undefined,
    bindings: await db.getKV('rackBindings').catch(() => null) || undefined,
    listening: await db.getKV('listen:v1').catch(() => null) || undefined,
    look: looks.state ? { ...looks.state } : undefined,
    settings,
  };

  if (art) {
    /* Base64, because JSON has no other way to carry bytes and a backup that
       needs a second file is a backup somebody will lose half of. */
    const keys = await db.artKeys().catch(() => []);
    const out = {};
    for (const k of keys) {
      const blob = await db.getArt(k).catch(() => null);
      if (!blob) continue;
      out[k] = await blobToDataUrl(blob);
    }
    doc.art = out;
  }

  doc.counts = {
    playlists: doc.playlists.length,
    favourites: doc.favourites.length,
    overlays: overlays.length,
    art: doc.art ? Object.keys(doc.art).length : 0,
  };
  return doc;
}

function blobToDataUrl(blob) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(null);
    fr.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url) {
  try { return await (await fetch(url)).blob(); } catch { return null; }
}

/* ------------------------------------------------------------------ reading */

/**
 * Reads a backup and works out what merging it would do — without doing any of
 * it. What comes back is what the dialog shows.
 *
 * Nothing in the file is trusted. It names its own fields, any of them may be
 * missing or of the wrong type, and it may have been written by somebody else.
 */
export function inspect(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'That is not a Sonora backup.' }; }
  if (!doc || doc.kind !== KIND) return { ok: false, reason: 'That is not a Sonora backup.' };
  if (!(doc.version <= VERSION)) {
    return { ok: false, reason: 'That backup was written by a newer version of Sonora.' };
  }

  const list = (v) => (Array.isArray(v) ? v : []);
  const playlists = list(doc.playlists).filter((p) => p && typeof p.name === 'string');
  const favourites = list(doc.favourites).filter((id) => typeof id === 'string');
  const overlays = list(doc.overlays).filter((o) => o && typeof o.id === 'string');

  /* Which of them land. A backup usually names tracks this library has, but
     not always — a different machine may have the same music at different
     paths, and saying "412 corrections, 380 of which match tracks you have" is
     the difference between a restore and a hope. */
  const known = (id) => !!lib.getTrack(id);
  const matched = overlays.filter((o) => known(o.id)).length;
  const favMatched = favourites.filter(known).length;

  const havePlaylist = new Set(lib.state.playlists.map((p) => p.name.toLowerCase()));
  const newPlaylists = playlists.filter((p) => !havePlaylist.has(p.name.toLowerCase())).length;

  return {
    ok: true,
    doc,
    saved: typeof doc.saved === 'string' ? doc.saved : '',
    summary: {
      playlists: playlists.length,
      newPlaylists,
      favourites: favourites.length,
      favMatched,
      overlays: overlays.length,
      matched,
      art: doc.art ? Object.keys(doc.art).length : 0,
      look: !!doc.look,
      settings: doc.settings ? Object.keys(doc.settings).length : 0,
      roots: list(doc.roots).map((r) => r && r.name).filter(Boolean),
    },
  };
}

/**
 * Merges an inspected backup into the library.
 *
 * Merge rules, and each is a decision rather than a default:
 *   — a playlist whose name this library already has is left alone, and the
 *     one from the file arrives beside it with "(from backup)" after its name.
 *     Silently merging two playlists with the same name is the one outcome
 *     nobody can undo by hand.
 *   — a favourite is a set, so it is a union.
 *   — a correction replaces whatever the track carries, because it is the
 *     thing the backup exists to restore and the file is the authority on it.
 *   — a play count is the larger of the two and a last-played is the later,
 *     which is right whichever way round the two libraries are.
 *   — settings and the Look are applied only if `settings` is asked for.
 */
export async function merge(read, { overlays = true, playlists = true, favourites = true,
                                    settings = false, art = true } = {}) {
  if (!read || !read.ok) return { ok: false };
  const doc = read.doc;
  const done = { playlists: 0, favourites: 0, overlays: 0, art: 0 };
  const undoSteps = [];

  /* Everything below goes through the ordinary mutators, every one of which
     records its own undo entry — so the whole merge runs with the stack deaf
     and pushes one entry of its own at the end. Without this a restore landed
     one entry per playlist and per favourite as well as the entry for the
     restore, and undoing the restore left them all behind describing changes
     that had already been taken back. */
  await undo.silence(async () => {
  if (playlists && Array.isArray(doc.playlists)) {
    const have = new Set(lib.state.playlists.map((p) => p.name.toLowerCase()));
    for (const p of doc.playlists) {
      if (!p || typeof p.name !== 'string') continue;
      const name = have.has(p.name.toLowerCase()) ? `${p.name} (from backup)` : p.name;
      const ids = Array.isArray(p.trackIds) ? p.trackIds.filter((id) => typeof id === 'string') : [];
      const made = await lib.createPlaylist(name, ids);
      if (made) { done.playlists++; undoSteps.push(() => lib.removePlaylist(made.id)); }
    }
  }

  if (favourites && Array.isArray(doc.favourites)) {
    const added = [];
    for (const id of doc.favourites) {
      if (typeof id !== 'string' || lib.isFavourite(id) || !lib.getTrack(id)) continue;
      lib.toggleFavourite(id, true);
      added.push(id);
      done.favourites++;
    }
    if (added.length) undoSteps.push(() => { for (const id of added) lib.toggleFavourite(id, false); });
  }

  if (overlays && Array.isArray(doc.overlays)) {
    const rows = [];
    const before = [];
    for (const o of doc.overlays) {
      const t = lib.getTrack(o && o.id);
      if (!t) continue;
      /* A copy, because the row below is the live object and is about to be
         written into. Structured rather than by hand: a track carries nested
         `edits` and `orig` objects, and a shallow copy would hand the undo
         path the very objects it is meant to be able to put back. */
      before.push(JSON.parse(JSON.stringify(t)));
      if (o.edits && typeof o.edits === 'object') {
        t.edits = { ...o.edits };
        if (o.orig && typeof o.orig === 'object') t.orig = { ...o.orig };
      }
      if (typeof o.playCount === 'number') t.playCount = Math.max(t.playCount || 0, o.playCount);
      if (typeof o.lastPlayed === 'number') t.lastPlayed = Math.max(t.lastPlayed || 0, o.lastPlayed);
      if (typeof o.rating === 'number') t.rating = o.rating;
      rows.push(t);
      done.overlays++;
    }
    if (rows.length) {
      await lib.restoreFromBackup(rows);
      undoSteps.push(() => lib.restoreFromBackup(before));
    }
  }

  if (art && doc.art && typeof doc.art === 'object') {
    for (const [key, url] of Object.entries(doc.art)) {
      if (typeof url !== 'string' || !url.startsWith('data:')) continue;
      const blob = await dataUrlToBlob(url);
      if (!blob) continue;
      await db.putArt(key, blob).catch(() => {});
      done.art++;
    }
  }

  /* Listening totals. Not merged field by field: `stats` owns the shape and
     the only sane rule between two tallies of the same listening is the larger
     one, which needs the module's own reader. Restored only alongside the
     settings, because a tally is a fact about a machine as much as about a
     person. */
  if (settings && doc.listening) {
    await db.setKV('listen:v1', doc.listening).catch(() => {});
  }

  if (settings && doc.settings && typeof doc.settings === 'object') {
    for (const [k, v] of Object.entries(doc.settings)) {
      if (!SETTINGS.includes(k)) continue;
      await db.setKV(k, v).catch(() => {});
    }
  }
  });

  /* One entry for the whole merge. Restoring a backup is one act, and an undo
     stack with four hundred separate corrections in it after it is a stack
     nobody can get back through. */
  if (undoSteps.length) {
    const label = `restoring a backup from ${read.saved ? read.saved.slice(0, 10) : 'a file'}`;
    undo.push({
      label,
      undo: async () => { for (const step of undoSteps.reverse()) await step(); },
      /* No redo: half of the merge creates playlists with fresh ids, so
         replaying it would make second copies rather than putting the first
         ones back. Saying so is better than a redo that quietly duplicates. */
      redo: null,
    });
  }

  return { ok: true, done };
}
