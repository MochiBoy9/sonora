/* visualizer.js — the analyser, drawn.
 *
 * Four renderers over one shared reading of the spectrum (player.analysis()),
 * so however many visualisers are on screen the FFT is still only banded once
 * per frame. Everything draws into a 2D canvas sized to the device pixel ratio;
 * nothing here touches the DOM after setup, and nothing allocates per frame
 * except the cached gradients, which are rebuilt only when the size or the
 * accent colour actually changes.
 *
 *   bars    columns on a log-frequency scale, with peak caps that fall
 *   wave    the oscilloscope: the actual waveform, mirrored and filled
 *   radial  the same bands wrapped around a circle, rotating with the music
 *   ribbon  stacked spectral curves drifting at different speeds
 */

import { tick, reduceMotion } from './motion.js';
import * as player from './player.js';

export const MODES = [
  { id: 'bars', label: 'Bars' },
  { id: 'wave', label: 'Wave' },
  { id: 'radial', label: 'Radial' },
  { id: 'ribbon', label: 'Ribbon' },
];

export const isMode = (id) => MODES.some((m) => m.id === id);

const DEFAULT_ACCENT = [124, 108, 255];

/* ------------------------------------------------------------------ colour */

/** "124 108 255" -> [124,108,255]. Reading this costs a style resolve, so the
 *  caller does it a few times a second, never per frame. */
function readAccent() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  const parts = raw.split(/[\s,/]+/).map(Number).filter((n) => isFinite(n));
  return parts.length >= 3 ? parts.slice(0, 3) : DEFAULT_ACCENT;
}

/** Rotates a colour around the hue wheel — the second stop of every gradient. */
function shiftHue([r, g, b], deg, satBoost = 1.08, lightBoost = 1.12) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + deg + 360) % 360;
  const s2 = Math.min(1, s * satBoost);
  const l2 = Math.min(0.86, l * lightBoost);
  const c = (1 - Math.abs(2 * l2 - 1)) * s2;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l2 - c / 2;
  const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)];
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/* ------------------------------------------------------------------ shapes */

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Catmull-Rom through the points, emitted as bezier segments. */
function smoothPath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y);
  }
}

/* ------------------------------------------------------------------ mount */

/**
 * @param canvas            the target <canvas>
 * @param mode              one of MODES
 * @param visible()         cheap predicate: is this canvas worth drawing?
 * @param intensity         0..1 overall opacity multiplier
 * @param bars              how many columns the bar/ribbon modes draw
 * @param band              fraction of the canvas height the bars may fill
 * @param idleShimmer       breathe gently instead of flatlining when paused
 */
