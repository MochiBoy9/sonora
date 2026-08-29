/* stats.js — how long you have actually listened, and to what.
 *
 * Play *counts* lie: a track skipped at four seconds counts the same as one
 * played to the end. This module measures the thing that is true instead —
 * seconds of audio that actually reached the speakers — and rolls it up by
 * artist, genre and year for the Circle Analysis Center.
 *
 * The meter is driven by the shared ticker rather than by `timeupdate`, and it
 * only counts while the element is genuinely playing, so seeking, pausing and
 * a track that fails to decode all cost nothing. Totals are written back to
 * IndexedDB on a slow flush (every 20s, on pause, on track change and on
 * pagehide), which is cheap enough that a listening session of any length adds
 * a handful of writes.
 */

import * as db from './db.js';
import * as lib from './library.js';
import * as player from './player.js';
import { Emitter, norm } from './util.js';
import { tick } from './motion.js';

export const events = new Emitter();

const KEY = 'listen:v1';
const FLUSH_MS = 20000;
/** Below this, it was a skip rather than a listen. */
const MIN_CREDIT = 2;

/** trackId -> seconds listened, across all time. */
let totals = new Map();
let loaded = false;

let currentId = null;
let credit = 0;                 // seconds banked for the current track
let dirty = false;
let lastFlush = 0;
let stopTick = null;

/* ------------------------------------------------------------------ meter */

function frame(dt, now) {
  const t = player.state.current;
  if (!t || !player.state.playing) return;

  if (t.id !== currentId) { bank(); currentId = t.id; credit = 0; }
  credit += dt / 1000;

  if (now - lastFlush > FLUSH_MS) { bank(); flush(); }
}

/** Moves the running credit into the totals. */
function bank() {
  if (currentId && credit >= MIN_CREDIT) {
    totals.set(currentId, (totals.get(currentId) || 0) + credit);
    dirty = true;
    events.emit('change');
  }
  credit = 0;
}

function flush() {
  lastFlush = performance.now();
  if (!dirty) return;
  dirty = false;
  db.setKV(KEY, Object.fromEntries(totals)).catch(() => {});
}

/** Only run a frame callback while something is actually playing. */
function syncTicker() {
  const wanted = player.state.playing;
  if (wanted && !stopTick) { lastFlush = performance.now(); stopTick = tick(frame); }
  else if (!wanted && stopTick) { stopTick(); stopTick = null; bank(); flush(); }
}

export async function init() {
  const stored = await db.getKV(KEY).catch(() => null);
  if (stored && typeof stored === 'object') {
    totals = new Map(Object.entries(stored).filter(([, v]) => typeof v === 'number' && v > 0));
  }
  loaded = true;

  player.events.on('state', syncTicker);
  player.events.on('track', () => { bank(); currentId = player.state.current?.id || null; });
  addEventListener('pagehide', () => { bank(); flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { bank(); flush(); } });
  syncTicker();
  events.emit('change');
}

export const isReady = () => loaded;

/* ------------------------------------------------------------------ queries */

/** Seconds listened for one track, including whatever is playing right now. */
export function forTrack(id) {
  const base = totals.get(id) || 0;
  return id === currentId ? base + credit : base;
}

/** Seconds listened across everything. */
export function total() {
  let sum = 0;
  for (const v of totals.values()) sum += v;
  return sum + (currentId ? credit : 0);
}

export const trackedCount = () => totals.size;

export const MODES = [
  { id: 'artist', label: 'Artists' },
  { id: 'genre', label: 'Genre' },
  { id: 'year', label: 'Year' },
];

export const isMode = (id) => MODES.some((m) => m.id === id);

/**
 * Rolls listening time up by artist, genre or year.
 *
 * Returns `[{ key, label, seconds, plays, share }]`, largest first. Tracks the
 * library no longer holds are skipped rather than counted under a blank label:
 * a slice you cannot click into is worse than no slice.
 */
export function byMode(mode = 'artist', { limit = 60 } = {}) {
  const buckets = new Map();
  const add = (key, label, seconds) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { key, label, seconds: 0, plays: 0, share: 0 });
    b.seconds += seconds;
    b.plays++;
  };

  const ids = new Set(totals.keys());
  if (currentId) ids.add(currentId);

  for (const id of ids) {
    const seconds = forTrack(id);
    if (seconds < MIN_CREDIT) continue;
    const t = lib.getTrack(id);
    if (!t) continue;

    if (mode === 'genre') {
      const g = (t.genre || '').trim();
      add(g ? norm(g) : '~none', g || 'No genre', seconds);
    } else if (mode === 'year') {
      const y = t.year || 0;
      add(y ? String(y) : '~none', y ? String(y) : 'No year', seconds);
    } else {
      add(t.artistKey || norm(t.artist), t.albumArtist || t.artist || 'Unknown Artist', seconds);
    }
  }

  const out = [...buckets.values()].sort((a, b) => b.seconds - a.seconds);
  const sum = out.reduce((n, b) => n + b.seconds, 0) || 1;
  for (const b of out) b.share = b.seconds / sum;
  return out.slice(0, limit);
}

/** Everything this listener has ever been credited for, wiped. */
export async function reset() {
  totals = new Map();
  credit = 0;
  dirty = false;
  await db.setKV(KEY, {}).catch(() => {});
  events.emit('change');
}
