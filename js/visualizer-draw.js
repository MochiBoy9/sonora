/* visualizer-draw.js — the four renderers, and nothing else.
 *
 * Split out of visualizer.js so that exactly one implementation of the
 * drawing can run in either of two places: on the main thread against a
 * <canvas>, or inside a worker against an OffscreenCanvas transferred to it.
 *
 * That is the whole reason this file exists, and it is worth being explicit
 * about the alternative. The obvious way to add an OffscreenCanvas path is to
 * write a second copy of the drawing inside the worker — and then every future
 * change to a bar or a tick has to be made twice, and the two quietly drift
 * until the visualiser looks different depending on whether the machine
 * supports a feature nobody can see. One renderer, driven from two places, is
 * the version that cannot rot.
 *
 * Nothing here touches the DOM, reads a CSS variable or looks at a canvas
 * element. It is handed a 2D context, a size, two colours and a frame of
 * analysis, and it draws. Everything it needs to remember between frames — the
 * rotation, the spectrogram history, the cached gradient — it owns.
 */

const DEFAULT_ACCENT = [0, 209, 255];

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * @param ctx   a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D
 * @param opts  the same options createVisualizer takes
 */
export function createRenderer(ctx, {
  mode = 'bars', intensity = 1, bars = 56, band = 0.94,
  idleShimmer = true, chrome = true,
} = {}) {
  let w = 0, h = 0, dpr = 1;
  let accent = DEFAULT_ACCENT;
  let art = DEFAULT_ACCENT;
  let gradient = null, gradientKey = '';
  let rotation = 0;
  let focusX = 0.5, focusY = 0.5;

  /* The spectrogram history the mesh mode draws, as a ring buffer. */
  const ROWS = 26, COLS = 40;
  const history = new Float32Array(ROWS * COLS);
  let historyAt = 0, historyClock = 0;

  const vertical = (key, stops) => {
    if (gradient && gradientKey === key) return gradient;
    const g = ctx.createLinearGradient(0, h, 0, 0);
    for (const [at, colour] of stops) g.addColorStop(at, colour);
    gradient = g;
    gradientKey = key;
    return g;
  };

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

  /* ---------------------------------------------------------------- api */

  return {
    get mode() { return mode; },

    setSize(nw, nh, ndpr) {
      if (nw === w && nh === h && ndpr === dpr) return false;
      w = nw; h = nh; dpr = ndpr;
      gradient = null;
      return true;
    },

    setColours(a, b) {
      if (a.join() === accent.join() && b.join() === art.join()) return false;
      accent = a; art = b; gradient = null;
      return true;
    },

    setMode(next) {
      mode = next;
      gradient = null;
      if (w && h) ctx.clearRect(0, 0, w, h);
    },

    setFocus(x, y) { focusX = x; focusY = y; },

    /** One frame. `a` is a reading of the analyser; see player.analysis(). */
    frame(a, dt, now) {
      if (!w || !h) return;
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
    },

    /** What reduced-motion users get: the shape, once, without the animation. */
    still() {
      if (!w || !h) return;
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
    },
  };
}
