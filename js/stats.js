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
const DAYS_KEY = 'listen-days:v1';
const FLUSH_MS = 20000;
/** Below this, it was a skip rather than a listen. */
const MIN_CREDIT = 2;

/** trackId -> seconds listened, across all time. */
let totals = new Map();
let loaded = false;

/* ------------------------------------------------------------------ A1
 *
 * When, as well as how much.
 *
 * `totals` answers "how long have I listened to this" and cannot answer a
 * single question with a date in it — not "what did I play last month", not
 * "what do I put on at the weekend", not "what was I listening to a year ago
 * today". The map above is the whole of what this module knew, and one axis
 * was missing from it.
 *
 * So there is a second map: `YYYY-MM-DD` to a map of trackId to seconds. Days
 * rather than timestamps, because every question anybody actually asks of a
 * listening history is a question about a period, and a day is the smallest
 * period worth keeping — an exact clock time would be four times the storage
 * to answer nothing extra.
 *
 * WHAT IT COSTS. A day of heavy listening touches perhaps forty tracks, so a
 * year is around 15,000 short entries — a few hundred kilobytes, against a
 * library index that is already megabytes. Days older than the retention
 * window are dropped whole, and the window is generous because the whole point
 * of this data is that it gets more interesting with age.
 *
 * WHY IT CANNOT BE BACKFILLED. `lastPlayed` is one number per track that the
 * next play overwrites, so there is no past to recover — a history started
 * today begins today. That is the argument for starting it now rather than
 * when something needs it.
 */
const KEEP_DAYS = 1200;              // a little over three years
let days = new Map();                // 'YYYY-MM-DD' -> Map(trackId -> seconds)
let daysDirty = false;

/** The local date, as the key this module files things under. */
export function dayKey(when = Date.now()) {
  const d = new Date(when);
  // Local, not UTC: a listener at 1am is having last night, not tomorrow.
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Adds seconds to one day's tally for one track. */
function credit_day(id, seconds, when = Date.now()) {
  const key = dayKey(when);
  let bucket = days.get(key);
  if (!bucket) days.set(key, bucket = new Map());
  bucket.set(id, (bucket.get(id) || 0) + seconds);
  daysDirty = true;
}

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
    // A1: the same credit, filed under today as well as under all time.
    credit_day(currentId, credit);
    dirty = true;
    events.emit('change');
  }
  credit = 0;
}

function flush() {
  lastFlush = performance.now();
  if (!dirty && !daysDirty) return;
  if (dirty) {
    dirty = false;
    db.setKV(KEY, Object.fromEntries(totals)).catch(() => {});
  }
  if (daysDirty) {
    daysDirty = false;
    /* Written as a plain object of objects and rounded to the second: this is
       a log, and a tenth of a second of listening on the third of March is not
       a fact anybody will ever need. Rounding roughly halves the file. */
    const out = {};
    for (const [day, bucket] of days) {
      const o = {};
      for (const [id, secs] of bucket) if (secs >= 1) o[id] = Math.round(secs);
      if (Object.keys(o).length) out[day] = o;
    }
    db.setKV(DAYS_KEY, out).catch(() => {});
  }
}

/** Drops days past the retention window. Runs once, at load. */
function prune() {
  if (days.size <= KEEP_DAYS) return;
  const keys = [...days.keys()].sort();
  for (const k of keys.slice(0, keys.length - KEEP_DAYS)) days.delete(k);
  daysDirty = true;
}

/** Only run a frame callback while something is actually playing. */
function syncTicker() {
  const wanted = player.state.playing;
  if (wanted && !stopTick) { lastFlush = performance.now(); stopTick = tick(frame); }
  else if (!wanted && stopTick) { stopTick(); stopTick = null; bank(); flush(); }
}

