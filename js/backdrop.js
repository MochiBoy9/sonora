/* backdrop.js — the world the instrument sits in.
 *
 * One WebGL canvas behind the whole app, drawing an actual 3D scene rather
 * than a gradient pretending to be one:
 *
 *   sky     a fullscreen pass: horizon glow, vignette, scanlines
 *   grid    a ground plane of lines running to the horizon, scrolling toward
 *           the camera and rippling with the bass
 *   rings   square tunnel sections receding into the distance, pulsing on beat
 *   solid   a wireframe icosahedron turning above the horizon
 *
 * Everything is lines. Perspective is a real projection matrix, not a fake
 * one — the geometry is built once in js/gl.js, uploaded once, and animated
 * entirely in the vertex shader, so a frame is four draw calls and no
 * allocation. It stays dim on purpose: this is the room, not the furniture.
 *
 * If WebGL is missing or the context is lost, the CSS gradients underneath are
 * what you see, and nothing else changes.
 */

import { tick, reduceMotion } from './motion.js';
import * as player from './player.js';
import { program, uniforms, staticBuffer, mat4, gridLines, icosahedronLines, ringLines } from './gl.js';

/* ------------------------------------------------------------------ sky */

/* GLSL ES 1.00 requires that a name declared in both stages carries the same
   precision, and the two stages have different defaults — a vertex shader is
   highp, a fragment shader has to say. Every shared varying is therefore
   qualified explicitly here, and no uniform is shared at all. Getting this
   wrong does not warn at compile time: the program simply fails to link, and
   the whole scene silently disappears. */

const VERT_QUAD = `
attribute vec2 a_xy;
varying mediump vec2 v_uv;
void main() {
  v_uv = a_xy * 0.5 + 0.5;
  gl_Position = vec4(a_xy, 0.0, 1.0);
}`;

const FRAG_SKY = `
precision highp float;
varying mediump vec2 v_uv;
uniform vec2 u_res;
uniform float u_time, u_level, u_bass, u_alpha, u_ink;
uniform vec3 u_accent, u_art;

void main() {
  vec2 uv = v_uv;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);

  // A band of light sitting on the horizon line, breathing with the music.
  float horizon = 0.42;
  float band = exp(-pow((uv.y - horizon) * 7.5, 2.0)) * (0.5 + u_level * 1.1);

  // Two slow lobes either side of centre, so the light is never symmetrical.
  float lobeL = exp(-pow((p.x + 0.42 + sin(u_time * 0.11) * 0.16) * 2.2, 2.0));
  float lobeR = exp(-pow((p.x - 0.46 + cos(u_time * 0.09) * 0.14) * 2.4, 2.0));
  float glow = band * (0.55 + lobeL * 0.5 + lobeR * 0.45);

  // A wash climbing from the floor, tinted by the album that is playing.
  float floorWash = smoothstep(0.44, -0.05, uv.y) * (0.16 + u_bass * 0.3);

  vec3 col = u_accent * glow + u_art * floorWash;

  // Scanlines: one pixel in three, at the edge of perception.
  float scan = 0.965 + 0.035 * sin(gl_FragCoord.y * 1.6);
  col *= scan;

  float vignette = smoothstep(1.35, 0.15, length(p));
  float a = clamp((glow * 0.5 + floorWash * 0.7) * vignette * u_alpha, 0.0, mix(0.92, 0.2, u_ink));
  vec3 shade = mix(col, col * 0.24, u_ink);
  gl_FragColor = vec4(shade * a, a);
}`;

/* ------------------------------------------------------------------ lines */

const VERT_LINES = `
attribute vec3 a_pos;
attribute float a_seed;
uniform mat4 u_mvp;
uniform float u_time, u_bass, u_level, u_mode, u_span, u_pulse;
varying mediump float v_fade;
varying mediump float v_seed;

void main() {
  vec3 p = a_pos;

  if (u_mode < 0.5) {
    // Ground plane: scroll toward the camera and ripple with the low end.
    p.z = mod(p.z + u_time * 3.2, u_span) - u_span;
    float wave = sin(p.z * 0.42 + u_time * 1.6) * cos(p.x * 0.31 - u_time * 0.7);
    p.y += wave * (0.06 + u_bass * 0.85);
  } else if (u_mode < 1.5) {
    // Tunnel rings: run past the camera and swell on a beat.
    p.z = mod(p.z + u_time * 5.0, u_span) - u_span;
    p.xy *= 1.0 + u_pulse * 0.06 + u_level * 0.05;
  }

  vec4 clip = u_mvp * vec4(p, 1.0);
  gl_Position = clip;

  // Distance fade, computed from the projected w so it matches the camera.
  v_fade = clamp(1.0 - (clip.w - 1.0) / 34.0, 0.0, 1.0);
  v_fade *= v_fade;
  v_seed = a_seed;
}`;

