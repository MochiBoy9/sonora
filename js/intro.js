/* intro.js — the way in, in three dimensions.
 *
 * The opening sequence is a real 3D scene: five wireframe bars standing on a
 * grid plane, rising out of the floor in sequence while the camera swings
 * around and settles, with tunnel rings running past. The wordmark assembles
 * over the top of it, a meter fills, and the app arrives behind.
 *
 * It runs while the library is being read out of IndexedDB, so the time it
 * takes is time that was being spent anyway — and it is skippable on the first
 * key, click or scroll, because an intro you cannot dismiss is a toll booth.
 *
 * The markup lives in index.html rather than here: it has to be on screen
 * before this module has been fetched, or the first frame is a bare app frame.
 * The static SVG mark it ships with is also the fallback — if there is no
 * WebGL, the sequence plays without the scene and nothing is missing.
 */

import { animate, ease, reduceMotion, settled, tick } from './motion.js';
import { program, uniforms, staticBuffer, mat4, gridLines, barsLines, ringLines } from './gl.js';

const SEEN_KEY = 'sonora:seen';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/* ------------------------------------------------------------------ scene */

const VERT = `
attribute vec3 a_pos;
attribute float a_seed;
uniform mat4 u_mvp;
uniform float u_time, u_grow, u_mode, u_span;
varying mediump float v_fade;
varying mediump float v_seed;

void main() {
  vec3 p = a_pos;

  if (u_mode < 0.5) {
    // The bars: each one rises out of the floor a beat after the last.
    float g = clamp((u_grow - a_seed * 0.55) / 0.45, 0.0, 1.0);
    g = g * g * (3.0 - 2.0 * g);
    p.y *= g;
    p.y += sin(u_time * 2.1 + a_seed * 9.0) * 0.03 * g;
  } else if (u_mode < 1.5) {
    p.z = mod(p.z + u_time * 2.4, u_span) - u_span;   // ground scroll
  } else {
    p.z = mod(p.z + u_time * 3.6, u_span) - u_span;   // rings
  }

  vec4 clip = u_mvp * vec4(p, 1.0);
  gl_Position = clip;
  v_fade = clamp(1.0 - (clip.w - 0.8) / 24.0, 0.0, 1.0);
  v_fade *= v_fade;
  v_seed = a_seed;
}`;

const FRAG = `
precision mediump float;
varying mediump float v_fade;
varying mediump float v_seed;
uniform vec3 u_color, u_color2;
uniform float u_alpha;

void main() {
  vec3 col = mix(u_color, u_color2, v_seed);
  float a = v_fade * u_alpha;
  gl_FragColor = vec4(col * a, a);
}`;

const readVar = (name, fallback) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,/]+/).map(Number).filter((n) => isFinite(n));
  return parts.length >= 3 ? parts.slice(0, 3).map((v) => v / 255) : fallback;
};

/**
 * Builds the scene on the intro's canvas. Returns a handle whose `progress`
 * drives the camera and the bars, or null when WebGL is unavailable.
 */
