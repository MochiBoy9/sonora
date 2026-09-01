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

/* -------------------------------------------------------------- displacement
 *
 * Relighting alone still draws a flat thing. Turn the sleeve and the shading
 * moves, but nothing on the cover moves *against* anything else — and that
 * relative motion is most of what tells an eye that a surface has depth.
 *
 * So the proud parts of the print are lifted onto their own layer and shifted
 * as the sleeve turns. Ink sits above card: outlines, type and the edges of
 * blocks stand up, flat fields stay down, and turning the record slides one
 * across the other.
 *
 *
 * Which parts are proud
 *
 * The stored surface is a Sobel of the cover's luminance — the worker is
 * explicit that what it measures is where the *edges* are, not how tall
 * anything is. Read as height that is exactly right for print: ink is proud
 * at its boundaries. So height is the gradient magnitude, blurred twice,
 * because ink has thickness and a one-pixel ridge parallaxes as a shimmer
 * rather than as a surface.
 *
 * Reading it as luminance instead — bright is high — would have been the
 * other obvious choice and it is wrong: it would float every pale area of
 * every cover regardless of what is printed there.
 *
 *
 * Which way it moves
 *
 * tilt3d sets rotateY from the pointer's x offset, positive to the right. A
 * positive rotateY sends the right edge away from the viewer, which turns the
 * surface normal toward the pointer; a point standing h above that surface
 * projects to x·cosθ + h·sinθ, so it shifts *toward* the pointer. rotateX
 * carries the opposite sign in tilt3d and the second minus cancels, so both
 * axes come out the same: the proud layer moves toward the pointer, by an
 * amount proportional to how far the pointer is from the middle.
 */

/** Displacement in px at the artwork's own scale, at full lean. */
const MAX_SHIFT = 2.4;

/* Where the shift stops growing, as a fraction of the box half-width.
 *
 * A rendering limit, not a physical one — real parallax keeps growing with
 * the tangent of the angle. Past about seven tenths of the way to the edge
 * the shifted layer starts pulling away from the artwork's own border and
 * the seam shows, so it is held there. The sleeve's rotation is still ramping
 * at that point, which is the useful part: the clamp is reached before the
 * tilt is, so the displacement never arrives at its limit in the same instant
 * as everything else. */
const SHIFT_FULL = 0.7;

/** albumKey -> mask canvas of the proud parts. Cheap to reuse at any size. */
const masks = new Map();
const MASK_CACHE = 12;

/**
 * Height from the stored normals: gradient magnitude, blurred, normalised.
 *
 * Cached onto the record, which is the same object `lib.reliefFor` hands back
 * every time, so this runs once per cover per session.
 */
function heightOf(rec) {
  if (rec.height) return rec.height;
  const n = rec.size, map = rec.map;
  const a = new Float32Array(n * n);
  let peak = 0;
  for (let i = 0; i < n * n; i++) {
    const gx = map[i * 2] / 127, gy = map[i * 2 + 1] / 127;
    const m = Math.sqrt(gx * gx + gy * gy);
    a[i] = m;
    if (m > peak) peak = m;
  }
  if (peak > 0) for (let i = 0; i < a.length; i++) a[i] /= peak;

  // Two separable 1-2-1 passes. Cheap, and enough to turn a ridge into a lip.
  const b = new Float32Array(n * n);
  const at = (src, x, y) => src[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) b[y * n + x] = (at(a, x - 1, y) + 2 * at(a, x, y) + at(a, x + 1, y)) / 4;
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) a[y * n + x] = (at(b, x, y - 1) + 2 * at(b, x, y) + at(b, x, y + 1)) / 4;
    }
  }
  rec.height = a;
  return a;
}

