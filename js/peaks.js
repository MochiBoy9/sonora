/* peaks.js — the waveform and the spectrogram, computed once per track.
 *
 * One analysis unlocks three things that used to be impossible: a scrubber you
 * can read before you drag it, a spectrogram strip that shows the shape of the
 * whole song rather than the last 20 ms of it, and a loudness figure that lets
 * the rack even out the jump between a 1974 master and a 2011 remaster.
 *
 * When it runs matters as much as what it does. Decoding every file at import
 * would turn a four-thousand-file library into an afternoon, for data that
 * most of those files will never need — so nothing is computed until a track
 * is actually played, and then it is computed once and kept for good. By the
 * time you reach for the scrubber it is already there; the first eight seconds
 * of a song are enough to analyse the whole of it.
 *
 * Nothing here is on the critical path. If the decode fails, is unsupported,
 * or is simply never asked for, every caller gets `null` and draws the plain
 * version it drew before.
 */

import * as db from './db.js';
import * as lib from './library.js';
import { Emitter, idle } from './util.js';

export const events = new Emitter();

/** id -> record | null (a null means "looked, found nothing, stop asking"). */
const memo = new Map();
/** id -> promise, so two callers asking at once share one decode. */
const inflight = new Map();

/* A track long enough to be a DJ set is not worth eight seconds of decode to
   draw a scrubber for, and the resampled buffer for one would be a hundred
   megabytes of Float32 on the main thread before the transfer. */
const MAX_SECONDS = 20 * 60;
/* Keeping every track ever played would grow without limit. 4000 records at
   ~28 KB is a little over a hundred megabytes, which is the point where this
   stops being a cache and starts being a liability. */
const KEEP = 4000;

let worker = null;
let ready = false;
let decodeCtx = null;
/* One at a time, always. Two concurrent decodes double the peak memory for no
   gain — the decoder is one resource and they would queue inside it anyway. */
let busy = false;
const waiting = [];

/* ------------------------------------------------------------------ plumbing */

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./peaks.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[sonora] peaks worker unavailable', err);
    worker = null;
    return null;
  }
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') { ready = true; return; }
    if (msg.type === 'peaks') {
      const rec = msg.rec;
      memo.set(rec.id, rec);
      db.putPeaks(rec).catch(() => {});
      events.emit('peaks', rec.id, rec);
      resolveWaiters(rec.id, rec);
    } else if (msg.type === 'error') {
      memo.set(msg.id, null);
      resolveWaiters(msg.id, null);
    }
    next();
  };
  worker.onerror = () => { /* the callers already handle null */ };
  return worker;
}

/** A context that exists only to decode. Never connected to anything. */
function ensureCtx() {
  if (decodeCtx) return decodeCtx;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  /* 44.1 kHz on purpose rather than the device rate. `decodeAudioData`
     resamples into the context, so fixing it here means the spectrogram's
     frequency axis means the same thing on every machine — and a 48 kHz file
     analysed at 44.1 loses nothing that survives being folded into 48 bands. */
  try { decodeCtx = new OAC(1, 1, 44100); } catch { decodeCtx = null; }
  return decodeCtx;
}

/* id -> [{ fn, want }].
 *
 * Keyed by id because that is all the worker echoes back, but each waiter
 * remembers what it asked for. A caller that wanted the spectrogram is not
 * satisfied by a wave-only result that happened to land first — it stays
 * pending for its own job rather than being resolved with the wrong shape. */
const resolvers = new Map();

/** Does this record answer a request for `want`? */
const satisfies = (rec, want) => !rec || want === 'wave' || !!rec.spec;

function resolveWaiters(id, value) {
  const list = resolvers.get(id);
  if (!list) return;
  const keep = [];
  for (const w of list) {
    if (satisfies(value, w.want)) w.fn(value);
    else keep.push(w);
  }
  if (keep.length) resolvers.set(id, keep); else resolvers.delete(id);
}

function next() {
  busy = false;
  const job = waiting.shift();
  if (job) run(job);
}

/* ------------------------------------------------------------------ analyse */

