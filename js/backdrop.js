/* backdrop.js — the room the app sits in.
 *
 * A single WebGL canvas behind the whole interface, drawing two passes:
 *
 *   1. an aurora — three slow metaballs in the current accent colour, which
 *      is where the sense of a lit space comes from;
 *   2. a depth field — a few thousand points scattered through a 3D volume,
 *      rotated and projected with a real perspective divide, looping toward
 *      the camera so the interface appears to be moving through something.
 *
 * Both are audio-reactive: bass widens the field and swells the aurora, the
 * overall level brightens it, and a detected beat pushes a pulse through the
 * points. It is deliberately dim — this is depth behind the content, not
 * decoration in front of it — and it costs one draw call per pass.
 *
 * No dependency, no shader library: ~120 lines of GLSL compiled at boot. If
 * WebGL is missing or the context is lost, the app keeps the CSS gradient it
 * has always had and nothing else changes.
 */

import { tick, reduceMotion } from './motion.js';
import * as player from './player.js';

const VERT_QUAD = `
attribute vec2 a_xy;
void main() { gl_Position = vec4(a_xy, 0.0, 1.0); }`;

const FRAG_AURORA = `
precision highp float;
uniform vec2 u_res;
uniform float u_time, u_level, u_bass, u_alpha, u_ink;
uniform vec3 u_accent, u_accent2;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float t = u_time * 0.055;
  vec3 col = vec3(0.0);
  float acc = 0.0;

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(
      sin(t * (0.62 + fi * 0.21) + fi * 2.3) * 0.46,
      cos(t * (0.47 + fi * 0.29) + fi * 1.6) * 0.32);
    float rad = 0.30 + 0.09 * sin(t * 1.15 + fi * 2.0) + u_bass * 0.07;
    float d = length(p - c) / rad;
    float g = exp(-d * d * 2.1);
    col += mix(u_accent, u_accent2, fi * 0.5) * g;
    acc += g;
  }

  // A shallow gradient toward the top keeps the header end of the page lighter
  // than the player bar, which is what makes it read as a room.
  float sky = smoothstep(-0.1, 0.9, uv.y) * 0.22;
  col += mix(u_accent, u_accent2, 0.5) * sky;
  acc += sky;

  float vignette = smoothstep(1.25, 0.1, length(p));
  float a = clamp(acc * 0.46 * vignette * u_alpha * (0.62 + u_level * 0.9), 0.0,
                  mix(0.95, 0.20, u_ink));
  // On a light page, light added to white is invisible: the same shapes are
  // painted as a darker tint instead, which is a wash rather than a glow.
  vec3 shade = mix(col, col * 0.30, u_ink);
  gl_FragColor = vec4(shade * a, a);
}`;

const VERT_FIELD = `
attribute vec3 a_pos;
attribute float a_seed;
uniform vec2 u_res;
uniform float u_time, u_bass, u_level, u_dpr;
varying float v_depth;
varying float v_seed;

void main() {
  // Depth loops 0..1, so the field flies past the camera forever.
  float z = fract(a_pos.z + u_time * 0.028 + u_level * 0.02);
  float dist = mix(5.6, 0.42, z);
  float spread = 1.0 + u_bass * 0.42;

  vec3 p = vec3(a_pos.xy * 2.3 * spread, dist);
  float ang = u_time * 0.045 + a_seed * 0.7;
  float s = sin(ang), c = cos(ang);
  p.xy = mat2(c, -s, s, c) * p.xy;
  // A slow tilt on the other axis, so it never looks like a flat plane.
  p.y += sin(u_time * 0.11 + a_seed * 6.0) * 0.16;

  float aspect = u_res.x / max(u_res.y, 1.0);
  gl_Position = vec4(vec2(p.x / aspect, p.y) / p.z, 0.0, 1.0);
  gl_PointSize = clamp(u_dpr * (7.0 + u_level * 22.0) / p.z, 1.0, 64.0);
  v_depth = z;
  v_seed = a_seed;
}`;

