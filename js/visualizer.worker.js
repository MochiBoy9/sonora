/* visualizer.worker.js — the spectrum, drawn off the main thread.
 *
 * Holds an OffscreenCanvas transferred from the page and draws into it with
 * the same renderer the main thread uses (visualizer-draw.js). There is no
 * second copy of the drawing here and there must never be one: see the note at
 * the top of that file.
 *
 * What crosses the boundary each frame is one packed Float32Array of band and
 * peak values plus a handful of scalars — about a kilobyte, transferred rather
 * than cloned. What does *not* cross is the drawing itself, which is the whole
 * point: on a full-screen visualiser that is a few milliseconds a frame taken
 * off the thread that also has to answer scrolling.
 *
 * The analyser stays on the main thread because that is where the
 * AudioContext is. Reading it is cheap; drawing what it says is not.
 */

import { createRenderer } from './visualizer-draw.js';

let renderer = null;
let ctx = null;
let canvas = null;
let bandCount = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;

  switch (m.type) {
    case 'init': {
      canvas = m.canvas;
      ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) { self.postMessage({ type: 'failed', why: 'no 2d context' }); return; }
      renderer = createRenderer(ctx, m.opts || {});
      bandCount = m.bandCount || 64;
      renderer.setSize(canvas.width, canvas.height, m.dpr || 1);
      self.postMessage({ type: 'ready' });
      return;
    }

    case 'size': {
      if (!canvas || !renderer) return;
      canvas.width = m.w;
      canvas.height = m.h;
      renderer.setSize(m.w, m.h, m.dpr);
      return;
    }

    case 'colours':
      renderer?.setColours(m.accent, m.art);
      return;

    case 'mode':
      renderer?.setMode(m.mode);
      return;

    case 'focus':
      renderer?.setFocus(m.x, m.y);
      return;

    case 'still':
      renderer?.still();
      return;

    case 'frame': {
      if (!renderer) return;
      /* The packed layout, unpacked. Bands and peaks are one buffer because
         two transfers cost two round trips through the structured clone
         algorithm for no benefit — they are always sent together and always
         the same length. */
      const packed = new Float32Array(m.packed);
      const bands = packed.subarray(0, bandCount);
      const peaks = packed.subarray(bandCount, bandCount * 2);
      renderer.frame({
        bands, peaks,
        wave: m.wave ? new Uint8Array(m.wave) : null,
        level: m.level, bass: m.bass, pulse: m.pulse,
        live: m.live, idle: m.idle,
      }, m.dt, m.now);
      return;
    }

    default:
  }
};