async function run(job) {
  const { track, want } = job;
  busy = true;

  const ctx = ensureCtx();
  const w = ensureWorker();
  if (!ctx || !w) { memo.set(track.id, null); resolveWaiters(track.id, null); return next(); }

  let buf = null;
  try {
    const file = await lib.fileFor(track.id);
    if (!file) throw new Error('file unavailable');
    const bytes = await file.arrayBuffer();
    /* The promise form rather than the callback form: the callback overload is
       the 2011 one and does not reject, it just never calls back on some
       failures. */
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    memo.set(track.id, null);
    resolveWaiters(track.id, null);
    return next();
  }

  if (buf.duration > MAX_SECONDS) {
    memo.set(track.id, null);
    resolveWaiters(track.id, null);
    return next();
  }

  /* Transferred, not copied. `getChannelData` hands back a live view of the
     buffer's own memory, so it is sliced first — transferring the buffer out
     from under an AudioBuffer that the decoder still owns is not ours to do. */
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    channels.push(buf.getChannelData(c).slice().buffer);
  }
  w.postMessage(
    { id: track.id, channels, frames: buf.length, sampleRate: buf.sampleRate, want },
    channels,
  );
}

/* ------------------------------------------------------------------ api */

/**
 * The analysis for one track, from memory, then the database, then the file.
 *
 * `want` may be 'wave' to skip the spectrogram, which is most of the work —
 * the scrubber asks for that, and the immersive view asks for everything.
 */
export function forTrack(track, want = 'all') {
  if (!track) return Promise.resolve(null);
  const id = track.id;

  if (memo.has(id)) {
    const hit = memo.get(id);
    // A cached wave-only record does not answer a later request for the spectrogram.
    if (satisfies(hit, want)) return Promise.resolve(hit);
  }
  /* Keyed by what was asked for as well as by which track. Sharing on the id
     alone hands a caller that wanted the spectrogram the wave-only promise
     somebody else started, and it resolves without one. */
  const key = id + '|' + want;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const stored = await db.getPeaks(id).catch(() => null);
    if (stored && stored.v === 1 && satisfies(stored, want)) {
      memo.set(id, stored);
      return stored;
    }

    return new Promise((resolve) => {
      const list = resolvers.get(id) || [];
      list.push({ fn: resolve, want });
      resolvers.set(id, list);
      const job = { track, want };
      if (busy) waiting.push(job); else run(job);
    });
  })();

  inflight.set(key, p);
  /* Cleared however it ends. The early returns above never reach the worker,
     so leaving this to `resolveWaiters` would strand the entry and every
     later request for the same thing would get this same settled promise. */
  p.then(() => { if (inflight.get(key) === p) inflight.delete(key); },
         () => { if (inflight.get(key) === p) inflight.delete(key); });
  return p;
}

/** What is known already, without decoding anything. */
export function peek(track) {
  const hit = track && memo.get(track.id);
  return hit || null;
}

/**
 * Warms a track's analysis when the machine is not busy.
 *
 * Called when a track starts playing. Deliberately fire-and-forget: nothing
 * waits on it, and the only observable effect is that the scrubber has a
 * waveform in it by the time anybody looks.
 */
export function warm(track, want = 'wave') {
  if (!track || memo.has(track.id)) return;
  idle(() => { forTrack(track, want).catch(() => {}); }, 1200);
}

/**
 * Peak amplitude of the whole track, 0..1, for drawing a normalised waveform.
 * A quiet track drawn against absolute full scale is a flat line.
 */
export function amplitude(rec) {
  if (!rec) return 1;
  let peak = 0;
  for (let i = 0; i < rec.max.length; i++) {
    const a = rec.max[i], b = -rec.min[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return peak > 0 ? peak / 127 : 1;
}

/** Drops the oldest records once the store outgrows its welcome. */
export async function trim() {
  try {
    const count = await db.peaksCount();
    if (count <= KEEP) return 0;
    const keys = await db.peaksKeys();
    // Keys come back in insertion-ish order; the stamp is the honest sort.
    const recs = await Promise.all(keys.map((k) => db.getPeaks(k).catch(() => null)));
    const sorted = recs.filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0));
    const drop = sorted.slice(0, sorted.length - KEEP).map((r) => r.id);
    if (!drop.length) return 0;
    await db.deletePeaks(drop);
    for (const id of drop) memo.delete(id);
    return drop.length;
  } catch { return 0; }
}

/** Forgets one track, or all of them. Used when the library is wiped. */
export function forget(id) {
  if (id) { memo.delete(id); db.deletePeaks([id]).catch(() => {}); }
  else { memo.clear(); db.clearPeaks().catch(() => {}); }
}