const FRAG_FIELD = `
precision mediump float;
varying float v_depth;
varying float v_seed;
uniform vec3 u_accent, u_accent2;
uniform float u_alpha, u_pulse, u_ink;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float glow = pow(smoothstep(0.5, 0.0, r), 2.1);
  // Near the camera and far away both fade out, so points arrive and leave.
  float fade = smoothstep(0.0, 0.14, v_depth) * (1.0 - smoothstep(0.68, 1.0, v_depth));
  vec3 col = mix(u_accent, u_accent2, v_seed);
  col = mix(col, col * 0.26, u_ink);              // dark motes on a light page
  float a = glow * fade * u_alpha * (0.55 + u_pulse * 0.6) * 1.15;
  gl_FragColor = vec4(col * a, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[sonora] shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function program(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[sonora] link:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

/** Collects uniform locations once, by name. */
function uniforms(gl, prog, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

const DEFAULT_ACCENT = [124, 108, 255];

function readAccent() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  const parts = raw.split(/[\s,/]+/).map(Number).filter((n) => isFinite(n));
  return parts.length >= 3 ? parts.slice(0, 3) : DEFAULT_ACCENT;
}

/**
 * @param host      element the canvas is appended to
 * @param enabled   start drawing straight away
 * @returns { supported, setEnabled, setIntensity, destroy }
 */
export function mountBackdrop(host, { enabled = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  host.insertBefore(canvas, host.firstChild);

  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    });
  } catch { gl = null; }

  if (!gl) {
    canvas.remove();
    return { supported: false, setEnabled() {}, setIntensity() {}, destroy() {} };
  }

  const aurora = program(gl, VERT_QUAD, FRAG_AURORA);
  const field = program(gl, VERT_FIELD, FRAG_FIELD);
  if (!aurora || !field) {
    canvas.remove();
    return { supported: false, setEnabled() {}, setIntensity() {}, destroy() {} };
  }

  const uA = uniforms(gl, aurora, ['u_res', 'u_time', 'u_level', 'u_bass', 'u_alpha', 'u_ink', 'u_accent', 'u_accent2']);
  const uF = uniforms(gl, field, ['u_res', 'u_time', 'u_bass', 'u_level', 'u_dpr', 'u_alpha', 'u_pulse', 'u_ink', 'u_accent', 'u_accent2']);

  // Fullscreen triangle pair for the aurora pass.
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  // The depth field. Positions are static; everything that moves is done in
  // the vertex shader, so this buffer is uploaded exactly once.
  const COUNT = Math.round(Math.min(1500, Math.max(420, (innerWidth * innerHeight) / 1400)));
  const points = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    // Push points away from dead centre, where the content sits.
    const r = 0.28 + Math.pow(Math.random(), 0.6) * 0.86;
    const th = Math.random() * Math.PI * 2;
    points[i * 4] = Math.cos(th) * r;
    points[i * 4 + 1] = Math.sin(th) * r * 0.8;
    points[i * 4 + 2] = Math.random();
    points[i * 4 + 3] = Math.random();
  }
  const fieldBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fieldBuf);
  gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);

  const aXY = gl.getAttribLocation(aurora, 'a_xy');
  const aPos = gl.getAttribLocation(field, 'a_pos');
  const aSeed = gl.getAttribLocation(field, 'a_seed');

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);       // premultiplied "over"
  gl.clearColor(0, 0, 0, 0);

  let dpr = 1, w = 0, h = 0;
  let accent = DEFAULT_ACCENT.map((v) => v / 255);
  let accent2 = accent;
  let accentAt = 0;
  let intensity = 1;
  let on = enabled;
  let lost = false;
  let t0 = performance.now();

  // Adaptive load. A machine without a real GPU (software GL, a remote
  // session, an old laptop) will happily render this at 12fps and make the
  // whole interface feel broken, so measure the frame budget and back off:
  // first to every other frame, then out of the way altogether.
  let avgFrame = 16.7;
  let skip = 0, phase = 0, strain = 0;
  // With reduced motion the scene is a still life, so it is drawn once and
  // then left alone until something it depends on changes.
  let staticKey = '';

  function resize() {
    // The backdrop is soft by construction, so it renders below native
    // resolution: half the pixels, none of the difference.
    dpr = Math.min(1.25, window.devicePixelRatio || 1);
    const nw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const nh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    gl.viewport(0, 0, w, h);
  }
  resize();

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; });

  /** Hue-rotated partner colour, so the field has range instead of one flat tint. */
  function partner([r, g, b]) {
    return [Math.min(1, b * 0.9 + 0.12), Math.min(1, r * 0.75 + 0.1), Math.min(1, g * 0.8 + 0.18)];
  }

  const stop = tick((dt, now) => {
    if (!on || lost) return;
    if (document.hidden) return;

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
      const rgb = readAccent().map((v) => v / 255);
      accent = rgb;
      accent2 = partner(rgb);
    }
    resize();
    if (!w || !h) return;

    const a = player.analysis();
    const t = (now - t0) / 1000;
    // Reduced motion still gets the depth, just held still.
    const time = reduceMotion.matches ? 12 : t;
    const light = document.documentElement.getAttribute('data-theme') === 'light' ||
      (!document.documentElement.getAttribute('data-theme') &&
        matchMedia('(prefers-color-scheme: light)').matches);
    const alpha = intensity * (light ? 0.62 : 1);
    const ink = light ? 1 : 0;

    if (reduceMotion.matches) {
      const key = `${w}x${h}|${accent.join()}|${alpha}|${ink}`;
      if (key === staticKey) return;                  // already on screen
      staticKey = key;
    } else staticKey = '';

    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(aurora);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aXY);
    gl.vertexAttribPointer(aXY, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uA.u_res, w, h);
    gl.uniform1f(uA.u_time, time);
    gl.uniform1f(uA.u_level, a.level);
    gl.uniform1f(uA.u_bass, a.bass);
    gl.uniform1f(uA.u_alpha, alpha);
    gl.uniform1f(uA.u_ink, ink);
    gl.uniform3fv(uA.u_accent, accent);
    gl.uniform3fv(uA.u_accent2, accent2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(aXY);

    gl.useProgram(field);
    gl.bindBuffer(gl.ARRAY_BUFFER, fieldBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aSeed);
    gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, 16, 12);
    gl.uniform2f(uF.u_res, w, h);
    gl.uniform1f(uF.u_time, time);
    gl.uniform1f(uF.u_bass, a.bass);
    gl.uniform1f(uF.u_level, a.level);
    gl.uniform1f(uF.u_dpr, dpr);
    gl.uniform1f(uF.u_alpha, alpha);
    gl.uniform1f(uF.u_pulse, a.pulse);
    gl.uniform1f(uF.u_ink, ink);
    gl.uniform3fv(uF.u_accent, accent);
    gl.uniform3fv(uF.u_accent2, accent2);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aSeed);
    void dt;
  });

  return {
    supported: true,
    canvas,
    setEnabled(next) {
      on = !!next;
      canvas.classList.toggle('is-off', !on);
      if (!on && w && h) { gl.clear(gl.COLOR_BUFFER_BIT); }
    },
    /** 1 in the app, higher on the immersive stage. */
    setIntensity(v) { intensity = Math.max(0, Math.min(2.4, v)); },
    destroy() { stop(); ro.disconnect(); canvas.remove(); },
  };
}