function mountScene(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false,
    });
  } catch { gl = null; }
  if (!gl) return null;

  const prog = program(gl, VERT, FRAG);
  if (!prog) return null;

  const u = uniforms(gl, prog, ['u_mvp', 'u_time', 'u_grow', 'u_mode', 'u_span', 'u_color', 'u_color2', 'u_alpha']);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  const aSeed = gl.getAttribLocation(prog, 'a_seed');

  const GRID_SPAN = 34;
  const RING_SPAN = 30;
  const bars = staticBuffer(gl, barsLines([0.62, 1.05, 1.55, 0.86, 1.24]), 4);
  const grid = staticBuffer(gl, gridLines({ half: 9, depth: GRID_SPAN, step: 1.5, segs: 18 }), 4);
  const rings = staticBuffer(gl, ringLines({ count: 7, size: 4.6, spacing: RING_SPAN / 7 }), 4);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const proj = mat4.create();
  const view = mat4.create();
  const model = mat4.create();
  const mvp = mat4.create();

  let w = 0, h = 0, dpr = 1;
  let accent = [0, 0.82, 1];
  let accent2 = [0.23, 0.52, 1];

  function resize() {
    // One device pixel per CSS pixel is plenty for wireframe on black, and the
    // intro is the one moment where the library is also trying to paint.
    dpr = Math.min(1, window.devicePixelRatio || 1);
    const nw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const nh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    gl.viewport(0, 0, w, h);
    mat4.perspective(proj, 0.95, w / h, 0.1, 90);
  }
  resize();
  accent = readVar('--accent-rgb', accent);
  accent2 = readVar('--accent-2-rgb', accent2);

  const bind = (mesh) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aSeed);
    gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, 16, 12);
  };

  const draw = (mesh, mode, span, alpha) => {
    gl.uniform1f(u.u_mode, mode);
    gl.uniform1f(u.u_span, span);
    gl.uniform1f(u.u_alpha, alpha);
    bind(mesh);
    gl.drawArrays(gl.LINES, 0, mesh.count);
  };

  return {
    /**
     * @param p      0..1 through the sequence — drives camera and growth
     * @param t      seconds since the scene started
     * @param fade   overall opacity, used on the way out
     */
    render(p, t, fade) {
      resize();
      if (!w || !h) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_grow, p);
      gl.uniform3fv(u.u_color, accent);
      gl.uniform3fv(u.u_color2, accent2);

      // The camera swings in from the side and settles square-on, then drifts.
      const settle = 1 - Math.pow(1 - Math.min(1, p), 3);
      const yaw = (1 - settle) * 0.95 + Math.sin(t * 0.25) * 0.05 * settle;
      const dist = 8.6 - settle * 4.0;
      const pitch = 0.42 - settle * 0.22;

      mat4.identity(view);
      mat4.rotateX(view, pitch);
      mat4.rotateY(view, yaw);
      // Camera low and close to the floor, so the bars stand in the upper half
      // of the frame and the wordmark has the lower half to itself.
      mat4.translate(view, 0, -0.32, -dist);

      // Ground.
      mat4.identity(model);
      mat4.multiply(mvp, view, model);
      mat4.multiply(mvp, proj, mvp);
      gl.uniformMatrix4fv(u.u_mvp, false, mvp);
      draw(grid, 1, GRID_SPAN, fade * 0.4 * settle);

      // Rings, further out and dimmer.
      mat4.identity(model);
      mat4.translate(model, 0, 1.4, 0);
      mat4.multiply(mvp, view, model);
      mat4.multiply(mvp, proj, mvp);
      gl.uniformMatrix4fv(u.u_mvp, false, mvp);
      draw(rings, 2, RING_SPAN, fade * 0.22 * settle);

      // The mark itself.
      mat4.identity(model);
      mat4.rotateY(model, (1 - settle) * -0.5);
      mat4.multiply(mvp, view, model);
      mat4.multiply(mvp, proj, mvp);
      gl.uniformMatrix4fv(u.u_mvp, false, mvp);
      draw(bars, 0, 1, fade);

      gl.disableVertexAttribArray(aPos);
      gl.disableVertexAttribArray(aSeed);
    },
    dispose() {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    },
  };
}

/* ------------------------------------------------------------------ sequence */

/**
 * Starts the sequence immediately and returns handles to the rest of boot:
 *
 *   ready    resolves when the intro has played its minimum, or was skipped
 *   dismiss  fades it out and resolves once it is gone
 */
