/* visualizer.js — the analyser, drawn.
 *
 * Four renderers over one shared reading of the spectrum (player.analysis()),
 * so however many visualisers are on screen the FFT is still only banded once
 * per frame. Everything is drawn with straight edges and hairlines — square
 * bars, polylines rather than curves, tick marks instead of glows — because
 * the rest of the interface is drawn that way too.
 *
 *   bars    columns on a log-frequency scale, with peak caps that fall
 *   wave    the oscilloscope: the actual waveform over a centre axis
 *   radial  the same bands as spokes around a ticked ring
 *   mesh    a spectrogram in perspective — the last few seconds of sound,
 *           receding toward a horizon
 *
 * The drawing itself lives in visualizer-draw.js, because it runs in two
 * places: here on the main thread, or inside a worker against an
 * OffscreenCanvas. This file owns everything that cannot leave the main thread
 * — the element, the ResizeObserver, the CSS custom properties, and the
 * AudioContext's analyser — and hands the rest over.
 *
 * The worker is used where the platform has it and declined everywhere else,
 * and the fallback is not a lesser path: it is the same renderer against the
 * same context, one function call closer.
 *
 * Nothing here touches the DOM after setup, and nothing allocates per frame
 * except the transfer buffers, which come from a small pool.
 */

import { tick, reduceMotion } from './motion.js';
import * as player from './player.js';
import { createRenderer } from './visualizer-draw.js';

export const MODES = [
  { id: 'bars', label: 'Bars' },
  { id: 'wave', label: 'Wave' },
  { id: 'radial', label: 'Radial' },
  { id: 'mesh', label: 'Mesh' },
];

export const isMode = (id) => MODES.some((m) => m.id === id);

const DEFAULT_ACCENT = [0, 209, 255];

/* ------------------------------------------------------------------ colour */

/** Reading a custom property costs a style resolve, so callers do it a few
 *  times a second, never per frame. */
function readVar(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,/]+/).map(Number).filter((n) => isFinite(n));
  return parts.length >= 3 ? parts.slice(0, 3) : fallback;
}

/* ------------------------------------------------------------------ offload */

/**
 * Can this canvas be handed to a worker?
 *
 * Every one of these has to hold, and the last is the one that is easy to
 * forget: `transferControlToOffscreen` is one-way. Once a canvas has been
 * transferred it can never be drawn to from this thread again, so a canvas
 * that might need the main-thread path later must not be offered at all.
 * Since the decision is made once at construction and never revisited, that
 * is safe here.
 */
const canOffload = () =>
  typeof OffscreenCanvas === 'function' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function' &&
  typeof Worker === 'function';

/* ------------------------------------------------------------------ mount */

/**
 * @param canvas            the target <canvas>
 * @param mode              one of MODES
 * @param visible()         cheap predicate: is this canvas worth drawing?
 * @param intensity         0..1 overall opacity multiplier
 * @param bars              how many columns the bar modes draw
 * @param band              fraction of the canvas height the bars may fill
 * @param idleShimmer       breathe gently instead of flatlining when paused
 * @param chrome            draw the baseline rule and tick marks
 * @param offload           allow the worker path (default true)
 */
