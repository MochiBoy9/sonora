/* metadata.worker.js — the whole import pipeline, off the main thread.
 *
 * Per file: parse tags, decode the embedded cover once per album, re-encode it
 * to a small WebP, and pull an accent colour out of it. The UI thread never
 * decodes an image during import, which is what keeps scrolling smooth while a
 * few thousand files are still being read.
 */

import { readTags } from './tags.js';
import { albumKeyOf } from './util.js';

const THUMB = 448;              // long edge of the stored cover, in px
const PARALLEL = 4;             // concurrent file reads
const FLUSH_MS = 90;            // how often partial results are posted back

const seenAlbums = new Set();   // album keys whose art we've already encoded

let outbox = [];
let flushTimer = null;

function post(force) {
  if (!outbox.length && !force) return;
  const batch = outbox;
  outbox = [];
  clearTimeout(flushTimer);
  flushTimer = null;
  self.postMessage({ type: 'tracks', tracks: batch });
}

function queue(track) {
  outbox.push(track);
  if (outbox.length >= 48) post();
  else if (!flushTimer) flushTimer = setTimeout(post, FLUSH_MS);
}

/* ------------------------------------------------------------------ artwork */

const canEncode = typeof OffscreenCanvas !== 'undefined' &&
                  typeof createImageBitmap === 'function';

/** Decode → downscale → WebP, plus the accent colour, in one pass. */
async function makeThumb(blob) {
  if (!canEncode) return null;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch { return null; }

  const scale = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  ctx.drawImage(bmp, 0, 0, w, h);

  // Sample a tiny copy for the accent colour — 24x24 is plenty and costs nothing.
  let accent = null;
  try {
    const s = new OffscreenCanvas(24, 24);
    const sctx = s.getContext('2d', { alpha: false, willReadFrequently: true });
    sctx.drawImage(bmp, 0, 0, 24, 24);
    accent = vibrant(sctx.getImageData(0, 0, 24, 24).data);
  } catch { /* colour is a nicety */ }

  bmp.close?.();

  let out = null;
  try {
    out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    if (!out || out.type !== 'image/webp') {
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    }
  } catch {
    try { out = await canvas.convertToBlob(); } catch { out = null; }
  }
  return out ? { blob: out, accent } : null;
}

/**
 * Picks a colour that reads as "this album" — saturated, mid-lightness, and
 * common enough in the image to feel deliberate. Falls back to the average.
 */
function vibrant(data) {
  const buckets = new Map();
  let ar = 0, ag = 0, ab = 0, n = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    ar += r; ag += g; ab += b; n++;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 510;                       // 0..1
    const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (l < 0.16 || l > 0.92 || sat < 0.18) continue;  // skip near-black/white/grey

    // Quantise to a 5-bit-per-channel grid so similar pixels land together.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = buckets.get(key);
    const weight = sat * (1 - Math.abs(l - 0.55));     // prefer vivid mid-tones
    if (hit) { hit.n++; hit.w += weight; }
    else buckets.set(key, { r, g, b, n: 1, w: weight });
  }

  let best = null;
  for (const v of buckets.values()) {
    const score = v.w * Math.sqrt(v.n);
    if (!best || score > best.score) best = { score, rgb: [v.r, v.g, v.b] };
  }
  if (best) return best.rgb;
  return n ? [Math.round(ar / n), Math.round(ag / n), Math.round(ab / n)] : null;
}

/* ------------------------------------------------------------------ import */

async function handle(job) {
  const { id, path, name, size, mtime, rootId, albumHintKey } = job;
  const file = job.file;
  let tags = {};
  try {
    tags = await readTags(file, path, name);
  } catch {
    tags = { title: name };
  }

  const track = {
    id, path, name, size, mtime, rootId,
    title: tags.title || name,
    artist: tags.artist || '',
    albumArtist: tags.albumArtist || '',
    album: tags.album || '',
    track: parseNum(tags.track),
    disc: parseNum(tags.disc) || 1,
    year: parseYear(tags.year),
    genre: tags.genre || '',
    duration: tags.duration && isFinite(tags.duration) ? Math.round(tags.duration * 10) / 10 : 0,
    addedAt: Date.now(),
  };

  // The album key groups tracks; art is stored once per key.
  track.albumKey = albumHintKey || albumKeyOf(track.albumArtist || track.artist || '', track.album);

  let art = null;
  if (tags.picture && !seenAlbums.has(track.albumKey)) {
    seenAlbums.add(track.albumKey);
    const thumb = await makeThumb(tags.picture);
    if (thumb) {
      art = { key: track.albumKey, blob: thumb.blob, accent: thumb.accent };
      track.accent = thumb.accent;
    }
  }
  queue({ track, art });
}

const parseNum = (v) => {
  if (!v) return 0;
  const n = parseInt(String(v).split('/')[0], 10);
  return isFinite(n) && n > 0 ? n : 0;
};

const parseYear = (v) => {
  if (!v) return 0;
  const m = String(v).match(/\d{4}/);
  return m ? parseInt(m[0], 10) : 0;
};

/* ------------------------------------------------------------------ pump */

const pending = [];
let active = 0;
let total = 0, done = 0;
let draining = false;

function pump() {
  while (active < PARALLEL && pending.length) {
    active++;
    handle(pending.shift())
      .catch(() => {})
      .finally(() => {
        active--;
        done++;
        if ((done & 15) === 0) self.postMessage({ type: 'progress', done, total });
        pump();
      });
  }
  if (draining && !active && !pending.length) {
    draining = false;
    post(true);
    self.postMessage({ type: 'done', done, total });
    done = 0; total = 0;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'scan') {
    total += msg.jobs.length;
    for (const job of msg.jobs) pending.push(job);
    draining = true;
    self.postMessage({ type: 'progress', done, total });
    pump();
  } else if (msg.type === 'reset') {
    seenAlbums.clear();
    pending.length = 0;
    done = 0; total = 0;
  } else if (msg.type === 'knownAlbums') {
    for (const k of msg.keys) seenAlbums.add(k);
  }
};

self.postMessage({ type: 'ready' });