export function startIntro() {
  const node = document.getElementById('intro');
  if (!node) return { ready: Promise.resolve(), dismiss: () => Promise.resolve(), skipped: true };

  let firstRun = true;
  try { firstRun = !localStorage.getItem(SEEN_KEY); } catch { /* private mode */ }
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* fine */ }

  // A repeat visit gets the same sequence at speed: still an introduction,
  // not a wait.
  const beat = reduceMotion.matches ? 0 : firstRun ? 1 : 0.6;
  const TOTAL = reduceMotion.matches ? 420 : Math.round(2700 * beat + 420);

  const canvas = node.querySelector('.intro-scene');
  const scene = reduceMotion.matches ? null : mountScene(canvas);
  if (scene) node.classList.add('has-scene');

  const eyebrow = node.querySelector('.intro-eyebrow');
  const letters = node.querySelectorAll('.intro-word span');
  const tag = node.querySelector('.intro-tag');
  const hint = node.querySelector('.intro-hint');
  const meter = node.querySelector('.intro-meter i');
  const bars = node.querySelectorAll('.intro-bars rect');
  const frame = node.querySelector('.intro-frame');

  if (eyebrow) eyebrow.textContent = greeting();
  if (tag) tag.textContent = firstRun
    ? 'Your music, played from your own disk.'
    : 'Welcome back.';

  let over = false;                 // the sequence has run its course
  let resolveReady = () => {};
  const ready = new Promise((r) => { resolveReady = r; });
  const startedAt = performance.now();

  /* ---------------------------------------------------------------- frames */

  let fade = 1;
  const stopScene = scene ? tick((dt, now) => {
    const t = (now - startedAt) / 1000;
    scene.render(Math.min(1, (now - startedAt) / (TOTAL * 0.72)), t, fade);
  }) : null;

  /* ---------------------------------------------------------------- timeline */

  if (!reduceMotion.matches) {
    if (frame) {
      animate(frame, { opacity: [0, 1], transform: ['scale(1.08)', 'scale(1)'] },
        { duration: 900 * beat, easing: ease.out });
    }
    // The SVG mark only performs when it is the only mark there is.
    if (!scene) {
      bars.forEach((bar, i) => {
        animate(bar, { transform: ['scaleY(.05)', 'scaleY(1)'], opacity: [0, 1] },
          { duration: 720 * beat, delay: (200 + i * 90) * beat, easing: ease.back });
      });
    }

    animate(eyebrow, { opacity: [0, 1], transform: ['translate3d(0,8px,0)', 'none'] },
      { duration: 600 * beat, delay: 380 * beat, easing: ease.out });

    letters.forEach((span, i) => {
      animate(span,
        { opacity: [0, 1], transform: ['translate3d(0,28px,0) rotateX(-70deg)', 'none'] },
        { duration: 820 * beat, delay: (640 + i * 66) * beat, easing: ease.out });
    });

    animate(tag, { opacity: [0, 1], transform: ['translate3d(0,10px,0)', 'none'] },
      { duration: 620 * beat, delay: 1220 * beat, easing: ease.out });
    animate(hint, { opacity: [0, 0.5] }, { duration: 500 * beat, delay: 1600 * beat });
    animate(meter, { transform: ['scaleX(0)', 'scaleX(1)'] },
      { duration: TOTAL - 200, easing: 'cubic-bezier(.25,.7,.3,1)' });
  } else {
    node.classList.add('is-still');
  }

  const timer = setTimeout(() => finish(false), TOTAL);

  /* ---------------------------------------------------------------- skipping */

  // Below this, a "skip" is someone's first keystroke landing in an app that
  // was not there yet, so it is ignored.
  const FLOOR = 420;

  function finish(early) {
    if (over) return;
    if (early && performance.now() - startedAt < FLOOR) return;
    over = true;
    clearTimeout(timer);
    unbind();
    resolveReady();
  }

  const onKey = (e) => { if (e.key !== 'Tab') finish(true); };
  const onPoint = () => finish(true);
  const bind = () => {
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onPoint, true);
    addEventListener('wheel', onPoint, { passive: true, capture: true });
  };
  const unbind = () => {
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onPoint, true);
    removeEventListener('wheel', onPoint, { capture: true });
  };
  bind();

  /* ---------------------------------------------------------------- exit */

  function dismiss() {
    finish(false);
    node.classList.add('is-leaving');

    const done = () => {
      stopScene?.();
      scene?.dispose();
      node.remove();
      document.body.classList.add('intro-done');
    };

    if (reduceMotion.matches) { done(); return Promise.resolve(); }

    // The scene dims itself as the overlay lifts, so the 3D world behind the
    // app is what the eye lands on.
    const t0 = performance.now();
    const stopFade = tick((dt, now) => {
      fade = Math.max(0, 1 - (now - t0) / 420);
      if (fade <= 0) return false;
    });

    const out = animate(node,
      { opacity: [1, 0], transform: ['scale(1)', 'scale(1.05)'] },
      { duration: 560, easing: ease.inOut, commit: false });
    animate(node.querySelector('.intro-stage'),
      { opacity: [1, 0], transform: ['translate3d(0,0,0)', 'translate3d(0,-22px,0)'] },
      { duration: 420, easing: ease.inOut, commit: false });

    return settled(out, 560).then(() => {
      stopFade();
      done();
    });
  }

  return { ready, dismiss, get skipped() { return over; } };
}