export async function init() {
  const [stored, storedDays] = await Promise.all([
    db.getKV(KEY).catch(() => null),
    db.getKV(DAYS_KEY).catch(() => null),
  ]);
  if (stored && typeof stored === 'object') {
    totals = new Map(Object.entries(stored).filter(([, v]) => typeof v === 'number' && v > 0));
  }
  if (storedDays && typeof storedDays === 'object') {
    for (const [day, bucket] of Object.entries(storedDays)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !bucket || typeof bucket !== 'object') continue;
      const m = new Map();
      for (const [id, v] of Object.entries(bucket)) {
        if (typeof v === 'number' && v > 0) m.set(id, v);
      }
      if (m.size) days.set(day, m);
    }
    prune();
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

/* ------------------------------------------------------------------ periods
 *
 * A window over the day log. `from` and `to` are day keys, inclusive; leaving
 * both out means all time, which is what every caller wanted before there was
 * a log to ask.
 */

/** Seconds per track over a window, as a Map. */
export function tracksBetween(from, to) {
  const out = new Map();
  for (const [day, bucket] of days) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    for (const [id, secs] of bucket) out.set(id, (out.get(id) || 0) + secs);
  }
  /* What is playing right now has not been banked yet, and a window that ends
     today should include it — otherwise "this week" is missing the record you
     are looking at while you read it. */
  if (currentId && credit >= MIN_CREDIT) {
    const today = dayKey();
    if ((!from || today >= from) && (!to || today <= to)) {
      out.set(currentId, (out.get(currentId) || 0) + credit);
    }
  }
  return out;
}

/** Seconds listened per day over a window, oldest first. */
export function byDay(from, to) {
  const out = [];
  for (const [day, bucket] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    let sum = 0;
    for (const secs of bucket.values()) sum += secs;
    out.push({ day, seconds: sum, tracks: bucket.size });
  }
  return out;
}

/** The first day anything was recorded, or null while the log is empty. */
export function firstDay() {
  let first = null;
  for (const day of days.keys()) if (!first || day < first) first = day;
  return first;
}

export const dayCount = () => days.size;

/** `n` days back from today, as a day key — for the period presets. */
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d.getTime());
}

/**
 * A3: listening by weekday and by hour of the day.
 *
 * Weekday comes out of the day key directly. There is no hour in the log and
 * deliberately so — see the note on `days` — so this reports the shape of a
 * week, which is the pattern people actually recognise in themselves.
 */
export function byWeekday(from, to) {
  const out = Array.from({ length: 7 }, (_, i) => ({ day: i, seconds: 0, days: 0 }));
  for (const [day, bucket] of days) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    const [y, m, d] = day.split('-').map(Number);
    const w = new Date(y, m - 1, d).getDay();
    let sum = 0;
    for (const secs of bucket.values()) sum += secs;
    out[w].seconds += sum;
    out[w].days++;
  }
  return out;
}

/**
 * Rolls listening time up by artist, genre or year.
 *
 * Returns `[{ key, label, seconds, plays, share }]`, largest first. Tracks the
 * library no longer holds are skipped rather than counted under a blank label:
 * a slice you cannot click into is worse than no slice.
 *
 * A window narrows it to a period. Without one it reads the all-time totals,
 * which is both what it always did and the only thing that can answer for
 * listening from before the day log existed.
 */
export function byMode(mode = 'artist', { limit = 60, from = null, to = null } = {}) {
  const buckets = new Map();
  const add = (key, label, seconds) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { key, label, seconds: 0, plays: 0, share: 0 });
    b.seconds += seconds;
    b.plays++;
  };

  const windowed = from || to ? tracksBetween(from, to) : null;
  const ids = new Set(windowed ? windowed.keys() : totals.keys());
  if (!windowed && currentId) ids.add(currentId);

  for (const id of ids) {
    const seconds = windowed ? windowed.get(id) : forTrack(id);
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
  days = new Map();
  credit = 0;
  dirty = false;
  daysDirty = false;
  await Promise.all([
    db.setKV(KEY, {}).catch(() => {}),
    db.setKV(DAYS_KEY, {}).catch(() => {}),
  ]);
  events.emit('change');
}

/**
 * A5: the whole log, as rows.
 *
 * The backup carries this as an opaque blob, which is the right shape for
 * putting it back and the wrong shape for anything else. A date, a track and a
 * number of seconds is what a spreadsheet, a scrobbler or a graph nobody has
 * thought of yet can actually read — and it is the same argument the M3U
 * export won.
 */
export function asRows() {
  const rows = [];
  for (const [day, bucket] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const [id, secs] of bucket) {
      const t = lib.getTrack(id);
      rows.push({
        day,
        seconds: Math.round(secs),
        // The names as they are now, not as they were: a correction made last
        // month should show in a log exported today.
        title: t ? t.title : '',
        artist: t ? t.artist : '',
        album: t ? t.album : '',
        id,
      });
    }
  }
  return rows;
}
