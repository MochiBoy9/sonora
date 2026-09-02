/* m3u.js — playlists as files.
 *
 * L13 and L14. This is the one I would argue hardest for. Sonora's whole
 * premise is that the library is a folder on your disk and nothing is locked
 * away — and then playlists, the one thing you actually author here, existed
 * only inside IndexedDB, reachable by nothing else and lost with a Clear
 * library. That is the same objection this application makes to every other
 * player, turned inward.
 *
 * M3U is thirty years old, is a text file, and every other player reads it.
 * Extended M3U — the `#EXTINF` form — carries the duration and the display
 * name as well, so an exported playlist still says what it is even where the
 * files have moved.
 *
 * PATHS. Relative, and relative to where the file is being saved, because a
 * playlist full of absolute paths is a playlist that works on exactly one
 * machine. Sonora does not know where the browser will put a download, so an
 * export writes paths relative to the library root and says so in a comment —
 * which is what a playlist sitting beside the music folder needs.
 *
 * MATCHING, on the way back in. A path from another player is a path from
 * another machine: separators differ, the root differs, the case may differ.
 * So the match is by the tail of the path, longest first, and anything that
 * matches nothing is reported rather than dropped — "6 of 60 not found, here
 * they are" is a usable answer and a silent 54-track playlist is not.
 */

import * as lib from './library.js';

/* ------------------------------------------------------------------ writing */

/** One playlist as Extended M3U text. */
export function write(name, tracks) {
  const out = ['#EXTM3U', `#PLAYLIST:${name}`];
  out.push('# Written by Sonora. Paths are relative to your music folder.');
  for (const t of tracks) {
    if (!t) continue;
    const secs = Math.round(t.duration || 0) || -1;
    const who = [t.artist, t.title].filter(Boolean).join(' - ') || t.name || '';
    out.push(`#EXTINF:${secs},${who}`);
    out.push(String(t.path || t.name || '').replace(/\\/g, '/'));
  }
  return out.join('\n') + '\n';
}

/** A filename for it, safe on every filesystem anybody is likely to use. */
export const fileName = (name) =>
  (String(name || 'playlist').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'playlist') + '.m3u8';

/* ------------------------------------------------------------------ reading */

/**
 * Parses M3U text into names and paths. No matching yet — that is `resolve`.
 *
 * Both dialects: a plain list of paths, and the extended form with `#EXTINF`
 * lines carrying a duration and a name. Anything else beginning with `#` is a
 * comment, including the `#EXTM3U` header itself.
 */
export function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let name = '';
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const inf = /^#EXTINF:\s*(-?\d+)\s*,\s*(.*)$/i.exec(line);
      if (inf) { pending = { seconds: +inf[1], label: inf[2] }; continue; }
      const pl = /^#PLAYLIST:\s*(.+)$/i.exec(line);
      if (pl) { name = pl[1].trim(); continue; }
      continue;
    }
    entries.push({ path: line.replace(/\\/g, '/'), ...(pending || {}) });
    pending = null;
  }
  return { name, entries };
}

/**
 * Matches parsed entries against the library.
 *
 * By the tail of the path, longest first: `/Users/x/Music/Nick Drake/Pink
 * Moon/01 Pink Moon.mp3` and `Nick Drake/Pink Moon/01 Pink Moon.mp3` are the
 * same file said two ways, and the part they share is the end. Matching on the
 * filename alone would be too eager — every rip has an `01 Intro.mp3` — so the
 * longest shared tail wins and a bare filename is only accepted when it is
 * unambiguous.
 *
 * Case-folded, because a playlist written on Windows and a library read on a
 * case-sensitive filesystem disagree about nothing that matters.
 */
export function resolve(entries) {
  /* One index, built per call rather than kept: this runs when somebody
     imports a playlist, which is rare, and a stale index would silently miss
     everything imported since. */
  const byTail = new Map();
  const byFile = new Map();
  for (const t of lib.allTracks()) {
    const p = String(t.path || t.name || '').replace(/\\/g, '/').toLowerCase();
    if (!p) continue;
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const tail = parts.slice(i).join('/');
      let list = byTail.get(tail);
      if (!list) byTail.set(tail, list = []);
      list.push(t);
    }
    const file = parts[parts.length - 1];
    let f = byFile.get(file);
    if (!f) byFile.set(file, f = []);
    f.push(t);
  }

  const found = [];
  const missing = [];
  for (const e of entries) {
    const p = e.path.toLowerCase();
    const parts = p.split('/');
    let hit = null;
    // Longest tail first: the most specific agreement wins.
    for (let i = 0; i < parts.length && !hit; i++) {
      const list = byTail.get(parts.slice(i).join('/'));
      if (list && list.length === 1) hit = list[0];
      else if (list && list.length > 1 && i === 0) hit = list[0];   // whole path, still ambiguous
    }
    /* A bare filename, only when it names one file. Two tracks called
       "01 Intro.mp3" are two different records and guessing between them is
       worse than saying so. */
    if (!hit) {
      const f = byFile.get(parts[parts.length - 1]);
      if (f && f.length === 1) hit = f[0];
    }
    if (hit) found.push(hit); else missing.push(e);
  }
  return { found, missing };
}

/* ------------------------------------------------------------------ L14
 *
 * The .m3u files already sitting in the folder.
 *
 * Most collections that have been through another player have playlists in
 * them as files, and the scan walked straight past them. They are collected
 * during the walk and offered at the end of an import — offered, not imported:
 * a folder can contain a player's own auto-generated "Recently Added.m3u" and
 * silently creating four playlists nobody asked for is worse than not looking.
 */
export { isPlaylistFile } from './util.js';
