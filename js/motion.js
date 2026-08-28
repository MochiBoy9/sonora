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

/* Easings tuned to feel like physical motion rather than linear interpolation. */
export const ease = {
  out:      'cubic-bezier(.22, 1, .36, 1)',      // quintic settle — the workhorse
  inOut:    'cubic-bezier(.65, 0, .35, 1)',
  soft:     'cubic-bezier(.33, 1, .68, 1)',
  overshoot:'cubic-bezier(.34, 1.4, .64, 1)',
  snap:     'cubic-bezier(.16, 1, .3, 1)',
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

/** Fade + rise, staggered. The signature move of the whole UI. */
export function enter(nodes, { each = 26, delay = 0, y = 10, duration = 420 } = {}) {
  const list = nodes instanceof Element ? [nodes] : Array.from(nodes);
  const cap = Math.min(list.length, 24);            // never pay for offscreen work
  for (let i = 0; i < cap; i++) {
    animate(list[i],
      { opacity: [0, 1], transform: [`translate3d(0,${y}px,0)`, 'translate3d(0,0,0)'] },
      { duration, delay: delay + i * each, easing: ease.out });
  }
  for (let i = cap; i < list.length; i++) list[i].style.opacity = '1';
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
