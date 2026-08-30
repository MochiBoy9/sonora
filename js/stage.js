/* stage.js — the immersive view.
 *
 * The whole window given over to the music: a full-bleed visualiser, the
 * artwork on a real perspective tilt that follows the pointer and leans into
 * the beat, and the transport. The chrome fades out when the pointer goes
 * still, the way a player that expects to be watched should behave.
 *
 * It is built on open and torn down on close — while it is shut there is no
 * canvas, no ticker task and no listeners.
 */

import { $, el, ico, fmtTime, clamp, formatName } from './util.js';
import * as player from './player.js';
import * as lib from './library.js';
import { paintArt } from './ui.js';
import { createVisualizer, MODES, isMode } from './visualizer.js';
import * as lyrics from './lyrics.js';
import * as peakmap from './peaks.js';
import { tick, animate, spring, draggable, settled, ease, reduceMotion } from './motion.js';

const MODE_KEY = 'sonora:viz';
const IDLE_MS = 3200;

export const storedMode = () => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isMode(v) ? v : 'bars';
  } catch { return 'bars'; }
};

let open = null;                 // teardown for the live stage, or null

export const isOpen = () => !!open;

export function toggleStage(backdrop) {
  if (open) closeStage();
  else openStage(backdrop);
}

export function closeStage() {
  if (!open) return;
  const teardown = open;
  open = null;
  teardown();
}

