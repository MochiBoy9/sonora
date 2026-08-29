/* motion.js — ~3kb animation core.
 *
 * Three ideas borrowed from the good libraries:
 *   · motion.dev  — springs described by feel (bounce/duration), not by physics constants
 *   · anime.js    — one global ticker, staggered timelines
 *   · WAAPI       — hand keyframes to the compositor whenever we can
 *
 * Everything here animates transform/opacity/filter only, so nothing we do
 * can trigger layout. Springs run on the shared loop; there is never more
 * than one requestAnimationFrame in flight for the whole app.
 */

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* Easings tuned to feel like machinery rather than linear interpolation: quick
   to leave, long to arrive. `step` is the odd one out — it accelerates and
   decelerates hard, which is what a wipe or a shutter wants. */
export const ease = {
  out:      'cubic-bezier(.2, .9, .25, 1)',      // the workhorse
  inOut:    'cubic-bezier(.65, 0, .35, 1)',
  soft:     'cubic-bezier(.33, 1, .68, 1)',
  overshoot:'cubic-bezier(.3, 1.5, .6, 1)',
  back:     'cubic-bezier(.3, 1.5, .6, 1)',      // alias, reads better in place
  snap:     'cubic-bezier(.16, 1, .3, 1)',
  step:     'cubic-bezier(.85, 0, .15, 1)',
};

/* ------------------------------------------------------------------ ticker */

const tasks = new Set();
let running = false, last = 0;

function loop(now) {
  const dt = last ? Math.min(64, now - last) : 16.7;   // clamp after tab-switch
  last = now;
  for (const task of tasks) {
    if (task(dt, now) === false) tasks.delete(task);
  }
  if (tasks.size) requestAnimationFrame(loop);
  else { running = false; last = 0; }
}

/** Register a per-frame callback. Return false from it (or call the returned fn) to stop. */
export function tick(fn) {
  tasks.add(fn);
  if (!running) { running = true; requestAnimationFrame(loop); }
  return () => tasks.delete(fn);
}

/* ------------------------------------------------------------------ springs */

/**
 * Critically-ish damped spring solved with semi-implicit Euler at a fixed
 * 1/240s substep, so behaviour is identical regardless of display refresh rate.
 *
 *   spring({ from, to, stiffness, damping, onUpdate })
 *
 * Returns a handle whose `.to` can be reassigned mid-flight — the spring
 * retargets without losing velocity, which is what makes dragging feel alive.
 */
export function spring({ from = 0, to = 1, stiffness = 170, damping = 26, mass = 1,
                         restDelta = 0.002, onUpdate, onComplete }) {
  let value = from, velocity = 0, target = to, done = false;

  if (reduceMotion.matches) {
    onUpdate?.(target);
    onComplete?.();
    return { get value() { return target; }, set to(v) { target = v; onUpdate?.(v); }, stop() {} };
  }

  const stop = tick((dt) => {
    let steps = Math.ceil(dt / 4.1666);              // 240 Hz substeps
    const h = (dt / steps) / 1000;
    while (steps--) {
      const force = -stiffness * (value - target) - damping * velocity;
      velocity += (force / mass) * h;
      value += velocity * h;
    }
    if (Math.abs(value - target) < restDelta && Math.abs(velocity) < restDelta * 60) {
      value = target; velocity = 0; done = true;
      onUpdate?.(value); onComplete?.();
      return false;
    }
    onUpdate?.(value);
  });

  return {
    get value() { return value; },
    get velocity() { return velocity; },
    set to(v) { target = v; if (done) { done = false; } },
    get to() { return target; },
    stop,
  };
}

/* ------------------------------------------------------------------ WAAPI */

const DEFAULTS = { duration: 380, easing: ease.out, fill: 'both' };

/**
 * Waits for an exit animation, but never forever.
 *
 * `anim.finished` resolves on the event loop, so on a machine that is dropping
 * frames — a software renderer, a busy tab — a 260ms animation can settle
 * hundreds of milliseconds late, and anything waiting to remove a node waits
 * with it. The timeout is the guarantee: the node comes out either way.
 */
export function settled(anim, duration) {
  const timeout = new Promise((r) => setTimeout(r, duration + 260));
  if (!anim) return timeout;
  return Promise.race([anim.finished.catch(() => {}), timeout]);
}

/** animate(el, {opacity:[0,1], transform:['translateY(8px)','none']}, {duration, delay}) */
export function animate(node, keyframes, opts = {}) {
  if (!node) return null;
  const o = { ...DEFAULTS, ...opts };
  if (reduceMotion.matches) { o.duration = 0; o.delay = 0; }
  const anim = node.animate(keyframes, o);
  if (o.commit !== false) {
    anim.finished.then(() => { try { anim.commitStyles(); anim.cancel(); } catch {} }).catch(() => {});
  }
  return anim;
}

/**
 * Fade + rise, staggered — the signature move of the whole UI.
 *
 * `wipe` adds a clip-path reveal from the leading edge, which is what makes a
 * panel look drawn rather than faded in. It is only applied when the caller
 * asks, because clip-path on a large subtree is not free.
 */
