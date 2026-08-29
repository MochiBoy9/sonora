/* intro.js — the way in.
 *
 * Every visit opens on the same short sequence: the mark draws itself, the
 * wordmark rises a letter at a time, a meter fills, and the app arrives behind
 * it. It runs while the library is being read out of IndexedDB, so the time it
 * takes is time that was being spent anyway — and it is skippable on the first
 * key, click or scroll, because an intro you cannot dismiss is a toll booth.
 *
 * The markup lives in index.html rather than here: it has to be on screen
 * before this module has been fetched, or the first frame is a bare app frame.
 * This file only animates it and takes it away.
 */

import { animate, ease, reduceMotion } from './motion.js';

const SEEN_KEY = 'sonora:seen';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

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
  const beat = reduceMotion.matches ? 0 : firstRun ? 1 : 0.58;
  const TOTAL = reduceMotion.matches ? 420 : Math.round(2600 * beat + 420);

  const eyebrow = node.querySelector('.intro-eyebrow');
  const letters = node.querySelectorAll('.intro-word span');
  const tag = node.querySelector('.intro-tag');
  const hint = node.querySelector('.intro-hint');
  const meter = node.querySelector('.intro-meter i');
  const bars = node.querySelectorAll('.intro-bars rect');
  const rings = node.querySelectorAll('.intro-ring');

  if (eyebrow) eyebrow.textContent = greeting();
  if (tag) tag.textContent = firstRun
    ? 'Your music, played from your own disk.'
    : 'Welcome back.';

  let settled = false;
  let resolveReady = () => {};
  const ready = new Promise((r) => { resolveReady = r; });
  const startedAt = performance.now();

  /* ---------------------------------------------------------------- timeline */

  if (!reduceMotion.matches) {
    for (const [i, ring] of [...rings].entries()) {
      const len = 2 * Math.PI * Number(ring.getAttribute('r'));
      ring.style.strokeDasharray = `${len}`;
      animate(ring,
        { strokeDashoffset: [i ? -len : len, 0], opacity: [0, i ? 0.45 : 0.9] },
        { duration: 900 * beat, delay: i * 90 * beat, easing: ease.out });
    }

    bars.forEach((bar, i) => {
      animate(bar,
        { transform: ['scaleY(.06)', 'scaleY(1)'], opacity: [0, 1] },
        { duration: 760 * beat, delay: (240 + i * 90) * beat, easing: ease.overshoot });
    });

    letters.forEach((span, i) => {
      animate(span,
        { opacity: [0, 1], transform: ['translate3d(0,26px,0)', 'none'], filter: ['blur(9px)', 'blur(0px)'] },
        { duration: 780 * beat, delay: (620 + i * 62) * beat, easing: ease.out });
    });

    animate(tag, { opacity: [0, 1], transform: ['translate3d(0,10px,0)', 'none'] },
      { duration: 620 * beat, delay: 1150 * beat, easing: ease.out });
    animate(hint, { opacity: [0, 0.55] }, { duration: 500 * beat, delay: 1500 * beat });
    animate(meter, { transform: ['scaleX(0)', 'scaleX(1)'] },
      { duration: TOTAL - 200, easing: 'cubic-bezier(.2,.7,.3,1)' });
  } else {
    node.classList.add('is-still');
  }

  const timer = setTimeout(() => finish(false), TOTAL);

  /* ---------------------------------------------------------------- skipping */

  // Below this, a "skip" is someone's first keystroke landing in an app that
  // was not there yet, so it is ignored.
  const FLOOR = 420;

  function finish(early) {
    if (settled) return;
    if (early && performance.now() - startedAt < FLOOR) return;
    settled = true;
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
    if (reduceMotion.matches) {
      node.remove();
      document.body.classList.add('intro-done');
      return Promise.resolve();
    }
    const out = animate(node,
      { opacity: [1, 0], transform: ['scale(1)', 'scale(1.06)'], filter: ['blur(0px)', 'blur(12px)'] },
      { duration: 620, easing: ease.inOut, commit: false });
    // The stage leaves slightly ahead of its own background, which reads as
    // the intro lifting off the app rather than the two dissolving together.
    animate(node.querySelector('.intro-stage'),
      { opacity: [1, 0], transform: ['translate3d(0,0,0) scale(1)', 'translate3d(0,-18px,0) scale(.96)'] },
      { duration: 460, easing: ease.inOut, commit: false });

    return (out ? out.finished.catch(() => {}) : Promise.resolve()).then(() => {
      node.remove();
      document.body.classList.add('intro-done');
    });
  }

  return { ready, dismiss, get skipped() { return settled; } };
}
