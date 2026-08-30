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
import { program, uniforms, staticBuffer, mat4, gridLines, icosahedronLines, ringLines, sphereLines } from './gl.js';

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
uniform float u_time, u_level, u_bass, u_alpha, u_ink, u_room, u_pulse;
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

  /* The room answering the record.
   *
   * u_room is 0 behind the interface and 1 on the immersive stage, and the
   * difference is deliberate rather than a matter of taste. The album colour
   * belongs beside its own artwork; behind a library of four hundred other
   * covers it is just a tint on somebody else's record, so out there the room
   * stays the instrument's own cyan and only the floor picks up the album. On
   * the stage there is one record on screen and the whole room is allowed to
   * be about it.
   *
   * Two things happen at once: a second wash comes down from above in the
   * album's colour, and the light on the horizon bends from the accent towards
   * it. Both breathe with the level, so the room is lit by the music rather
   * than merely coloured by it. */
  float ceiling = smoothstep(0.52, 1.06, uv.y) * (0.10 + u_level * 0.34) * u_room;
  float sides = (1.0 - smoothstep(0.0, 0.62, abs(p.x))) * 0.0
              + smoothstep(0.52, 1.15, abs(p.x)) * (0.06 + u_bass * 0.20) * u_room;
  vec3 lightCol = mix(u_accent, u_art, 0.55 * u_room);

  /* Light shafts, rising out of the horizon.
   *
   * The one thing this room never had was air. A glow on the horizon reads as
   * a light source; beams coming off it read as a *space* with something in it
   * for the light to pass through, and that is most of the difference between
   * a gradient and a place.
   *
   * Not a volumetric integration — that means marching a ray per pixel, and
   * this shader has a 16.7 ms budget it shares with the whole interface. It is
   * a fan of beams in polar coordinates around the light, which is what a
   * volumetric pass through a dusty room produces anyway. The angular jitter
   * is what stops it looking like a starburst filter: real shafts are uneven,
   * because whatever is occluding the light is uneven.
   */
  vec2 lp = vec2(p.x, uv.y - horizon);
  float ang = atan(lp.y, lp.x);
  float rad = length(lp);
  float beams = 0.0;
  // Three sets at different frequencies, drifting at different speeds: the
  // interference between them is what keeps any one of them from reading as a
  // pattern.
  beams += pow(max(0.0, sin(ang * 9.0 + u_time * 0.13)), 7.0) * 0.55;
  beams += pow(max(0.0, sin(ang * 14.0 - u_time * 0.09 + 1.7)), 9.0) * 0.35;
  beams += pow(max(0.0, sin(ang * 5.0 + u_time * 0.05 + 3.1)), 5.0) * 0.30;
  // Only above the horizon, only near it, and fading out into the distance.
  beams *= smoothstep(-0.02, 0.30, lp.y) * exp(-rad * 1.7);
  // They breathe with the music and flare on a beat, which is the moment the
  // room most wants to be doing something.
  beams *= 0.35 + u_level * 1.5 + u_pulse * 0.9;

  vec3 col = lightCol * (glow + beams) + u_art * (floorWash + ceiling + sides);

  // Scanlines: one pixel in three, at the edge of perception.
  float scan = 0.965 + 0.035 * sin(gl_FragCoord.y * 1.6);
  col *= scan;

  float vignette = smoothstep(1.35, 0.15, length(p));
  float a = clamp(((glow + beams * 0.8) * 0.5 + (floorWash + ceiling + sides) * 0.7) * vignette * u_alpha,
                  0.0, mix(0.92, 0.2, u_ink));
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
  } else if (u_mode > 2.5) {
    // A bubble: it breathes, and it is squashed a little as it rises, the way
    // a real one is by the water it is pushing out of the way.
    float squash = 1.0 + sin(u_time * 1.7 + u_span) * 0.035 + u_bass * 0.07;
    p.xz *= squash;
    p.y /= squash;
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

/* Bubbles get their own fragment stage: the same line, but brighter towards
   the top of the sphere, which is the one cue that makes a wireframe ball
   read as something with a wet surface rather than as a wire ball. */
const FRAG_BUBBLE = `
precision mediump float;
varying mediump float v_fade;
varying mediump float v_seed;
uniform vec3 u_color, u_color2;
uniform float u_alpha;

void main() {
  float lift = pow(v_seed, 1.6);
  vec3 col = mix(u_color, u_color2, 0.25 + lift * 0.75);
  float a = v_fade * u_alpha * (0.30 + lift * 1.05);
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

  const dead = {
    supported: false, canvas: null,
    setEnabled() {}, setIntensity() {}, setLook() {}, destroy() {},
  };
  if (!gl) { canvas.remove(); return dead; }

  const sky = program(gl, VERT_QUAD, FRAG_SKY);
  const lines = program(gl, VERT_LINES, FRAG_LINES);
  const bubbles = program(gl, VERT_LINES, FRAG_BUBBLE);
  if (!sky || !lines || !bubbles) { canvas.remove(); return dead; }

  const uSky = uniforms(gl, sky, ['u_res', 'u_time', 'u_level', 'u_bass', 'u_alpha', 'u_ink', 'u_accent', 'u_art', 'u_room', 'u_pulse']);
  const LINE_UNIFORMS = ['u_mvp', 'u_time', 'u_bass', 'u_level', 'u_mode', 'u_span',
                         'u_pulse', 'u_color', 'u_color2', 'u_alpha'];
  const uLin = uniforms(gl, lines, LINE_UNIFORMS);
  const uBub = uniforms(gl, bubbles, LINE_UNIFORMS);
  // How much the music brightens the lines. Folded in on this side so the two
  // stages share no uniform at all.
  const lit = (base, a) => base * (0.55 + a * 0.7);

  const quad = staticBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3]), 2);
  const GRID_DEPTH = 48;
  const grid = staticBuffer(gl, gridLines({ half: 18, depth: GRID_DEPTH, step: 2.2, segs: 24 }), 4);
  const RING_SPAN = 46;
  const rings = staticBuffer(gl, ringLines({ count: 10, size: 7.4, spacing: RING_SPAN / 10 }), 4);
  const solid = staticBuffer(gl, icosahedronLines(1), 4);
  // One bubble, drawn several times. Seven draw calls of a small buffer is
  // cheaper than one big buffer that has to be rebuilt when the count changes.
  const bubble = staticBuffer(gl, sphereLines(1, { lat: 4, lon: 7, segs: 20 }), 4);
  const BUBBLES = [
    { x: -4.6, z: -9,  r: 0.62, speed: 0.19, sway: 1.3, phase: 0.0 },
    { x: 5.2,  z: -12, r: 0.94, speed: 0.13, sway: 0.9, phase: 1.7 },
    { x: -2.1, z: -17, r: 1.35, speed: 0.09, sway: 1.7, phase: 3.1 },
    { x: 6.8,  z: -21, r: 1.9,  speed: 0.07, sway: 1.1, phase: 4.4 },
    { x: -7.4, z: -24, r: 1.5,  speed: 0.10, sway: 2.0, phase: 5.6 },
    { x: 1.4,  z: -28, r: 2.4,  speed: 0.05, sway: 1.4, phase: 2.3 },
    { x: -1.2, z: -6,  r: 0.34, speed: 0.26, sway: 0.7, phase: 0.9 },
  ];

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
  /* How much the room belongs to the album rather than to the instrument.
     Eased rather than switched: the stage opens over a third of a second and a
     room that changed colour instantly would read as a bug. */
  let room = 0, roomTarget = 0;
  let accent = DEFAULT_ACCENT.map((v) => v / 255);
  let art = DEFAULT_ART.map((v) => v / 255);
  let accentAt = 0;
  let intensity = 1;
  let on = enabled;

  /* What the look asks the world to be. Each scene is a subset of the same
     passes rather than a different renderer, so switching between them costs
     nothing and cannot get out of step with the rest. */
  const SCENES = {
    world:  { sky: 1, grid: 1, rings: 1, solid: 1, bubbles: 1 },
    tunnel: { sky: 1, grid: 0, rings: 1, solid: 1, bubbles: 1 },
    grid:   { sky: 1, grid: 1, rings: 0, solid: 0, bubbles: 0 },
    still:  { sky: 1, grid: 0, rings: 0, solid: 0, bubbles: 0 },
    off:    { sky: 0, grid: 0, rings: 0, solid: 0, bubbles: 0 },
  };
  let scene = SCENES.world;
  let sceneName = 'world';
  let depth = 0.7;
  let wantBubbles = true;
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
    // Eased towards the target, so opening the stage brings the room up over
    // about half a second rather than repainting it between two frames.
    if (room !== roomTarget) {
      room += (roomTarget - room) * Math.min(1, dt / 260);
      if (Math.abs(roomTarget - room) < 0.002) room = roomTarget;
      staticKey = '';
    }
    resize();
    if (!w || !h) return;

    const a = player.analysis();
    const still = reduceMotion.matches;
    const t = still ? 8 : (now - t0) / 1000;
    const light = document.documentElement.getAttribute('data-theme') === 'light' ||
      (!document.documentElement.getAttribute('data-theme') &&
        matchMedia('(prefers-color-scheme: light)').matches);
    const alpha = intensity * (light ? 0.55 : 1.25) * (0.35 + depth * 0.93);
    const ink = light ? 1 : 0;

    if (still || sceneName === 'still') {
      const key = `${w}x${h}|${accent.join()}|${art.join()}|${alpha}|${sceneName}`;
      if (key === staticKey) return;                  // already on screen
      staticKey = key;
    } else staticKey = '';

    gl.clear(gl.COLOR_BUFFER_BIT);

    /* -- sky ------------------------------------------------------------ */
    gl.useProgram(sky);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad.buf);
    gl.enableVertexAttribArray(aXY);
    gl.vertexAttribPointer(aXY, 2, gl.FLOAT, false, 0, 0);
    if (!scene.sky) { gl.disableVertexAttribArray(aXY); return; }
    gl.uniform2f(uSky.u_res, w, h);
    gl.uniform1f(uSky.u_time, t);
    gl.uniform1f(uSky.u_level, a.level);
    gl.uniform1f(uSky.u_bass, a.bass);
    gl.uniform1f(uSky.u_alpha, alpha);
    gl.uniform1f(uSky.u_ink, ink);
    gl.uniform1f(uSky.u_room, room);
    gl.uniform1f(uSky.u_pulse, a.pulse);
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
    if (scene.grid) {
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
    }

    /* -- rings ---------------------------------------------------------- */
    if (scene.rings) {
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
    }

    /* -- the solid ------------------------------------------------------ */
    if (scene.solid) {
    /* Drawn twice: once above the plane, once mirrored below it.
     *
     * A wet floor is the cheapest possible way to make a room read as a room,
     * because a reflection is the one cue that says the ground is a *surface*
     * rather than the place the geometry happens to stop. Here it costs one
     * extra draw of eighty lines.
     *
     * It is a real mirror rather than a blurred copy: the model is scaled by
     * -1 in Y about the ground plane, so the reflection moves correctly when
     * the object does and is never a frame behind it. What sells it is not the
     * geometry but the falloff — a reflection at the same brightness as its
     * object looks like a second object, so it is drawn at a fifth and the
     * distance fade in the vertex stage does the rest.
     */
    const s = 1.5 + a.level * 0.5 + a.pulse * 0.12;
    const HEIGHT = 3.5;
    for (const mirror of [false, true]) {
      mat4.identity(model);
      // Reflected in the plane y = 0, which is where the grid is: an object at
      // height h appears at -h, and the whole thing is turned upside down.
      mat4.translate(model, 3.1, mirror ? -HEIGHT : HEIGHT, -13);
      mat4.rotateY(model, t * 0.22);
      mat4.rotateX(model, t * 0.13);
      mat4.scale(model, s, mirror ? -s : s, s);
      mat4.multiply(mvp, view, model);
      mat4.multiply(mvp, proj, mvp);
      gl.uniformMatrix4fv(uLin.u_mvp, false, mvp);
      gl.uniform1f(uLin.u_mode, 2);                  // no displacement
      gl.uniform1f(uLin.u_alpha, lit(alpha * (mirror ? 0.15 : 0.7), a.level));
      bindLines(solid);
      gl.drawArrays(gl.LINES, 0, solid.count);
    }
    }

    /* -- bubbles -------------------------------------------------------- */
    // The aero half of the picture: wireframe spheres rising through the
    // scene, each on its own clock so they never fall into step.
    if (scene.bubbles && wantBubbles) {
      gl.useProgram(bubbles);
      gl.uniform1f(uBub.u_time, t);
      gl.uniform1f(uBub.u_bass, a.bass);
      gl.uniform1f(uBub.u_level, a.level);
      gl.uniform1f(uBub.u_pulse, a.pulse);
      gl.uniform1f(uBub.u_mode, 3);
      gl.uniform3fv(uBub.u_color, accent);
      gl.uniform3fv(uBub.u_color2, art);
      bindLines(bubble);

      for (const b of BUBBLES) {
        // Rise, wrap, and drift sideways. `u_span` doubles as the per-bubble
        // phase for the breathing in the vertex stage — one fewer uniform.
        const y = ((t * b.speed + b.phase) % 1) * 15 - 4.2;
        const sway = Math.sin(t * b.speed * 2.4 + b.phase) * b.sway;
        const fadeIn = Math.min(1, (y + 4.2) / 2.4);
        const fadeOut = Math.min(1, (10.8 - y) / 3.4);
        mat4.identity(model);
        mat4.translate(model, b.x + sway, y, b.z);
        const r = b.r * (1 + a.level * 0.10);
        mat4.scale(model, r, r, r);
        mat4.multiply(mvp, view, model);
        mat4.multiply(mvp, proj, mvp);
        gl.uniformMatrix4fv(uBub.u_mvp, false, mvp);
        gl.uniform1f(uBub.u_span, b.phase);
        gl.uniform1f(uBub.u_alpha,
          lit(alpha * 0.30, a.level) * Math.max(0, fadeIn) * Math.max(0, fadeOut));
        gl.drawArrays(gl.LINES, 0, bubble.count);
      }
    }

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
    /** Everything the look has to say about the world behind the interface. */
    setLook(look) {
      if (!look) return;
      sceneName = SCENES[look.scene] ? look.scene : 'world';
      scene = SCENES[sceneName];
      depth = Math.max(0, Math.min(1, (look.depth ?? 70) / 100));
      wantBubbles = look.bubbles !== false;
      staticKey = '';
    },
    /** 1 in the app, higher on the immersive stage. */
    setIntensity(v) {
      intensity = Math.max(0, Math.min(2.4, v));
      staticKey = '';
    },
    /**
     * How much the room belongs to the album rather than to the instrument.
     *
     * 0 behind the interface and 1 on the immersive stage. The album colour
     * belongs beside its own artwork: behind a library of four hundred other
     * covers it is a tint on somebody else's record, and only on the stage —
     * where there is one record on screen — is the whole room allowed to be
     * about it.
     */
    setRoom(v) {
      roomTarget = Math.max(0, Math.min(1, v));
      staticKey = '';
    },
    destroy() { stop(); ro.disconnect(); canvas.remove(); },
  };
}