export function enter(nodes, { each = 24, delay = 0, y = 10, duration = 460, wipe = false } = {}) {
  const list = nodes instanceof Element ? [nodes] : Array.from(nodes);
  const cap = Math.min(list.length, 24);            // never pay for offscreen work
  for (let i = 0; i < cap; i++) {
    const frames = {
      opacity: [0, 1],
      transform: [`translate3d(0,${y}px,0)`, 'translate3d(0,0,0)'],
    };
    if (wipe) frames.clipPath = ['inset(0 100% 0 0)', 'inset(0 0% 0 0)'];
    animate(list[i], frames, { duration, delay: delay + i * each, easing: ease.out });
  }
  for (let i = cap; i < list.length; i++) list[i].style.opacity = '1';
}

/**
 * Text that resolves out of noise, one character at a time. Borrowed from the
 * way anime.js treats text as a list of targets rather than as a string: the
 * element's own text is restored exactly, so this is safe on anything.
 *
 * Returns a stop function; call it to jump straight to the finished text.
 */
const SCRAMBLE = '▚▞▛▜▟▙/\\<>_-=+*#%$&0123456789';

export function scramble(node, text, { duration = 640, settle = 0.55 } = {}) {
  if (!node) return () => {};
  const final = text == null ? node.textContent : String(text);
  if (reduceMotion.matches || !final) { node.textContent = final; return () => {}; }

  const chars = [...final];
  const start = performance.now();
  let stopped = false;

  const stop = tick((dt, now) => {
    if (stopped) return false;
    const p = Math.min(1, (now - start) / duration);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      // Each character locks in at its own moment, left to right.
      const at = (i / chars.length) * settle;
      const local = (p - at) / Math.max(0.0001, 1 - settle);
      if (chars[i] === ' ' || local >= 1) out += chars[i];
      else if (local <= 0) out += ' ';
      else out += SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
    }
    node.textContent = out;
    if (p >= 1) { node.textContent = final; return false; }
    void dt;
  });

  return () => { stopped = true; stop(); node.textContent = final; };
}

/**
 * Pointer-tracked 3D tilt. The element turns toward the cursor on a spring and
 * returns when the pointer leaves; the parent supplies the perspective.
 *
 * Returns a teardown.
 */
export function tilt3d(node, { max = 9, lift = 14, scale = 1.02 } = {}) {
  if (!node || reduceMotion.matches) return () => {};
  let rx = 0, ry = 0, z = 0;
  const write = () => {
    node.style.transform =
      `translate3d(0,0,${z.toFixed(2)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)` +
      (z > 0.5 ? ` scale(${scale})` : '');
  };
  const sx = spring({ from: 0, to: 0, stiffness: 210, damping: 22, onUpdate: (v) => { rx = v; write(); } });
  const sy = spring({ from: 0, to: 0, stiffness: 210, damping: 22, onUpdate: (v) => { ry = v; write(); } });
  const sz = spring({ from: 0, to: 0, stiffness: 190, damping: 24, onUpdate: (v) => { z = v; write(); } });

  // The box is measured once per hover, not once per move: reading it inside
  // pointermove forces a layout on every event, and a grid of these turns a
  // sweep of the cursor into a sweep of reflows.
  let box = null;
  const onEnter = () => { box = node.getBoundingClientRect(); };
  const onMove = (e) => {
    if (!box) box = node.getBoundingClientRect();
    if (!box.width) return;
    sy.to = ((e.clientX - box.left) / box.width - 0.5) * 2 * max;
    sx.to = -((e.clientY - box.top) / box.height - 0.5) * 2 * max;
    sz.to = lift;
  };
  const onLeave = () => { box = null; sx.to = 0; sy.to = 0; sz.to = 0; };

  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('pointercancel', onLeave);

  return () => {
    node.removeEventListener('pointerenter', onEnter);
    node.removeEventListener('pointermove', onMove);
    node.removeEventListener('pointerleave', onLeave);
    node.removeEventListener('pointercancel', onLeave);
    sx.stop(); sy.stop(); sz.stop();
    node.style.transform = '';
  };
}

/**
 * Rolls a number up to its value. Integers only — this is for counts, and a
 * count that flickers through decimals looks broken.
 */
export function countTo(node, value, { duration = 900, format = (n) => n.toLocaleString() } = {}) {
  if (!node) return () => {};
  if (reduceMotion.matches) { node.textContent = format(value); return () => {}; }
  const start = performance.now();
  const stop = tick((dt, now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = format(Math.round(value * eased));
    if (p >= 1) return false;
    void dt;
  });
  return stop;
}

/* ------------------------------------------------------------------ gestures */

/**
 * Pointer drag on a track (seek bar, volume). Reports 0..1 progress and
 * captures the pointer so the drag survives leaving the element.
 */
export function draggable(node, { onStart, onMove, onEnd, axis = 'x' } = {}) {
  let active = false;

  const ratio = (e) => {
    const r = node.getBoundingClientRect();
    return axis === 'x'
      ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      : Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
  };

  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active = true;
    node.setPointerCapture(e.pointerId);
    node.classList.add('is-dragging');
    onStart?.(ratio(e));
    onMove?.(ratio(e));
    e.preventDefault();
  });

  node.addEventListener('pointermove', (e) => {
    if (active) onMove?.(ratio(e));
    else node.style.setProperty('--hover', ratio(e));
  });

  const finish = (e) => {
    if (!active) return;
    active = false;
    node.classList.remove('is-dragging');
    try { node.releasePointerCapture(e.pointerId); } catch {}
    onEnd?.(ratio(e));
  };
  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);

  return () => { active = false; };
}
