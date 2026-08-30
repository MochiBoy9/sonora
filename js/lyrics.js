/* lyrics.js — the words, from the disk first and the network only if asked.
 *
 * Three places to look, in this order, and the order is the point:
 *
 *   1. a sidecar — `04 Ferry Road.lrc` sitting next to `04 Ferry Road.mp3`.
 *      This is where the people who care about lyrics already keep them, and
 *      reading a file the listener already has costs nothing and asks nobody.
 *   2. the tag — ID3 USLT, the MP4 `©lyr` atom, a Vorbis LYRICS comment. Also
 *      already on the disk, also nobody's business but the listener's.
 *   3. LRCLIB, and only if Online is switched on.
 *
 * The third tier is the exception that proves the rule, and it is gated by the
 * same consent as the Band Overview — the same switch, the same promise, the
 * same cache. With Online off this module makes no requests at all and simply
 * says it found nothing, which for most libraries will be wrong only for the
 * tracks that had nothing to find anyway.
 *
 * What leaves the device, when it is on: the artist, the title, the album and
 * the length of one track, at the moment somebody asks for its words. Nothing
 * else, ever — not the path, not the library, not what else is in it.
 */

import * as lib from './library.js';
import * as band from './band.js';
import * as db from './db.js';
import { Emitter } from './util.js';

export const events = new Emitter();

const TTL = 30 * 24 * 60 * 60 * 1000;             // a month, same as band.js
const TIMEOUT = 9000;
const API = 'https://lrclib.net/api/get';

/** Track id -> result, so re-opening the same song costs nothing. */
const memo = new Map();

/* ------------------------------------------------------------------ parsing */

/**
 * An LRC line is `[mm:ss.xx] words`, and a file may put several stamps on one
 * line when a chorus repeats. Anything without a stamp is kept as plain text,
 * because half the `.lrc` files in the world are really `.txt` files with the
 * wrong extension — and a file that turns out to be unsynced is still the
 * words to the song.
 *
 * `[ti:]`, `[ar:]` and friends are metadata rather than lines, and are
 * dropped: the app already knows the title and the artist, and printing them
 * again at the top of the lyrics is how an .lrc file looks when nobody read
 * the spec.
 */
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META = /^\[[a-z]{2,}:.*\]$/i;

export function parse(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return null;

  const lines = [];
  let synced = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { lines.push({ t: null, text: '' }); continue; }
    if (META.test(trimmed)) continue;

    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = STAMP.exec(trimmed)) !== null) {
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    const words = trimmed.replace(STAMP, '').trim();

    if (stamps.length) {
      synced = true;
      // A line stamped three times is sung three times, and each is its own
      // line as far as the reader is concerned.
      for (const t of stamps) lines.push({ t, text: words });
    } else {
      lines.push({ t: null, text: words });
    }
  }

  if (synced) {
    // In a timed file the gaps are the timestamps, so a blank line carries no
    // information — and having none, it has nowhere to sort to and ends up at
    // the bottom as a stray space. Dropped before the sort rather than after,
    // so it never gets there.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].t == null && !lines[i].text) lines.splice(i, 1);
    }
    // Stamps may arrive out of order when a file was assembled by hand.
    lines.sort((a, b) => (a.t == null ? 1 : b.t == null ? -1 : a.t - b.t));
  }

  // A file of nothing but blank lines is not lyrics.
  if (!lines.some((l) => l.text)) return null;
  return { lines, synced };
}

/* ------------------------------------------------------------------ tiers */

/** 1. A file sitting beside the audio. */
async function fromSidecar(track) {
  const p = lib.lyricFileFor(track.id);
  if (!p) return null;
  const file = await p;
  if (!file) return null;
  try {
    const parsed = parse(await file.text());
    return parsed && { ...parsed, source: 'sidecar' };
  } catch { return null; }
}

/**
 * 2. Inside the file.
 *
 * The tag is re-read rather than stored at import, deliberately. Lyrics run to
 * a few kilobytes and most tracks have none; keeping them on every record
 * would put megabytes into an index whose whole design is to be small enough
 * to paint before the disk is touched. One parse, when somebody actually asks,
 * is the cheaper trade — and the reader already only reads the head of the
 * file, which is where USLT lives.
 */
async function fromTag(track) {
  const file = await lib.fileFor(track.id);
  if (!file) return null;
  try {
    const { readTags } = await import('./tags.js');
    const tags = await readTags(file, track.path, track.name);
    const parsed = tags && parse(tags.lyrics);
    return parsed && { ...parsed, source: 'embedded' };
  } catch { return null; }
}

/** 3. LRCLIB, and only with consent. */
async function fromOnline(track) {
  if (!band.isEnabled() || !band.isOnline()) return null;

  const key = 'lyrics:' + [track.artist, track.title, Math.round(track.duration || 0)]
    .join('::').toLowerCase();
  const hit = await db.getBand(key).catch(() => null);
  if (hit && Date.now() - hit.at < TTL) {
    return hit.data ? { ...hit.data, source: 'online' } : null;
  }

  const url = API +
    '?artist_name=' + encodeURIComponent(track.artist || '') +
    '&track_name=' + encodeURIComponent(track.title || '') +
    '&album_name=' + encodeURIComponent(track.album || '') +
    '&duration=' + Math.round(track.duration || 0);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let data = null;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    // 404 is the ordinary answer for a track nobody has transcribed, and it is
    // cached like any other: asking again tomorrow will not have helped.
    if (res.ok) {
      const j = await res.json();
      if (j && j.instrumental) data = { lines: [], synced: false, instrumental: true };
      else data = parse(j && (j.syncedLyrics || j.plainLyrics));
    }
  } catch { /* offline, blocked, timed out — all the same to the caller */ }
  clearTimeout(timer);

  db.putBand({ key, data, at: Date.now() }).catch(() => {});
  return data ? { ...data, source: 'online' } : null;
}

/* ------------------------------------------------------------------ api */

/**
 * Everything known about one track's words.
 *
 * Resolves to `{ lines, synced, source }`, or null when there is nothing to
 * show. The tiers are tried in order and the first hit wins — a file the
 * listener put there on purpose beats a tag, and a tag beats a stranger's
 * transcription.
 */
export async function forTrack(track) {
  if (!track) return null;
  if (memo.has(track.id)) return memo.get(track.id);

  const p = (async () => {
    return (await fromSidecar(track)) || (await fromTag(track)) || (await fromOnline(track));
  })();

  // The promise goes in the cache, not the result: two callers asking at the
  // same moment — the stage and the panel, say — should share one lookup
  // rather than race each other to the same file.
  memo.set(track.id, p);
  const out = await p;
  memo.set(track.id, out);
  events.emit('lyrics', track.id, out);
  return out;
}

/** What is known already, without going and looking. */
export function peek(track) {
  const hit = track && memo.get(track.id);
  return hit && typeof hit.then === 'function' ? null : hit || null;
}

/**
 * Which line is being sung at `time`, or -1.
 *
 * A plain binary search over stamps that are already sorted. Called once a
 * frame while the stage is open, so it may not allocate and may not be linear
 * over a two-hundred-line file.
 */
export function lineAt(result, time) {
  if (!result || !result.synced) return -1;
  const lines = result.lines;
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t != null && lines[mid].t <= time) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

/** Forgets one track, or all of them — used when Online is switched off. */
export function forget(id) {
  if (id) memo.delete(id);
  else memo.clear();
}
