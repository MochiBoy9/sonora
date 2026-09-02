/* idle.js — what the application does when nobody is doing anything.
 *
 * R10. There is a full 3D world here, four visualisers, an immersive stage and
 * a wall of artwork, and after two minutes of nobody touching anything it just
 * sat there — while a player left running on a second screen is one of the
 * main ways people use one.
 *
 * So: a slow drift through the covers, with whatever is playing held in front.
 * Not a screensaver in the old sense — nothing is blanked and nothing is
 * protected — it is the record shop window at closing time.
 *
 * THREE RULES, and each is a case where this would otherwise be a nuisance:
 *
 *   — any input cancels it, including the one that would have started it. Not
 *     a click to dismiss: the first movement of a mouse, the first key, the
 *     first touch. Something you have to dismiss is something in your way.
 *   — it never runs while an import does. A scan is work somebody is waiting
 *     on, and covering the progress bar with a slideshow is hiding the one
 *     thing on screen they care about.
 *   — `prefers-reduced-motion` turns the drift off rather than the mode: the
 *     covers still change, they simply cut instead of gliding.
 *
 * It is off unless there is something to show. An empty library has no covers
 * and a paused transport with no current track has nothing to hold in front,
 * so the mode declines to start rather than presenting an empty room.
 */

import { el } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { reduceMotion } from './motion.js';

const DEFAULT_AFTER = 3 * 60 * 1000;      // three minutes of nothing
const HOLD = 9000;                        // how long each cover is held

let node = null;
let timer = 0;
let step = 0;
let after = DEFAULT_AFTER;
let enabled = true;
let stopped = null;

export const isRunning = () => !!node;

/** How long to wait, in minutes. Zero switches the mode off. */
export function configure({ minutes }) {
  if (typeof minutes === 'number') {
    enabled = minutes > 0;
    after = Math.max(30, minutes * 60) * 1000;
  }
  reset();
}

function pick() {
  /* What is playing, then a shuffle of everything else. The current record
     leads because the question somebody glancing at a second screen has is
     "what is this", and the rest is the shop window behind it. */
  const albums = lib.state.albums.filter((a) => a.key);
  if (!albums.length) return [];
  const now = player.state.current && player.state.current.albumKey;
  const rest = albums.filter((a) => a.key !== now);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const head = albums.find((a) => a.key === now);
  return (head ? [head] : []).concat(rest).slice(0, 40);
}

function start() {
  if (node || !enabled) return;
  if (lib.state.scanning) return;                    // an import is not idle
  const order = pick();
  if (!order.length) return;

  node = el('div', {
    class: 'idle', role: 'presentation',
    // Announced by nothing: it is a picture of what is already on screen.
    'aria-hidden': 'true',
  });
  const stack = el('div', { class: 'idle-stack' });
  const caption = el('div', { class: 'idle-caption' },
    el('b', { class: 'idle-title' }),
    el('span', { class: 'idle-artist' }));
  node.append(stack, caption);
  document.body.appendChild(node);
  document.body.classList.add('idle-open');

  let at = 0;
  const show = () => {
    const album = order[at % order.length];
    at++;
    const face = el('div', { class: 'idle-face' },
      el('img', { class: 'idle-img', alt: '', decoding: 'async' }));
    lib.loadArt(album.key).then((url) => { if (url) face.querySelector('.idle-img').src = url; });
    /* Two at a time at most: the outgoing one is removed as soon as the
       incoming one has arrived, so this never grows and never holds more than
       two decoded covers. */
    stack.appendChild(face);
    requestAnimationFrame(() => face.classList.add('is-in'));
    while (stack.children.length > 2) stack.firstChild.remove();
    caption.querySelector('.idle-title').textContent = album.title;
    caption.querySelector('.idle-artist').textContent = album.artist;
  };

  show();
  step = setInterval(show, reduceMotion.matches ? HOLD * 1.5 : HOLD);
}

export function stop() {
  if (step) { clearInterval(step); step = 0; }
  if (!node) return;
  node.classList.add('is-out');
  const going = node;
  node = null;
  document.body.classList.remove('idle-open');
  setTimeout(() => going.remove(), 320);
}

function reset() {
  if (node) stop();
  clearTimeout(timer);
  if (!enabled) return;
  timer = setTimeout(start, after);
}

/**
 * Starts watching. Returns a function that stops watching and takes everything
 * back down — the same shape every other long-lived thing in this application
 * hands back, so a caller never has to remember which of them need cleaning up.
 */
export function watch() {
  if (stopped) return stopped;
  const bump = () => reset();
  /* Passive and capturing: this must never be the reason an event is slow, and
     it must see the input even where something else stops it propagating. */
  const opts = { passive: true, capture: true };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focusin'];
  for (const e of events) addEventListener(e, bump, opts);
  // A track change is the application doing something, which is not the same
  // as somebody being there — but it is worth showing, so the drift restarts
  // on the new record rather than continuing to the next in its own order.
  const offTrack = player.events.on('track', () => { if (node) { stop(); start(); } });
  // A scan starting while the drift is up takes the screen back.
  const offScan = lib.events.on('scan', (on) => { if (on) reset(); });

  reset();
  stopped = () => {
    for (const e of events) removeEventListener(e, bump, opts);
    offTrack();
    offScan();
    clearTimeout(timer);
    stop();
    stopped = null;
  };
  return stopped;
}
