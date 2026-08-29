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
 * Nothing here touches the DOM after setup, and nothing allocates per frame
 * except the cached gradients, which are rebuilt only when the size or the
 * colours actually change.
 */

import { tick, reduceMotion } from './motion.js';
import * as player from './player.js';

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

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

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
 */
export function createVisualizer(canvas, {
  mode = 'bars', visible = () => true, intensity = 1, bars = 56, band = 0.94,
  idleShimmer = true, chrome = true,
} = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { setMode() {}, setFocus() {}, kick() {}, destroy() {} };

  let w = 0, h = 0, dpr = 1;
  let accent = DEFAULT_ACCENT;
  let art = DEFAULT_ACCENT;
  let accentAt = 0, sizeAt = 0;
  let gradient = null, gradientKey = '';

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const nw = Math.round(rect.width * dpr);
    const nh = Math.round(rect.height * dpr);
    if (nw === w && nh === h) return true;
    w = canvas.width = nw;
    h = canvas.height = nh;
    gradient = null;
    return true;
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  const vertical = (key, stops) => {
    if (gradient && gradientKey === key) return gradient;
    const g = ctx.createLinearGradient(0, h, 0, 0);
    for (const [at, colour] of stops) g.addColorStop(at, colour);
    gradient = g;
    gradientKey = key;
    return g;
  };

  let rotation = 0;
  let restFrames = 0;
  let stillKey = '';
  // Where the radial mode is centred, in 0..1 of the canvas. The stage points
  // this at the artwork so the ring is concentric with the sleeve.
  let focusX = 0.5, focusY = 0.5;

  /* The spectrogram history the mesh mode draws, as a ring buffer. */
  const ROWS = 26, COLS = 40;
  const history = new Float32Array(ROWS * COLS);
  let historyAt = 0, historyClock = 0;

  const stop = tick((dt, now) => {
    if (!visible()) return;

    if (now - accentAt > 400) {
      accentAt = now;
      const a = readVar('--accent-rgb', DEFAULT_ACCENT);
      const b = readVar('--art-rgb', a);
      if (a.join() !== accent.join() || b.join() !== art.join()) {
        accent = a; art = b; gradient = null;
      }
    }
    if (now - sizeAt > 600) { sizeAt = now; resize(); }
    if (!w || !h) return;

    if (reduceMotion.matches) {
      // The still version has no reason to repaint until something it is made
      // of changes, so draw it once and stop.
      const key = `${w}x${h}|${accent.join()}|${mode}`;
      if (key !== stillKey) { stillKey = key; drawStill(); }
      return;
    }

    const a = player.analysis();
    if (a.idle && a.level < 0.0015) {
      // Let the last frame fade out, then stop drawing entirely.
      if (++restFrames > 90) return;
    } else restFrames = 0;

    rotation += dt * (0.00004 + a.level * 0.0005);

    // The mesh advances on its own clock so its scroll speed does not depend
    // on the display's refresh rate.
    historyClock += dt;
    if (historyClock > 45) {
      historyClock = 0;
      historyAt = (historyAt + 1) % ROWS;
      const row = historyAt * COLS;
      const step = a.bands.length / COLS;
      for (let i = 0; i < COLS; i++) {
        let v = 0;
        for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v = Math.max(v, a.bands[j]);
        history[row + i] = v;
      }
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = intensity;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    switch (mode) {
      case 'wave': drawWave(a, now); break;
      case 'radial': drawRadial(a); break;
      case 'mesh': drawMesh(a); break;
      default: drawBars(a, now);
    }
    ctx.globalAlpha = 1;
  });

  /* ---------------------------------------------------------------- bars */

  function drawBars(a, now) {
    const n = Math.max(8, Math.min(bars, a.bands.length));
    const step = a.bands.length / n;
    const gap = w / n;
    const bw = Math.max(2 * dpr, gap * 0.56);
    const g = vertical('bars' + accent.join() + art.join() + h, [
      [0, rgba(accent, 0.95)], [0.6, rgba(accent, 1)], [1, rgba(mix(accent, art, 0.75), 1)]]);

    if (chrome) {
      // A baseline the bars stand on, so they read as measured, not floating.
      ctx.fillStyle = rgba(accent, 0.22);
      ctx.fillRect(0, h - dpr, w, dpr);
    }

    ctx.fillStyle = g;
    for (let i = 0; i < n; i++) {
      let v = 0, peak = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) {
        v = Math.max(v, a.bands[j]);
        peak = Math.max(peak, a.peaks[j]);
      }
      if (idleShimmer && !a.live) {
        // A slow breath, so a paused panel still looks alive rather than dead.
        v = Math.max(v, 0.03 + 0.025 * Math.sin(now * 0.0016 + i * 0.5));
      }
      const bh = Math.max(dpr, v * h * band);
      const x = Math.round(i * gap + (gap - bw) / 2);
      ctx.globalAlpha = intensity * (0.36 + v * 0.64);
      ctx.fillRect(x, h - bh, Math.round(bw), bh);

      if (peak > 0.04) {
        const py = h - Math.max(bh, peak * h * band);
        ctx.globalAlpha = intensity * 0.62;
        ctx.fillRect(x, Math.round(py) - dpr * 2, Math.round(bw), dpr * 1.5);
      }
    }
    ctx.globalAlpha = intensity;
  }

  /* ---------------------------------------------------------------- wave */

  function drawWave(a, now) {
    const wave = a.wave;
    const mid = Math.round(h / 2);
    const n = Math.min(160, Math.max(48, Math.round(w / (3 * dpr))));

    if (chrome) {
      ctx.fillStyle = rgba(accent, 0.16);
      ctx.fillRect(0, mid, w, dpr);                    // the centre axis
      // Ticks along it, every eighth of the width.
      for (let i = 1; i < 8; i++) {
        const x = Math.round((i / 8) * w);
        ctx.fillRect(x, mid - 4 * dpr, dpr, 8 * dpr);
      }
    }

    const amp = mid * 0.84;
    ctx.lineWidth = Math.max(1.4 * dpr, 1.8 * dpr);
    const line = ctx.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, rgba(accent, 0.3));
    line.addColorStop(0.5, rgba(accent, 1));
    line.addColorStop(1, rgba(mix(accent, art, 0.8), 0.3));
    ctx.strokeStyle = line;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      let v;
      if (wave) {
        const j = Math.floor((i / (n - 1)) * (wave.length - 1));
        v = (wave[j] - 128) / 128;
      } else {
        v = idleShimmer ? 0.04 * Math.sin(now * 0.0018 + i * 0.3) : 0;
      }
      const y = mid - v * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // The mirror, dimmer, so the trace sits in something rather than floating.
    ctx.save();
    ctx.globalAlpha = intensity * 0.2;
    ctx.translate(0, 2 * mid);
    ctx.scale(1, -1);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- radial */

  function drawRadial(a) {
    const cx = w * focusX, cy = h * focusY;
    const base = Math.min(w, h) * 0.27 * (1 + a.pulse * 0.05);
    const n = Math.min(64, a.bands.length);
    const step = a.bands.length / n;

    ctx.save();
    ctx.translate(cx, cy);

    if (chrome) {
      // A ticked ring: sixty marks, four of them long. An instrument dial.
      ctx.strokeStyle = rgba(accent, 0.2);
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (let i = 0; i < 60; i++) {
        const ang = (i / 60) * Math.PI * 2;
        const len = i % 15 === 0 ? 9 * dpr : 4 * dpr;
        const r0 = base * 0.9;
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * (r0 - len), Math.sin(ang) * (r0 - len));
      }
      ctx.stroke();
    }

    ctx.rotate(rotation);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v = Math.max(v, a.bands[j]);
      const angle = (i / n) * Math.PI * 2;
      const len = v * Math.min(w, h) * 0.3;
      if (len < dpr) continue;
      const colour = mix(accent, art, i / n);
      ctx.strokeStyle = rgba(colour, 0.32 + v * 0.68);
      ctx.lineWidth = Math.max(1.5 * dpr, (Math.PI * 2 * base / n) * 0.36);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cos * base, sin * base);
      ctx.lineTo(cos * (base + len), sin * (base + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- mesh */

  /**
   * The last second or so of spectrum, drawn as a wireframe surface running
   * away from the viewer. Newest row at the front; each older row is narrower,
   * higher and dimmer, which is all a perspective projection has to be here.
   */
  function drawMesh(a) {
    const baseY = h * 0.92;
    const depth = h * 0.62;
    ctx.lineWidth = dpr;

    for (let r = 0; r < ROWS; r++) {
      // 0 = newest.
      const age = r / (ROWS - 1);
      const row = ((historyAt - r) % ROWS + ROWS) % ROWS;
      const z = 1 / (1 + age * 2.4);                   // perspective divide
      const rowW = w * (0.34 + z * 0.66);
      const x0 = (w - rowW) / 2;
      const y = baseY - (1 - z) * depth;
      const scale = h * 0.3 * z;

      ctx.strokeStyle = rgba(mix(art, accent, z), (0.1 + z * 0.75) * (0.4 + a.level * 0.8));
      ctx.beginPath();
      for (let c = 0; c < COLS; c++) {
        const v = history[row * COLS + c];
        const x = x0 + (c / (COLS - 1)) * rowW;
        const yy = y - v * scale;
        if (c === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------- still */

  /** What reduced-motion users get: the shape, once, without the animation. */
  function drawStill() {
    if (!resize() || !w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = intensity * 0.45;
    ctx.fillStyle = rgba(accent, 0.55);
    const n = 26, gap = w / n;
    for (let i = 0; i < n; i++) {
      const v = 0.18 + 0.5 * Math.abs(Math.sin(i * 1.1));
      const bh = v * h * band * 0.62;
      ctx.fillRect(Math.round(i * gap + gap * 0.22), h - bh, Math.round(gap * 0.56), bh);
    }
    ctx.globalAlpha = 1;
  }

  return {
    canvas,
    get mode() { return mode; },
    setMode(next) {
      if (!isMode(next) || next === mode) return;
      mode = next;
      gradient = null;
      restFrames = 0;
      stillKey = '';
      if (w && h) ctx.clearRect(0, 0, w, h);
    },
    /** Wake a renderer that decided nothing was happening. */
    kick() { restFrames = 0; },
    /** Aim the radial mode at something other than the middle of the canvas. */
    setFocus(x, y) { focusX = x; focusY = y; },
    destroy() { stop(); ro.disconnect(); },
  };
}