export function openStage(backdrop) {
  if (open) return;

  const host = el('div', { class: 'stage', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Visualiser' });
  const canvas = el('canvas', { class: 'stage-viz', 'aria-hidden': 'true' });

  const modeBar = el('div', { class: 'stage-modes', role: 'tablist', 'aria-label': 'Visualiser style' });
  const closeBtn = el('button', {
    class: 'icon-btn stage-close', 'aria-label': 'Close visualiser (Esc)', title: 'Close (Esc)', html: ico('close'),
    onclick: () => closeStage(),
  });

  const artImg = el('img', { class: 'art-img', alt: '', decoding: 'async' });
  const art = el('div', { class: 'art stage-art' }, artImg);
  const artWrap = el('div', { class: 'stage-art-wrap' }, art);

  const title = el('h2', { class: 'stage-title' });
  const artist = el('p', { class: 'stage-artist' });
  const tags = el('div', { class: 'stage-tags' });

  /* The words, when there are any.
   *
   * A `role="log"` with `aria-live="off"`: the lines are announced by nothing,
   * because a screen reader reciting a song over the top of the song is not an
   * accessibility feature. They are readable on demand, which is the right
   * behaviour for a transcript of audio that is already playing.
   */
  const lyricBox = el('div', { class: 'stage-lyrics', role: 'log', 'aria-live': 'off', hidden: true });
  const lyricBtn = el('button', {
    class: 'icon-btn stage-lyric-btn', title: 'Lyrics (L)', 'aria-label': 'Show lyrics',
    'aria-pressed': 'false', html: ico('file'), hidden: true,
  });

  const elapsed = el('span', { class: 'stage-time', text: '0:00' });
  const total = el('span', { class: 'stage-time', text: '0:00' });
  const fill = el('div', { class: 'seek-fill' });
  const knob = el('div', { class: 'seek-knob' });
  /* The whole song, as a spectrogram, and the scrubber runs across it.
     `spec-ahead` dims the part that has not played yet, so the strip reads as
     a progress bar as well as a picture. */
  const spec = el('canvas', { class: 'stage-spec', 'aria-hidden': 'true' });
  const specAhead = el('div', { class: 'stage-spec-ahead', 'aria-hidden': 'true' });
  const seek = el('div', { class: 'seek stage-seek', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('div', { class: 'seek-track' }, spec, specAhead, fill), knob);

  const playBtn = el('button', { class: 'pb-play stage-play', 'aria-label': 'Play', html: ico('play') + ico('pause'), onclick: () => player.toggle() });
  const transport = el('div', { class: 'stage-transport' },
    el('button', { class: 'icon-btn', title: 'Shuffle (S)', 'aria-label': 'Shuffle', html: ico('shuffle'), onclick: () => player.setShuffle() }),
    el('button', { class: 'icon-btn', title: 'Previous (P)', 'aria-label': 'Previous', html: ico('prev'), onclick: () => player.prev() }),
    playBtn,
    el('button', { class: 'icon-btn', title: 'Next (N)', 'aria-label': 'Next', html: ico('next'), onclick: () => player.next(false) }),
    el('button', { class: 'icon-btn', title: 'Repeat (R)', 'aria-label': 'Repeat', html: ico('repeat'), onclick: () => player.cycleRepeat() }));

  host.append(
    canvas,
    el('div', { class: 'stage-veil' }),
    el('div', { class: 'stage-top' }, modeBar, lyricBtn, closeBtn),
    el('div', { class: 'stage-body' }, artWrap,
      el('div', { class: 'stage-meta' }, title, artist, tags, lyricBox)),
    el('div', { class: 'stage-foot' },
      el('div', { class: 'stage-scrub' }, elapsed, seek, total),
      transport));

  document.body.appendChild(host);
  document.body.classList.add('stage-open');

  // The 3D backdrop moves inside the stage for as long as it is open, so it
  // plays behind the artwork instead of behind a sheet of frosted glass. The
  // canvas is position:fixed, so re-parenting it costs nothing and the WebGL
  // context survives untouched.
  const bdCanvas = backdrop && backdrop.canvas;
  if (bdCanvas) host.insertBefore(bdCanvas, host.firstChild);

  /* ---------------------------------------------------------------- modes */

  const viz = createVisualizer(canvas, {
    mode: storedMode(),
    bars: 64,
    band: 0.46,                 // bars own the lower half, not the whole window
    visible: () => !!open,
    intensity: 1,
  });

  for (const m of MODES) {
    modeBar.appendChild(el('button', {
      class: 'stage-mode' + (m.id === viz.mode ? ' is-on' : ''),
      role: 'tab', text: m.label, data: { mode: m.id },
      onclick: () => setMode(m.id),
    }));
  }

  function setMode(id) {
    viz.setMode(id);
    try { localStorage.setItem(MODE_KEY, id); } catch { /* private mode */ }
    for (const b of modeBar.children) b.classList.toggle('is-on', b.dataset.mode === id);
    document.dispatchEvent(new CustomEvent('sonora:viz-mode', { detail: id }));
  }

  /* ---------------------------------------------------------------- content */

  function paint() {
    const t = player.state.current;
    host.classList.toggle('has-track', !!t);
    if (!t) {
      title.textContent = 'Nothing playing';
      artist.textContent = 'Choose a track to fill the room';
      tags.textContent = '';
      paintArt(artImg, '');
      return;
    }
    if (title.textContent !== t.title) {
      title.textContent = t.title;
      animate(host.querySelector('.stage-meta'),
        { opacity: [0, 1], transform: ['translate3d(0,14px,0)', 'none'] }, { duration: 520, easing: ease.out });
      animate(artWrap, { opacity: [0.4, 1], transform: ['scale(.94)', 'scale(1)'] },
        { duration: 560, easing: ease.out });
    }
    artist.textContent = t.artist;

    // The readout: album, year, genre and the container it came off disk in.
    tags.textContent = '';
    for (const bit of [t.album, t.year || null, t.genre || null, formatName(t.name || '')]) {
      if (bit) tags.appendChild(el('span', { class: 'chip', text: String(bit) }));
    }

    paintArt(artImg, t.albumKey);
    total.textContent = fmtTime(t.duration || player.state.duration || 0);
  }

  function paintState() {
    host.classList.toggle('is-playing', player.state.playing);
    playBtn.setAttribute('aria-label', player.state.playing ? 'Pause' : 'Play');
  }

  /* ---------------------------------------------------------------- spectrogram */

  /*
   * The whole song at once, and the scrubber runs across it.
   *
   * The bars along the bottom of this view show the last 23 ms of the music.
   * This shows all of it: where the verses are, where the chorus opens up,
   * where the track drops to a filter sweep and comes back. It is the one
   * picture that lets you navigate a song you have never heard before.
   *
   * Frequency is vertical and logarithmic — bass at the bottom, where people
   * expect it — and time is horizontal, matched to the scrubber underneath it
   * so the playhead is over the moment it is playing.
   *
   * Drawn once per track through an ImageData at the analysis's own size and
   * scaled up by the canvas, rather than 23,000 fillRect calls.
   */
  let specFor = null;

  function drawSpec(rec) {
    const cols = rec.specCols, rows = rec.specBands;
    const src = el('canvas');
    src.width = cols; src.height = rows;
    const sg = src.getContext('2d');
    const img = sg.createImageData(cols, rows);
    const px = img.data;

    const cs = getComputedStyle(host);
    const rgbOf = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
      return v.length === 3 && v.every((n) => isFinite(n)) ? v : fallback;
    };
    const [ar, ag, ab] = rgbOf('--accent-rgb', [0, 209, 255]);

    /* The loud end of the ramp has to be the opposite of the ground, not
       always white: the stage takes its background from the theme, so a
       white-hot spectrogram is invisible on a light one. */
    const [br, bg_, bb] = rgbOf('--bg-rgb', [4, 8, 14]);
    const groundIsDark = (0.2126 * br + 0.7152 * bg_ + 0.0722 * bb) < 128;
    const [hr, hg, hb] = groundIsDark ? [255, 255, 255] : [6, 14, 24];

    for (let y = 0; y < rows; y++) {
      // Row 0 of the analysis is the lowest band, and canvas y grows downward,
      // so the image is filled bottom-up to put bass at the bottom.
      const dstRow = (rows - 1 - y) * cols;
      for (let x = 0; x < cols; x++) {
        const v = rec.spec[y * cols + x] / 255;
        const o = (dstRow + x) * 4;
        /* A ramp with a knee in it: the bottom two thirds climb through the
           accent, and only the loudest third goes on toward white. A linear
           ramp to white washes the whole picture out, because most of a
           spectrogram sits in the middle. */
        const t = v * v;                       // gamma, to open up the quiet end
        const hot = Math.max(0, (v - 0.66) / 0.34);
        px[o]     = Math.min(255, Math.max(0, ar * t + (hr - ar) * hot));
        px[o + 1] = Math.min(255, Math.max(0, ag * t + (hg - ag) * hot));
        px[o + 2] = Math.min(255, Math.max(0, ab * t + (hb - ab) * hot));
        px[o + 3] = Math.min(255, 26 + t * 300);
      }
    }
    sg.putImageData(img, 0, 0);

    const rect = seek.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    spec.width = Math.max(1, Math.round((rect.width || cols) * dpr));
    spec.height = Math.max(1, Math.round(56 * dpr));
    const g = spec.getContext('2d');
    g.clearRect(0, 0, spec.width, spec.height);
    // Smoothing on: the analysis is 480 columns and the strip is a thousand
    // pixels wide, and a nearest-neighbour spectrogram looks like a barcode.
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, spec.width, spec.height);
  }

  function clearSpec() {
    specFor = null;
    host.classList.remove('has-spec');
  }

  async function loadSpec() {
    const t = player.state.current;
    if (!t) return clearSpec();
    if (specFor === t.id) return;
    clearSpec();
    const rec = await peakmap.forTrack(t, 'all').catch(() => null);
    if (!rec || !rec.spec || !open) return;
    if (!player.state.current || player.state.current.id !== t.id) return;
    drawSpec(rec);
    specFor = t.id;
    host.classList.add('has-spec');
  }

  // `on` hands back its own unsubscriber — there is no `off`. Keeping it
  // matters here: the stage is built and torn down on every open, so a
  // listener left behind holds a dead stage's DOM alive for the session.
  const offPeaks = peakmap.events.on('peaks', (id) => {
    if (open && player.state.current && player.state.current.id === id) loadSpec();
  });

  /* ---------------------------------------------------------------- seeking */

  let scrubbing = false;
  draggable(seek, {
    onStart: () => { scrubbing = true; seek.classList.add('is-active'); },
    onMove: (r) => {
      fill.style.transform = `scaleX(${r})`;
      knob.style.left = (r * 100).toFixed(2) + '%';
      if (specFor) specAhead.style.clipPath = `inset(0 0 0 ${(r * 100).toFixed(3)}%)`;
      elapsed.textContent = fmtTime(r * (player.state.duration || 0));
    },
    onEnd: (r) => { scrubbing = false; seek.classList.remove('is-active'); player.seekRatio(r); player.play(); },
  });

  /* ---------------------------------------------------------------- tilt */

  // The artwork sits on a plane that turns toward the pointer; the beat gives
  // it a shove along z. Both go through springs so nothing snaps.
  let tiltX = 0, tiltY = 0, lift = 0;
  const sx = spring({ from: 0, to: 0, stiffness: 90, damping: 18, onUpdate: (v) => { tiltX = v; } });
  const sy = spring({ from: 0, to: 0, stiffness: 90, damping: 18, onUpdate: (v) => { tiltY = v; } });

  const onMove = (e) => {
    wake();
    if (reduceMotion.matches) return;
    const nx = (e.clientX / innerWidth - 0.5) * 2;
    const ny = (e.clientY / innerHeight - 0.5) * 2;
    sy.to = nx * 13;
    sx.to = -ny * 10;
  };
  host.addEventListener('pointermove', onMove);

  /* ---------------------------------------------------------------- idle */

  let idleTimer = 0;
  function wake() {
    host.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (player.state.playing) host.classList.add('is-idle');
    }, IDLE_MS);
  }
  wake();

  /* ---------------------------------------------------------------- frame */

  // The radial ring is drawn concentric with the artwork; the artwork's centre
  // moves with the layout, so re-measure it now and then rather than assuming.
  let focusAt = 0;
  function syncFocus(now) {
    if (now - focusAt < 800) return;
    focusAt = now;
    const box = art.getBoundingClientRect();
    if (!box.width) return;
    viz.setFocus((box.left + box.width / 2) / innerWidth, (box.top + box.height / 2) / innerHeight);
  }
  syncFocus(performance.now() + 1000);

  const stopTick = tick((dt, now) => {
    syncFocus(now);
    const a = player.analysis();
    const d = player.state.duration || 0;
    if (!scrubbing) {
      const r = d ? clamp(player.currentTime() / d, 0, 1) : 0;
      fill.style.transform = `scaleX(${r})`;
      knob.style.left = (r * 100).toFixed(2) + '%';
      elapsed.textContent = fmtTime(r * d);
      if (specFor) specAhead.style.clipPath = `inset(0 0 0 ${(r * 100).toFixed(3)}%)`;
      seek.setAttribute('aria-valuenow', Math.round(r * 100));
      followLyric(player.currentTime());
    }
    lift += ((a.pulse * 26 + a.level * 18) - lift) * Math.min(1, dt / 90);
    art.style.transform =
      `translate3d(0,0,${lift.toFixed(2)}px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) scale(${(1 + a.level * 0.03).toFixed(4)})`;
    host.style.setProperty('--viz-level', a.level.toFixed(3));
  });

  /* ---------------------------------------------------------------- lyrics */

  /*
   * Words on the stage.
   *
   * Only two things happen per frame: a binary search over stamps that are
   * already sorted, and — on the frames where the line actually changes — one
   * class swap and one transform. The whole block is translated as a unit so
   * the current line stays put and the song scrolls past it, which is both
   * cheaper than moving every line and the way a teleprompter behaves.
   */
  let words = null;
  let shown = -1;
  let wantLyrics = false;

  function renderLyrics() {
    lyricBox.textContent = '';
    shown = -1;
    if (!words || !words.lines.length) return;
    for (const line of words.lines) {
      lyricBox.appendChild(el('p', {
        class: 'stage-line' + (line.text ? '' : ' is-gap'),
        text: line.text || ' ',
      }));
    }
    lyricBox.classList.toggle('is-synced', !!words.synced);
  }

  function followLyric(time) {
    if (!wantLyrics || !words || !words.synced) return;
    const i = lyrics.lineAt(words, time);
    if (i === shown) return;
    const nodes = lyricBox.children;
    if (nodes[shown]) nodes[shown].classList.remove('is-now');
    shown = i;
    const node = nodes[i];
    if (!node) return;
    node.classList.add('is-now');
    // One transform on the container, not a scroll: scrollTop on a element
    // inside a full-screen composited stage is a layout read every frame.
    lyricBox.style.setProperty('--shift', `${-node.offsetTop}px`);
  }

  function syncLyricUI() {
    lyricBtn.hidden = !words;
    lyricBox.hidden = !(words && wantLyrics);
    lyricBtn.setAttribute('aria-pressed', wantLyrics ? 'true' : 'false');
    lyricBtn.setAttribute('aria-label', wantLyrics ? 'Hide lyrics' : 'Show lyrics');
    host.classList.toggle('has-lyrics', !!(words && wantLyrics));
  }

  async function loadLyrics() {
    const t = player.state.current;
    words = null;
    shown = -1;
    syncLyricUI();
    if (!t) return;
    const found = await lyrics.forTrack(t);
    // The track may have moved on while we were looking.
    if (!open || player.state.current !== t) return;
    words = found && found.lines.length ? found : null;
    renderLyrics();
    syncLyricUI();
  }

  lyricBtn.addEventListener('click', () => {
    wantLyrics = !wantLyrics;
    syncLyricUI();
    if (wantLyrics) { shown = -1; followLyric(player.currentTime()); }
  });

  /* ---------------------------------------------------------------- wiring */

  const offTrack = player.events.on('track', paint);
  const offLyrics = player.events.on('track', loadLyrics);
  const offSpec = player.events.on('track', loadSpec);
  loadSpec();
  loadLyrics();
  const offState = player.events.on('state', () => { paintState(); paint(); });
  const offArt = lib.events.on('art', () => { const t = player.state.current; if (t) paintArt(artImg, t.albumKey); });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeStage(); return; }
    // Only while the stage is open, and only when there is something to show:
    // a key that does nothing on most tracks is a key nobody learns.
    if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey && words) {
      e.stopPropagation();
      lyricBtn.click();
    }
  };
  document.addEventListener('keydown', onKey, true);

  paint();
  paintState();

  if (backdrop) backdrop.setIntensity(1.9);
  animate(host, { opacity: [0, 1] }, { duration: 360, easing: ease.out });
  animate(host.querySelector('.stage-body'),
    { opacity: [0, 1], transform: ['translate3d(0,26px,0) scale(.97)', 'none'] },
    { duration: 620, delay: 60, easing: ease.out });
  closeBtn.focus();

  open = () => {
    clearTimeout(idleTimer);
    stopTick();
    sx.stop(); sy.stop();
    viz.destroy();
    offTrack(); offState(); offArt(); offLyrics(); offSpec();
    offPeaks();
    document.removeEventListener('keydown', onKey, true);
    host.removeEventListener('pointermove', onMove);
    document.body.classList.remove('stage-open');
    if (bdCanvas) document.body.insertBefore(bdCanvas, document.body.firstChild);
    if (backdrop) backdrop.setIntensity(1);
    const out = animate(host, { opacity: [1, 0], transform: ['scale(1)', 'scale(1.03)'] },
      { duration: 260, easing: ease.inOut, commit: false });
    settled(out, 260).then(() => host.remove());
    $('#playerbar')?.querySelector('.pb-stage')?.focus?.();
  };
}