const FRAG_LINES = `
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

/* ------------------------------------------------------------------ colour */

const DEFAULT_ACCENT = [0, 209, 255];
const DEFAULT_ART = [0, 209, 255];

function readVar(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,/]+/).map(Number).filter((n) => isFinite(n));
  return parts.length >= 3 ? parts.slice(0, 3) : fallback;
}

/**
 * @param host      element the canvas is appended to
 * @param enabled   start drawing straight away
 * @returns { supported, canvas, setEnabled, setIntensity, destroy }
 */
export function mountBackdrop(host, { enabled = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  host.insertBefore(canvas, host.firstChild);

  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: true,
      depth: false, stencil: false, powerPreference: 'low-power',
    });
  } catch { gl = null; }

  const dead = { supported: false, canvas: null, setEnabled() {}, setIntensity() {}, destroy() {} };
  if (!gl) { canvas.remove(); return dead; }

  const sky = program(gl, VERT_QUAD, FRAG_SKY);
  const lines = program(gl, VERT_LINES, FRAG_LINES);
  if (!sky || !lines) { canvas.remove(); return dead; }

  const uSky = uniforms(gl, sky, ['u_res', 'u_time', 'u_level', 'u_bass', 'u_alpha', 'u_ink', 'u_accent', 'u_art']);
  const uLin = uniforms(gl, lines, ['u_mvp', 'u_time', 'u_bass', 'u_level', 'u_mode', 'u_span', 'u_pulse', 'u_color', 'u_color2', 'u_alpha']);
  // How much the music brightens the lines. Folded in on this side so the two
  // stages share no uniform at all.
  const lit = (base, a) => base * (0.55 + a * 0.7);

  const quad = staticBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3]), 2);
  const GRID_DEPTH = 48;
  const grid = staticBuffer(gl, gridLines({ half: 18, depth: GRID_DEPTH, step: 2.2, segs: 24 }), 4);
  const RING_SPAN = 46;
  const rings = staticBuffer(gl, ringLines({ count: 10, size: 7.4, spacing: RING_SPAN / 10 }), 4);
  const solid = staticBuffer(gl, icosahedronLines(1), 4);

  const aXY = gl.getAttribLocation(sky, 'a_xy');
  const aPos = gl.getAttribLocation(lines, 'a_pos');
  const aSeed = gl.getAttribLocation(lines, 'a_seed');

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);       // premultiplied "over"
  gl.clearColor(0, 0, 0, 0);
  gl.lineWidth(1);

  /* ---------------------------------------------------------------- state */

  const proj = mat4.create();
  const view = mat4.create();
  const model = mat4.create();
  const mvp = mat4.create();

  let dpr = 1, w = 0, h = 0;
  let accent = DEFAULT_ACCENT.map((v) => v / 255);
  let art = DEFAULT_ART.map((v) => v / 255);
  let accentAt = 0;
  let intensity = 1;
  let on = enabled;
  let lost = false;
  const t0 = performance.now();

  // Adaptive load. A machine without a real GPU will happily render this at
  // 12fps and make the whole interface feel broken, so measure the frame
  // budget and back off: first to every other frame, then out of the way.
  let avgFrame = 16.7;
  let skip = 0, phase = 0, strain = 0;
  let staticKey = '';

  function resize() {
    // The scene is soft by construction, so it renders below native
    // resolution: half the pixels, none of the difference.
    dpr = Math.min(1.35, window.devicePixelRatio || 1);
    const nw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const nh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    gl.viewport(0, 0, w, h);
    mat4.perspective(proj, 1.02, w / h, 0.1, 140);
  }
  resize();

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; });

  function bindLines(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aSeed);
    gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, 16, 12);
  }

  /* ---------------------------------------------------------------- frame */

  const stop = tick((dt, now) => {
    if (!on || lost || document.hidden) return;

    avgFrame += (dt - avgFrame) * 0.06;
    if (avgFrame > 26) {
      skip = 1;                                       // half rate
      strain += dt;
      if (strain > 4000) {                            // it never recovered
        console.info('[sonora] backdrop off: this device cannot draw it smoothly');
        on = false;
        canvas.classList.add('is-off');
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
    } else if (avgFrame < 20) {
      skip = 0;
      strain = Math.max(0, strain - dt);
    }
    if (skip && (phase = 1 - phase)) return;

    if (now - accentAt > 400) {
      accentAt = now;
      accent = readVar('--accent-rgb', DEFAULT_ACCENT).map((v) => v / 255);
      art = readVar('--art-rgb', DEFAULT_ART).map((v) => v / 255);
    }
    resize();
    if (!w || !h) return;

    const a = player.analysis();
    const still = reduceMotion.matches;
    const t = still ? 8 : (now - t0) / 1000;
    const light = document.documentElement.getAttribute('data-theme') === 'light' ||
      (!document.documentElement.getAttribute('data-theme') &&
        matchMedia('(prefers-color-scheme: light)').matches);
    const alpha = intensity * (light ? 0.5 : 1);
    const ink = light ? 1 : 0;

    if (still) {
      const key = `${w}x${h}|${accent.join()}|${art.join()}|${alpha}`;
      if (key === staticKey) return;                  // already on screen
      staticKey = key;
    } else staticKey = '';

    gl.clear(gl.COLOR_BUFFER_BIT);

    /* -- sky ------------------------------------------------------------ */
    gl.useProgram(sky);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad.buf);
    gl.enableVertexAttribArray(aXY);
    gl.vertexAttribPointer(aXY, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uSky.u_res, w, h);
    gl.uniform1f(uSky.u_time, t);
    gl.uniform1f(uSky.u_level, a.level);
    gl.uniform1f(uSky.u_bass, a.bass);
    gl.uniform1f(uSky.u_alpha, alpha);
    gl.uniform1f(uSky.u_ink, ink);
    gl.uniform3fv(uSky.u_accent, accent);
    gl.uniform3fv(uSky.u_art, art);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(aXY);

    /* -- camera --------------------------------------------------------- */
    // Eye a little above the plane, looking very slightly down, drifting.
    mat4.identity(view);
    mat4.rotateX(view, 0.085 + Math.sin(t * 0.07) * 0.012);
    mat4.translate(view, 0, -1.55, -3.4);

    gl.useProgram(lines);
    gl.uniform1f(uLin.u_time, t);
    gl.uniform1f(uLin.u_bass, a.bass);
    gl.uniform1f(uLin.u_level, a.level);
    gl.uniform1f(uLin.u_pulse, a.pulse);

    /* -- ground --------------------------------------------------------- */
    mat4.identity(model);
    mat4.multiply(mvp, view, model);
    mat4.multiply(mvp, proj, mvp);
    gl.uniformMatrix4fv(uLin.u_mvp, false, mvp);
    gl.uniform1f(uLin.u_mode, 0);
    gl.uniform1f(uLin.u_span, GRID_DEPTH);
    gl.uniform3fv(uLin.u_color, accent);
    gl.uniform3fv(uLin.u_color2, art);
    gl.uniform1f(uLin.u_alpha, lit(alpha * 0.62, a.level));
    bindLines(grid);
    gl.drawArrays(gl.LINES, 0, grid.count);

    /* -- rings ---------------------------------------------------------- */
    mat4.identity(model);
    mat4.translate(model, 0, 3.4, 0);
    mat4.multiply(mvp, view, model);
    mat4.multiply(mvp, proj, mvp);
    gl.uniformMatrix4fv(uLin.u_mvp, false, mvp);
    gl.uniform1f(uLin.u_mode, 1);
    gl.uniform1f(uLin.u_span, RING_SPAN);
    gl.uniform1f(uLin.u_alpha, lit(alpha * 0.36, a.level));
    bindLines(rings);
    gl.drawArrays(gl.LINES, 0, rings.count);

    /* -- the solid ------------------------------------------------------ */
    mat4.identity(model);
    mat4.translate(model, 3.1, 3.5, -13);
    mat4.rotateY(model, t * 0.22);
    mat4.rotateX(model, t * 0.13);
    const s = 1.5 + a.level * 0.5 + a.pulse * 0.12;
    mat4.scale(model, s, s, s);
    mat4.multiply(mvp, view, model);
    mat4.multiply(mvp, proj, mvp);
    gl.uniformMatrix4fv(uLin.u_mvp, false, mvp);
    gl.uniform1f(uLin.u_mode, 2);                    // no displacement
    gl.uniform1f(uLin.u_alpha, lit(alpha * 0.7, a.level));
    bindLines(solid);
    gl.drawArrays(gl.LINES, 0, solid.count);

    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aSeed);
  });

  return {
    supported: true,
    canvas,
    setEnabled(next) {
      on = !!next;
      canvas.classList.toggle('is-off', !on);
      staticKey = '';
      if (!on && w && h) gl.clear(gl.COLOR_BUFFER_BIT);
    },
    /** 1 in the app, higher on the immersive stage. */
    setIntensity(v) {
      intensity = Math.max(0, Math.min(2.4, v));
      staticKey = '';
    },
    destroy() { stop(); ro.disconnect(); canvas.remove(); },
  };
}
