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

/**
 * animate(el, {opacity:[0,1], transform:['translateY(8px)','none']}, {duration, delay})
 *
 * `commit` decides what happens at the end, and the choice matters more than
 * it looks:
 *
 *   true (default) — write the final values inline and cancel. For an
 *     animation whose end state is *not* what the stylesheet would say.
 *   'release'      — cancel without writing anything, handing the element back
 *     to CSS. This is what an entrance wants: an arrival ends where the
 *     stylesheet already had the thing, so committing only leaves an inline
 *     `transform: translate3d(0,0,0)` sitting on top of it — which then beats
 *     every `:hover` rule that wanted to move it, for the life of the page.
 *     That is exactly how the card lift went missing.
 *   false          — leave the fill in place. For exits, where the node is
 *     about to be removed and there is nothing to hand back to.
 */
export function animate(node, keyframes, opts = {}) {
  if (!node) return null;
  const o = { ...DEFAULTS, ...opts };
  if (reduceMotion.matches) { o.duration = 0; o.delay = 0; }
  const anim = node.animate(keyframes, o);
  if (o.commit === 'release') {
    anim.finished.then(() => { try { anim.cancel(); } catch {} }).catch(() => {});
  } else if (o.commit !== false) {
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
export function enter(nodes, { each = 24, delay = 0, y = 10, z = 0, duration = 460, wipe = false } = {}) {
  const list = nodes instanceof Element ? [nodes] : Array.from(nodes);
  const cap = Math.min(list.length, 24);            // never pay for offscreen work
  for (let i = 0; i < cap; i++) {
    const frames = {
      opacity: [0, 1],
      transform: [`translate3d(0,${y}px,${z}px)`, 'translate3d(0,0,0)'],
    };
    if (wipe) frames.clipPath = ['inset(0 100% 0 0)', 'inset(0 0% 0 0)'];
    // 'release': an arrival finishes where CSS already had the element, so it
    // hands the transform back instead of pinning one on top of it.
    animate(list[i], frames, { duration, delay: delay + i * each, easing: ease.out, commit: 'release' });
  }
  for (let i = cap; i < list.length; i++) list[i].style.opacity = '1';
}

/**
 * The same arrival, but held until the thing is actually on screen.
 *
 * An IntersectionObserver rather than a scroll listener, and that is the whole
 * point: the browser computes the crossing off the main thread and calls back
 * once per element, where a scroll handler would have us measure every card on
 * every frame — which is precisely the kind of per-frame work this app spent
 * an evening learning to keep out of the scroller.
 *
 * It fires once. A card that has arrived has arrived; re-playing it because it
 * scrolled past again is the tic that makes a page feel like a demo reel.
 */
export function reveal(nodes, { y = 22, z = -80, rotate = 4, duration = 760, each = 60, amount = 0.12 } = {}) {
  const list = nodes instanceof Element ? [nodes] : Array.from(nodes);
  if (!list.length) return () => {};
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    for (const n of list) n.style.opacity = '1';
    return () => {};
  }

  for (const n of list) n.style.opacity = '0';

  /* The failsafe, and it is not optional.
   *
   * Hiding content until an observer says otherwise means that if the observer
   * never runs, the content is gone — not un-animated, gone. An observer does
   * deliver one callback for every target it is given, intersecting or not, at
   * the first rendering opportunity; so if nothing at all has arrived after two
   * seconds, the machinery is not running and the right answer is to show
   * everything and forget the whole idea. Same reasoning as the CSS timer that
   * removes the intro if the scripts never arrive: an entrance is a nicety, and
   * a nicety may not be allowed to hold the page shut. */
  let heard = false;
  const failsafe = setTimeout(() => {
    if (heard) return;
    io.disconnect();
    for (const n of list) n.style.opacity = '1';
  }, 2000);

  // Everything crossing in the same callback is one wave, so the stagger is
  // counted per batch rather than per element: a card scrolled to on its own
  // should not wait for the delay its index in the list would have earned it.
  const io = new IntersectionObserver((entries) => {
    heard = true;
    clearTimeout(failsafe);
    let i = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const anim = animate(e.target, {
        opacity: [0, 1],
        transform: [
          `translate3d(0,${y}px,${z}px) rotateX(${rotate}deg)`,
          'translate3d(0,0,0) rotateX(0deg)',
        ],
      }, { duration, delay: i++ * each, easing: ease.out, commit: 'release' });
      // Order matters: the animation is created first, so its `fill: both`
      // is already holding frame zero before the inline opacity that was
      // hiding the element is taken away. The other way round is one frame
      // of the card at full brightness, which is a flash.
      e.target.style.removeProperty('opacity');
      if (!anim) e.target.style.opacity = '1';
    }
  }, { threshold: amount, rootMargin: '0px 0px -6% 0px' });

  for (const n of list) io.observe(n);
  return () => { clearTimeout(failsafe); io.disconnect(); };
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
 * It also publishes where the light is. `--tx` and `--ty` are the pointer's
 * position across the face, −1 to 1, and `--lit` is how engaged the surface is,
 * 0 to 1 — so a stylesheet can slide a specular highlight across the artwork
 * and darken the far edge without a second listener measuring the same pointer
 * a second time. Three custom properties on one element are free; the
 * alternative is a `mousemove` handler per effect.
 *
 * The whole thing is scaled by the Look's own `--parallax`, so "how far panels
 * lift off the world" governs the tilt as well as the rise, and turning Motion
 * down to Calm or None takes the tilt with it.
 *
 * Returns a teardown.
 */
export function tilt3d(node, { max = 9, lift = 14, scale = 1.02 } = {}) {
  if (!node || reduceMotion.matches) return () => {};

  let rx = 0, ry = 0, z = 0, gain = 1;
  const write = () => {
    node.style.transform =
      `translate3d(0,0,${z.toFixed(2)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)` +
      (z > 0.5 ? ` scale(${(1 + (scale - 1) * gain).toFixed(4)})` : '');
  };
  const sx = spring({ from: 0, to: 0, stiffness: 210, damping: 22, onUpdate: (v) => { rx = v; write(); } });
  const sy = spring({ from: 0, to: 0, stiffness: 210, damping: 22, onUpdate: (v) => { ry = v; write(); } });
  const sz = spring({ from: 0, to: 0, stiffness: 190, damping: 24, onUpdate: (v) => { z = v; write(); } });
  // The light follows on its own, slacker spring: a highlight that arrives a
  // beat after the surface it is on is what makes the surface read as heavy.
  const sl = spring({
    from: 0, to: 0, stiffness: 150, damping: 26,
    onUpdate: (v) => node.style.setProperty('--lit', v.toFixed(3)),
  });

  // The box is measured once per hover, not once per move: reading it inside
  // pointermove forces a layout on every event, and a grid of these turns a
  // sweep of the cursor into a sweep of reflows. The Look is read at the same
  // moment, for the same reason.
  let box = null;
  const measure = () => {
    box = node.getBoundingClientRect();
    const root = document.documentElement;
    const p = parseFloat(getComputedStyle(root).getPropertyValue('--parallax'));
    const calm = root.getAttribute('data-motion');
    gain = (isFinite(p) ? p : 1) * (calm === 'none' ? 0 : calm === 'calm' ? 0.45 : 1);
  };

  const onEnter = measure;
  const onMove = (e) => {
    if (!box) measure();
    if (!box.width || !gain) return;
    const px = (e.clientX - box.left) / box.width - 0.5;      // −0.5 … 0.5
    const py = (e.clientY - box.top) / box.height - 0.5;
    sy.to = px * 2 * max * gain;
    sx.to = -py * 2 * max * gain;
    sz.to = lift * gain;
    sl.to = 1;
    node.style.setProperty('--tx', (px * 2).toFixed(3));
    node.style.setProperty('--ty', (py * 2).toFixed(3));
  };
  const onLeave = () => { box = null; sx.to = 0; sy.to = 0; sz.to = 0; sl.to = 0; };

  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('pointercancel', onLeave);

  return () => {
    node.removeEventListener('pointerenter', onEnter);
    node.removeEventListener('pointermove', onMove);
    node.removeEventListener('pointerleave', onLeave);
    node.removeEventListener('pointercancel', onLeave);
    sx.stop(); sy.stop(); sz.stop(); sl.stop();
    node.style.transform = '';
    node.style.removeProperty('--tx');
    node.style.removeProperty('--ty');
    node.style.removeProperty('--lit');
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
