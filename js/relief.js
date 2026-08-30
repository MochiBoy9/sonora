/* relief.js — giving the printed cover somewhere to catch the light.
 *
 * The sleeve already reads as an object: it has form shading, a moving
 * specular and a rim that answers the artwork's own luminance. The picture
 * printed on it does not. Turn the record and the light sweeps across the
 * artwork as though it were behind glass, because as far as the renderer is
 * concerned it is — the cover is a decal on a lit plane.
 *
 * This lights the print itself. The worker produced a surface normal per pixel
 * at import (see `surfaceOf` in metadata.worker.js); here that surface is
 * relit from wherever the light currently is, which is the same `--tx`/`--ty`
 * the pointer and the accelerometer already write.
 *
 * Three things keep it cheap enough to do on the main thread:
 *
 *   - it is 64x64, always. This is lighting, not detail: a lambert term over
 *     four thousand pixels is a fraction of a millisecond, and CSS scales the
 *     result up over the artwork for free.
 *   - it only runs while something is actually being pointed at, and there is
 *     only ever one such thing.
 *   - it does not run at all for covers the surface pass measured as too soft
 *     to be worth it. A photograph of a face is nearly all gradient, and
 *     lighting one as though it were embossed looks like a mistake.
 */

import * as lib from './library.js';
import { reduceMotion } from './motion.js';

/* Below this much edge energy a cover is a photograph rather than a print, and
   relief on it reads as a rendering error rather than as a surface. Tuned
   against real covers: type and hard-edged graphics sit well above it, faces
   and soft photography well below. */
const MIN_DENSITY = 0.012;

/** One canvas, reused. There is only ever one thing under the pointer. */
let canvas = null;
let ctx = null;
let image = null;

function ensureCanvas(size) {
  if (canvas && canvas.width === size) return true;
  try {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.className = 'art-relief';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    image = ctx.createImageData(size, size);
    return !!ctx;
  } catch {
    canvas = null; ctx = null; image = null;
    return false;
  }
}

/**
 * Lights one surface from a direction and writes it into the canvas.
 *
 * `lx`/`ly` are -1..1, the same numbers `--tx`/`--ty` carry. The light sits
 * slightly in front of the surface (a positive z) so that a flat area is lit
 * evenly and only the slopes pick up a difference — with the light in the
 * plane, half of every cover would go black.
 */
function relight(rec, lx, ly) {
  const n = rec.size;
  const map = rec.map;
  const px = image.data;

  // Normalised light vector. z is generous: this is a sheet of card catching a
  // room, not a torch held against it.
  const lz = 0.85;
  const len = Math.hypot(lx, ly, lz) || 1;
  const ux = lx / len, uy = ly / len, uz = lz / len;

  for (let i = 0, o = 0; i < n * n; i++, o += 4) {
    // The stored normal, back out of two signed bytes.
    const nx = map[i * 2] / 127;
    const ny = map[i * 2 + 1] / 127;
    // z from the slope: a steep edge tilts away, a flat field faces straight out.
    const nz = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const dot = (nx * nz) * ux + (ny * nz) * uy + nz * uz;

    /* Centred on zero rather than clamped at it. What is being drawn is the
       *difference* the surface makes, which is then composited as a soft
       light: a slope facing the light goes bright, one facing away goes dark,
       and a flat field goes to nothing at all and leaves the artwork alone. */
    const shade = (dot - uz) * 2.6;
    const v = Math.max(-1, Math.min(1, shade));
    const lit = v > 0 ? 255 : 0;
    px[o] = lit; px[o + 1] = lit; px[o + 2] = lit;
    px[o + 3] = Math.round(Math.abs(v) * 190);
  }
  ctx.putImageData(image, 0, 0);
}

/* ------------------------------------------------------------------ mount
 *
 * One controller for the whole page, not one per sleeve.
 *
 * The obvious shape is a listener per artwork box, and it is the wrong one
 * here: the grids are virtualised, so cards are recycled continuously, and
 * anything attached per card either has to be torn down on every recycle or
 * leaks a listener each time a row scrolls past. Delegating from the document
 * costs three listeners for the entire application and cannot leak, because
 * there is nothing per-element to forget.
 *
 * The light direction is computed from the pointer against the box rather than
 * read off `--tx`/`--ty`. Those two are written by `tilt3d`, which is not on
 * every artwork on the page — taking the pointer directly means relief works
 * wherever a cover is, and cannot disagree with the sleeve about where the
 * light is, because both are deriving it from the same pointer.
 */

let host = null;                  // the box currently being lit
let hostKey = '';
let raf = 0;
let lightX = 0, lightY = 0;
let started = false;

function keyOf(box) {
  const img = box.querySelector('.art-img');
  return (img && img.dataset.key) || '';
}

function recordFor(key) {
  const r = lib.reliefFor(key);
  return r && r.density >= MIN_DENSITY ? r : null;
}

function draw() {
  raf = 0;
  if (!host) return;
  const r = recordFor(hostKey);
  if (!r || !ensureCanvas(r.size)) return;
  relight(r, lightX, lightY);
  if (canvas.parentNode !== host) host.appendChild(canvas);
}

function detach() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  host = null;
  hostKey = '';
}

function onOver(e) {
  const box = e.target.closest && e.target.closest('.art-3d');
  if (!box) { if (host) detach(); return; }
  if (box === host) return;
  detach();
  const key = keyOf(box);
  if (!key) return;
  host = box;
  hostKey = key;
  if (!lib.reliefFor(key)) {
    // Not in memory yet: fetch it and light it when it lands, if still hovered.
    lib.loadRelief(key).then(() => { if (host === box && !raf) raf = requestAnimationFrame(draw); });
  }
}

function onMove(e) {
  if (!host) return;
  const box = host.getBoundingClientRect();
  if (!box.width) return;
  lightX = ((e.clientX - box.left) / box.width - 0.5) * 2;
  lightY = ((e.clientY - box.top) / box.height - 0.5) * 2;
  if (!raf) raf = requestAnimationFrame(draw);
}

function onOut(e) {
  if (!host) return;
  // `pointerout` fires when moving between children of the same box too.
  if (e.relatedTarget && host.contains(e.relatedTarget)) return;
  detach();
}

/** Starts the one controller. Idempotent. */
export function startRelief() {
  if (started || reduceMotion.matches) return;
  started = true;
  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  // A pointer that leaves the window entirely never reports `pointerout` on
  // the element it was over.
  window.addEventListener('blur', detach);
}

export function stopRelief() {
  if (!started) return;
  started = false;
  document.removeEventListener('pointerover', onOver);
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerout', onOut);
  window.removeEventListener('blur', detach);
  detach();
}

/** For the tests: what the surface would look like lit from one direction. */
export function __relightTo(rec, lx, ly) {
  if (!ensureCanvas(rec.size)) return null;
  relight(rec, lx, ly);
  return ctx.getImageData(0, 0, rec.size, rec.size);
}
