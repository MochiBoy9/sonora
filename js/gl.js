/* gl.js — the smallest WebGL layer that can draw a wireframe world.
 *
 * Two consumers: the backdrop behind the app and the intro's opening scene.
 * Both draw the same way — lines in 3D, projected properly, with a fullscreen
 * gradient behind them — so the machinery lives here once: shader compilation,
 * a column-major 4×4 matrix stack, and geometry builders for the grid, the
 * icosahedron and the tunnel rings.
 *
 * No dependency and no abstraction beyond what these two scenes need. Every
 * matrix routine writes into a caller-owned Float32Array, so a frame allocates
 * nothing.
 */

/* ------------------------------------------------------------------ shaders */

export function compile(gl, type, src) {
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

export function program(gl, vertSrc, fragSrc) {
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
export function uniforms(gl, prog, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

/** Uploads a Float32Array as a static buffer and reports its vertex count. */
export function staticBuffer(gl, data, stride) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return { buf, count: data.length / stride };
}

/* ------------------------------------------------------------------ matrices */

/**
 * Column-major 4×4, the layout WebGL wants. Every function mutates `out`,
 * which is how a render loop stays allocation-free.
 */
export const mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  identity(out) {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
  },

  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  },

  /** out = a * b, with aliasing allowed. */
  multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      tmp[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      tmp[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      tmp[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      tmp[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    out.set(tmp);
    return out;
  },

  translate(out, x, y, z) {
    out[12] += out[0] * x + out[4] * y + out[8] * z;
    out[13] += out[1] * x + out[5] * y + out[9] * z;
    out[14] += out[2] * x + out[6] * y + out[10] * z;
    out[15] += out[3] * x + out[7] * y + out[11] * z;
    return out;
  },

  scale(out, x, y, z) {
    out[0] *= x; out[1] *= x; out[2] *= x; out[3] *= x;
    out[4] *= y; out[5] *= y; out[6] *= y; out[7] *= y;
    out[8] *= z; out[9] *= z; out[10] *= z; out[11] *= z;
    return out;
  },

  rotateX(out, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a4 = out[4], a5 = out[5], a6 = out[6], a7 = out[7];
    const a8 = out[8], a9 = out[9], a10 = out[10], a11 = out[11];
    out[4] = a4 * c + a8 * s;   out[5] = a5 * c + a9 * s;
    out[6] = a6 * c + a10 * s;  out[7] = a7 * c + a11 * s;
    out[8] = a8 * c - a4 * s;   out[9] = a9 * c - a5 * s;
    out[10] = a10 * c - a6 * s; out[11] = a11 * c - a7 * s;
    return out;
  },

  rotateY(out, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a0 = out[0], a1 = out[1], a2 = out[2], a3 = out[3];
    const a8 = out[8], a9 = out[9], a10 = out[10], a11 = out[11];
    out[0] = a0 * c - a8 * s;   out[1] = a1 * c - a9 * s;
    out[2] = a2 * c - a10 * s;  out[3] = a3 * c - a11 * s;
    out[8] = a0 * s + a8 * c;   out[9] = a1 * s + a9 * c;
    out[10] = a2 * s + a10 * c; out[11] = a3 * s + a11 * c;
    return out;
  },

  rotateZ(out, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a0 = out[0], a1 = out[1], a2 = out[2], a3 = out[3];
    const a4 = out[4], a5 = out[5], a6 = out[6], a7 = out[7];
    out[0] = a0 * c + a4 * s;  out[1] = a1 * c + a5 * s;
    out[2] = a2 * c + a6 * s;  out[3] = a3 * c + a7 * s;
    out[4] = a4 * c - a0 * s;  out[5] = a5 * c - a1 * s;
    out[6] = a6 * c - a2 * s;  out[7] = a7 * c - a3 * s;
    return out;
  },
};

const tmp = new Float32Array(16);

/* ------------------------------------------------------------------ geometry */

/**
 * A ground plane of lines running to the horizon, subdivided along its length
 * so the vertex shader has something to ripple. Returns interleaved
 * [x, y, z, seed] — seed is a per-vertex 0..1 used to vary the wave.
 *
 * @param half     half-width in world units
 * @param depth    how far back the plane runs
 * @param step     spacing between lines
 * @param segs     subdivisions per line
 */
export function gridLines({ half = 16, depth = 46, step = 2, segs = 26 } = {}) {
  const out = [];
  const push = (x, z) => { out.push(x, 0, z, ((x * 12.9898 + z * 78.233) % 1 + 1) % 1); };

  // Lines running away from the camera.
  for (let x = -half; x <= half; x += step) {
    for (let i = 0; i < segs; i++) {
      const z0 = -depth + (i / segs) * depth;
      const z1 = -depth + ((i + 1) / segs) * depth;
      push(x, z0); push(x, z1);
    }
  }
  // Lines running across it.
  for (let i = 0; i <= segs; i++) {
    const z = -depth + (i / segs) * depth;
    for (let x = -half; x < half; x += step) {
      push(x, z); push(x + step, z);
    }
  }
  return new Float32Array(out);
}

/**
 * Icosahedron edges as line pairs, interleaved [x, y, z, seed]. Twelve
 * vertices, thirty edges: the cheapest solid that still reads as a sphere.
 */
export function icosahedronLines(radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const norm = Math.sqrt(1 + t * t);
  for (const p of v) { p[0] = p[0] / norm * radius; p[1] = p[1] / norm * radius; p[2] = p[2] / norm * radius; }

  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const seen = new Set();
  const out = [];
  for (const f of faces) {
    for (let i = 0; i < 3; i++) {
      const a = f[i], b = f[(i + 1) % 3];
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(key)) continue;             // each edge belongs to two faces
      seen.add(key);
      out.push(v[a][0], v[a][1], v[a][2], a / 12);
      out.push(v[b][0], v[b][1], v[b][2], b / 12);
    }
  }
  return new Float32Array(out);
}

/** Concentric square rings stacked along z — the tunnel. */
export function ringLines({ count = 9, size = 7, spacing = 4.6 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const z = -i * spacing;
    const s = size * (1 + i * 0.06);
    const seed = i / count;
    const corners = [[-s, -s], [s, -s], [s, s], [-s, s]];
    for (let c = 0; c < 4; c++) {
      const a = corners[c], b = corners[(c + 1) % 4];
      out.push(a[0], a[1], z, seed);
      out.push(b[0], b[1], z, seed);
    }
  }
  return new Float32Array(out);
}

/**
 * Five upright bars in a row — the wordmark, in three dimensions. Each bar is
 * a wireframe box, and `heights` decides how tall each one stands.
 */
export function barsLines(heights, { width = 0.42, gap = 0.34, depth = 0.42 } = {}) {
  const out = [];
  const n = heights.length;
  const span = n * width + (n - 1) * gap;
  let x = -span / 2;

  for (let i = 0; i < n; i++) {
    const h = heights[i];
    const x0 = x, x1 = x + width;
    const y0 = 0, y1 = h;
    const z0 = -depth / 2, z1 = depth / 2;
    const seed = i / n;
    const corner = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],          // front face
      [4, 5], [5, 6], [6, 7], [7, 4],          // back face
      [0, 4], [1, 5], [2, 6], [3, 7],          // the joins
    ];
    for (const [a, b] of edges) {
      out.push(corner[a][0], corner[a][1], corner[a][2], seed);
      out.push(corner[b][0], corner[b][1], corner[b][2], seed);
    }
    x += width + gap;
  }
  return new Float32Array(out);
}