/** An alpha mask of the proud parts, at the surface's own resolution. */
function maskFor(key, rec) {
  const hit = masks.get(key);
  if (hit) return hit;
  const n = rec.size;
  const h = heightOf(rec);
  let c;
  try {
    c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d');
    const img = g.createImageData(n, n);
    for (let i = 0, o = 0; i < n * n; i++, o += 4) {
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      /* Curved rather than linear. The blur above leaves a low haze over the
         whole cover, and lifting all of it would shift the entire picture —
         which is a picture sliding about, not a surface. Squaring holds the
         flat fields down and keeps the lip. */
      img.data[o + 3] = Math.round(h[i] * h[i] * 255);
    }
    g.putImageData(img, 0, 0);
  } catch { return null; }
  masks.set(key, c);
  if (masks.size > MASK_CACHE) masks.delete(masks.keys().next().value);
  return c;
}

/**
 * Builds the proud layer for the cover in `box`: its own pixels, kept only
 * where the print stands up.
 *
 * Built once on hover and moved with a transform after that, so there is no
 * per-frame pixel work at all — the whole cost of this is one drawImage and
 * one composite when the pointer arrives.
 */
function buildProud(box, key, rec) {
  const img = box.querySelector('.art-img');
  if (!img || !img.naturalWidth) return null;         // no cover to lift
  const mask = maskFor(key, rec);
  if (!mask) return null;
  /* Capped: past this the layer costs more to build than the effect is worth,
     and a cover is never drawn much larger than this anyway. */
  const size = Math.min(320, Math.round(box.clientWidth || 232)) || 232;
  try {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    c.className = 'art-proud';
    c.setAttribute('aria-hidden', 'true');
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0, size, size);
    return c;
  } catch {
    // A cover that cannot be read back is a cover that stays flat.
    return null;
  }
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
let proud = null;                 // the displaced layer over the current host
let proudGain = 1;                // the Look's parallax setting, read on arrival

function keyOf(box) {
  const img = box.querySelector('.art-img');
  return (img && img.dataset.key) || '';
}

function recordFor(key) {
  const r = lib.reliefFor(key);
  return r && r.density >= MIN_DENSITY ? r : null;
}

/** How far the proud layer has slid, in px. Clamped; see SHIFT_FULL. */
function shiftOf(v) {
  const t = Math.max(-1, Math.min(1, v / SHIFT_FULL));
  return t * MAX_SHIFT * proudGain;
}

function draw() {
  raf = 0;
  if (!host) return;
  const r = recordFor(hostKey);
  if (!r || !ensureCanvas(r.size)) return;
  relight(r, lightX, lightY);

  /* Built on the first frame rather than on pointerover: the artwork may still
     have been decoding when the pointer arrived, and a layer built from an
     <img> with no pixels in it is a blank sheet laid over the cover. */
  if (!proud && proudGain > 0) {
    proud = buildProud(host, hostKey, r);
    /* Under the lighting, explicitly rather than by append order: the artwork
       may still have been decoding on the first frame, in which case the
       relief canvas is already in place by the time this succeeds and an
       append would put the print on top of the light meant to fall on it. */
    if (proud) host.insertBefore(proud, canvas.parentNode === host ? canvas : null);
  }
  if (proud) {
    proud.style.transform =
      `translate3d(${shiftOf(lightX).toFixed(2)}px, ${shiftOf(lightY).toFixed(2)}px, 0)`;
  }
  if (canvas.parentNode !== host) host.appendChild(canvas);
}

function detach() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  if (proud && proud.parentNode) proud.parentNode.removeChild(proud);
  proud = null;
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
  /* The same two settings tilt3d reads, and read at the same moment for the
     same reason: a Look that has turned parallax down is not tilting the
     sleeve, and a layer that slides over a sleeve which is not turning is a
     picture coming loose. Read once per hover — this is a computed-style
     lookup, not something to do per move. */
  const root = document.documentElement;
  const p = parseFloat(getComputedStyle(root).getPropertyValue('--parallax'));
  const calm = root.getAttribute('data-motion');
  proudGain = (isFinite(p) ? p : 1) * (calm === 'none' ? 0 : calm === 'calm' ? 0.45 : 1);
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