export function createVisualizer(canvas, {
  mode = 'bars', visible = () => true, intensity = 1, bars = 56, band = 0.94,
  idleShimmer = true, chrome = true, offload = true,
} = {}) {
  const opts = { mode, intensity, bars, band, idleShimmer, chrome };

  let w = 0, h = 0, dpr = 1;
  let accent = DEFAULT_ACCENT;
  let art = DEFAULT_ACCENT;
  let accentAt = 0, sizeAt = 0;
  let restFrames = 0;
  let stillKey = '';
  let focusX = 0.5, focusY = 0.5;

  /* One of these two ends up driving the drawing. `worker` is preferred where
     the platform allows it; `renderer` is the direct path. Exactly one is
     ever non-null. */
  let worker = null;
  let renderer = null;
  let ctx = null;

  if (offload && canOffload()) {
    try {
      const off = canvas.transferControlToOffscreen();
      worker = new Worker(new URL('./visualizer.worker.js', import.meta.url), { type: 'module' });
      worker.onerror = () => { /* the canvas is already gone; nothing to fall back to */ };
      worker.postMessage({ type: 'init', canvas: off, opts, dpr: 1, bandCount: 64 }, [off]);
    } catch {
      // The transfer failed before it took effect, so the canvas is still ours.
      worker = null;
    }
  }

  if (!worker) {
    ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return { canvas, get mode() { return mode; }, setMode() {}, setFocus() {}, kick() {}, destroy() {} };
    renderer = createRenderer(ctx, opts);
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const nw = Math.round(rect.width * dpr);
    const nh = Math.round(rect.height * dpr);
    if (nw === w && nh === h) return true;
    w = nw; h = nh;
    if (worker) {
      // The element's own width/height are the worker's to set now.
      worker.postMessage({ type: 'size', w, h, dpr });
    } else {
      canvas.width = w;
      canvas.height = h;
      renderer.setSize(w, h, dpr);
    }
    return true;
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  /* Two scratch buffers, filled and sent by copy.
   *
   * These used to be transferred, out of a pool of three, on the reasoning
   * that by the time the third was in flight the first would be back. It never
   * was: a transferred ArrayBuffer is detached at the sender and only returns
   * if the receiver sends it back, which this worker does not. So every slot
   * was detached after three frames and the code fell into its own
   * reallocation branch — allocating a fresh Float32Array and Uint8Array every
   * frame, which is exactly the per-frame garbage the pool existed to avoid.
   *
   * Structured-cloning them instead is about 1.5 KB of memcpy per frame, well
   * under a microsecond, and it keeps these two alive for the life of the
   * visualiser. The alternative — posting the buffers back each frame — trades
   * a memcpy for a second message in the other direction, which is the more
   * expensive half of the two. */
  const packed = worker ? new Float32Array(128) : null;
  const wave = worker ? new Uint8Array(1024) : null;

  function sendFrame(a, dt, now) {
    const n = Math.min(64, a.bands.length);
    packed.set(a.bands.subarray(0, n), 0);
    packed.set(a.peaks.subarray(0, n), 64);

    let waveOut = null;
    if (a.wave) {
      wave.set(a.wave.subarray(0, Math.min(wave.length, a.wave.length)));
      waveOut = wave;
    }

    worker.postMessage({
      type: 'frame', packed, wave: waveOut,
      level: a.level, bass: a.bass, pulse: a.pulse, live: a.live, idle: a.idle,
      dt, now,
    });
  }

  const stop = tick((dt, now) => {
    if (!visible()) return;

    if (now - accentAt > 400) {
      accentAt = now;
      const a = readVar('--accent-rgb', DEFAULT_ACCENT);
      const b = readVar('--art-rgb', a);
      if (a.join() !== accent.join() || b.join() !== art.join()) {
        accent = a; art = b;
        if (worker) worker.postMessage({ type: 'colours', accent, art });
        else renderer.setColours(accent, art);
      }
    }
    if (now - sizeAt > 600) { sizeAt = now; resize(); }
    if (!w || !h) return;

    if (reduceMotion.matches) {
      // The still version has no reason to repaint until something it is made
      // of changes, so draw it once and stop.
      const key = `${w}x${h}|${accent.join()}|${mode}`;
      if (key !== stillKey) {
        stillKey = key;
        if (worker) worker.postMessage({ type: 'still' });
        else renderer.still();
      }
      return;
    }

    const a = player.analysis();
    if (a.idle && a.level < 0.0015) {
      // Let the last frame fade out, then stop drawing entirely.
      if (++restFrames > 90) return;
    } else restFrames = 0;

    if (worker) sendFrame(a, dt, now);
    else renderer.frame(a, dt, now);
  });

  return {
    canvas,
    /** Which thread is drawing. For the tests, and for a bad afternoon. */
    get offloaded() { return !!worker; },
    get mode() { return mode; },
    setMode(next) {
      if (!isMode(next) || next === mode) return;
      mode = next;
      restFrames = 0;
      stillKey = '';
      if (worker) worker.postMessage({ type: 'mode', mode });
      else renderer.setMode(mode);
    },
    /** Wake a renderer that decided nothing was happening. */
    kick() { restFrames = 0; },
    /** Aim the radial mode at something other than the middle of the canvas. */
    setFocus(x, y) {
      focusX = x; focusY = y;
      if (worker) worker.postMessage({ type: 'focus', x, y });
      else renderer.setFocus(x, y);
    },
    destroy() {
      stop();
      ro.disconnect();
      if (worker) worker.terminate();
    },
  };
}