export function createVisualizer(canvas, {
  mode = 'bars', visible = () => true, intensity = 1, bars = 56, band = 0.94,
  idleShimmer = true,
} = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { setMode() {}, destroy() {} };

  let w = 0, h = 0, dpr = 1;
  let accent = DEFAULT_ACCENT, accent2 = shiftHue(DEFAULT_ACCENT, 42);
  let accentAt = 0, sizeAt = 0;
  let gradient = null, gradientKey = '';
  const pts = [];                                     // reused path buffer

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
  let drift = 0;
  let restFrames = 0;
  // Where the radial mode is centred, in 0..1 of the canvas. The stage points
  // this at the artwork so the ring is concentric with the sleeve rather than
  // with the window.
  let focusX = 0.5, focusY = 0.5;

  let stillKey = '';

  const stop = tick((dt, now) => {
    if (!visible()) return;

    // Custom properties and element boxes both cost a style resolve; a few
    // times a second is plenty for colours that ease and panels that slide.
    if (now - accentAt > 400) {
      accentAt = now;
      const next = readAccent();
      if (next[0] !== accent[0] || next[1] !== accent[1] || next[2] !== accent[2]) {
        accent = next;
        accent2 = shiftHue(next, 42);
        gradient = null;
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

    drift += dt * 0.00006;
    rotation += dt * (0.00004 + a.level * 0.0004);

    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = intensity;
    switch (mode) {
      case 'wave': drawWave(a, now); break;
      case 'radial': drawRadial(a); break;
      case 'ribbon': drawRibbon(a); break;
      default: drawBars(a, now);
    }
    ctx.globalAlpha = 1;
  });

  /* ---------------------------------------------------------------- bars */

  function drawBars(a, now) {
    const n = Math.max(8, Math.min(bars, a.bands.length));
    const step = a.bands.length / n;
    const gap = w / n;
    const bw = Math.max(2 * dpr, gap * 0.62);
    const g = vertical('bars' + accent.join() + h, [
      [0, rgba(accent, 0.95)], [0.55, rgba(accent, 0.98)], [1, rgba(accent2, 1)]]);

    ctx.fillStyle = g;
    ctx.shadowColor = rgba(accent, 0.55);
    ctx.shadowBlur = 14 * dpr * (0.4 + a.level);
    for (let i = 0; i < n; i++) {
      let v = 0, peak = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) {
        v = Math.max(v, a.bands[j]);
        peak = Math.max(peak, a.peaks[j]);
      }
      if (idleShimmer && !a.live) {
        // A slow breath, so a paused panel still looks alive rather than dead.
        v = Math.max(v, 0.035 + 0.03 * Math.sin(now * 0.0016 + i * 0.5));
      }
      const bh = Math.max(2 * dpr, v * h * band);
      const x = i * gap + (gap - bw) / 2;
      ctx.globalAlpha = intensity * (0.42 + v * 0.58);
      roundRect(ctx, x, h - bh, bw, bh, bw / 2);
      ctx.fill();

      if (peak > 0.04) {
        const py = h - Math.max(bh, peak * h * band);
        ctx.globalAlpha = intensity * 0.5;
        roundRect(ctx, x, py - 2 * dpr, bw, 2 * dpr, dpr);
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = intensity;
  }

  /* ---------------------------------------------------------------- wave */

  function drawWave(a, now) {
    const wave = a.wave;
    const mid = h / 2;
    const n = 96;
    pts.length = 0;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      let v;
      if (wave) {
        const j = Math.floor((i / (n - 1)) * (wave.length - 1));
        v = (wave[j] - 128) / 128;
      } else {
        v = 0.045 * Math.sin(now * 0.0018 + i * 0.28) * (idleShimmer ? 1 : 0);
      }
      pts.push({ x, y: mid - v * mid * 0.86 });
    }

    ctx.lineWidth = Math.max(1.5 * dpr, 2.2 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Filled body first, then the bright line over the top of it.
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(w, mid);
    ctx.lineTo(0, mid);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, w, 0);
    fill.addColorStop(0, rgba(accent, 0.05));
    fill.addColorStop(0.5, rgba(accent, 0.26));
    fill.addColorStop(1, rgba(accent2, 0.05));
    ctx.fillStyle = fill;
    ctx.fill();

    const line = ctx.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, rgba(accent, 0.25));
    line.addColorStop(0.5, rgba(accent2, 1));
    line.addColorStop(1, rgba(accent, 0.25));
    ctx.strokeStyle = line;
    ctx.shadowColor = rgba(accent, 0.7);
    ctx.shadowBlur = 16 * dpr * (0.3 + a.level * 1.4);
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // The mirror, dimmer, so the wave sits in something rather than floating.
    ctx.save();
    ctx.globalAlpha = intensity * 0.24;
    ctx.translate(0, 2 * mid);
    ctx.scale(1, -1);
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- radial */

  function drawRadial(a) {
    const cx = w * focusX, cy = h * focusY;
    const base = Math.min(w, h) * 0.26 * (1 + a.pulse * 0.06);
    const n = Math.min(72, a.bands.length);
    const step = a.bands.length / n;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v = Math.max(v, a.bands[j]);
      const angle = (i / n) * Math.PI * 2;
      const len = base * 0.18 + v * Math.min(w, h) * 0.28;
      const t = i / n;
      const colour = [
        Math.round(accent[0] + (accent2[0] - accent[0]) * t),
        Math.round(accent[1] + (accent2[1] - accent[1]) * t),
        Math.round(accent[2] + (accent2[2] - accent[2]) * t),
      ];
      ctx.strokeStyle = rgba(colour, 0.35 + v * 0.65);
      ctx.lineWidth = Math.max(1.5 * dpr, (Math.PI * 2 * base / n) * 0.42);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cos * base, sin * base);
      ctx.lineTo(cos * (base + len), sin * (base + len));
      ctx.stroke();
    }

    ctx.strokeStyle = rgba(accent, 0.22 + a.level * 0.3);
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.arc(0, 0, base * 0.92, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- ribbon */

  function drawRibbon(a) {
    const layers = 3;
    const n = 34;
    for (let l = 0; l < layers; l++) {
      const phase = drift * (1 + l * 0.7);
      const amp = (0.5 + a.level * 1.5) * (1 - l * 0.22);
      pts.length = 0;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const band = a.bands[Math.floor(t * (a.bands.length - 1))];
        const wobble = Math.sin(t * 6.2 + phase * 26 + l) * 0.06;
        const y = h * (0.62 + l * 0.06) - (band * amp + wobble) * h * 0.5;
        pts.push({ x: t * w, y });
      }
      ctx.beginPath();
      smoothPath(ctx, pts);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, w, h);
      const c = l % 2 ? accent2 : accent;
      g.addColorStop(0, rgba(c, 0.05 + l * 0.02));
      g.addColorStop(0.5, rgba(c, 0.30 - l * 0.07));
      g.addColorStop(1, rgba(l % 2 ? accent : accent2, 0.05));
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------------- still */

  /** What reduced-motion users get: the shape, once, without the animation. */
  function drawStill() {
    if (!resize() || !w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = intensity * 0.42;
    ctx.fillStyle = rgba(accent, 0.5);
    const n = 24, gap = w / n;
    for (let i = 0; i < n; i++) {
      const v = 0.2 + 0.5 * Math.abs(Math.sin(i * 1.1));
      const bh = v * h * band * 0.62;
      roundRect(ctx, i * gap + gap * 0.2, h - bh, gap * 0.6, bh, gap * 0.3);
      ctx.fill();
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
      if (w && h) ctx.clearRect(0, 0, w, h);
    },
    /** Wake a renderer that decided nothing was happening. */
    kick() { restFrames = 0; },
    /** Aim the radial mode at something other than the middle of the canvas. */
    setFocus(x, y) { focusX = x; focusY = y; },
    destroy() { stop(); ro.disconnect(); },
  };
}
