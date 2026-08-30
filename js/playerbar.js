/* playerbar.js — the transport bar.
 *
 * The playhead is driven by the shared rAF ticker rather than the audio
 * element's `timeupdate` (which only fires about four times a second), and it
 * moves the fill with scaleX so the browser never re-lays-out while playing.
 */

import { el, ico, fmtTime, clamp } from './util.js';
import * as player from './player.js';
import * as lib from './library.js';
import { paintArt, menu, trackMenu, toast } from './ui.js';
import { createVisualizer } from './visualizer.js';
import { storedMode } from './stage.js';
import { tick, draggable, animate, spring, ease, reduceMotion } from './motion.js';

export function mountPlayerBar(host) {
  host.innerHTML = `
    <canvas class="pb-viz" aria-hidden="true"></canvas>
    <div class="pb-now">
      <div class="art art-3d art-pb"><img class="art-img" alt="" decoding="async"></div>
      <div class="pb-text">
        <a class="pb-title" href="#"></a>
        <a class="pb-artist" href="#"></a>
      </div>
      <button class="icon-btn ghost pb-fav" title="Favourite (F)" aria-label="Add to favourites" aria-pressed="false">${ico('star')}${ico('star-fill')}</button>
      <button class="icon-btn ghost pb-more" title="More" aria-label="More">${ico('more')}</button>
    </div>

    <div class="pb-center">
      <div class="pb-buttons">
        <button class="icon-btn pb-shuffle" title="Shuffle (S)" aria-label="Shuffle">${ico('shuffle')}</button>
        <button class="icon-btn pb-prev" title="Previous (P)" aria-label="Previous">${ico('prev')}</button>
        <button class="pb-play" title="Play (Space)" aria-label="Play">${ico('play')}${ico('pause')}</button>
        <button class="icon-btn pb-next" title="Next (N)" aria-label="Next">${ico('next')}</button>
        <button class="icon-btn pb-repeat" title="Repeat (R)" aria-label="Repeat">${ico('repeat')}${ico('repeat-one')}</button>
      </div>
      <div class="pb-scrub">
        <span class="pb-time pb-elapsed">0:00</span>
        <div class="seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100">
          <div class="seek-track">
            <div class="seek-buffer"></div>
            <div class="seek-fill"></div>
          </div>
          <div class="seek-knob"></div>
          <div class="seek-tip"></div>
        </div>
        <span class="pb-time pb-duration">0:00</span>
      </div>
    </div>

    <div class="pb-right">
      <div class="vu" aria-hidden="true"><i class="vu-peak"></i><i class="vu-needle"></i></div>
      <button class="icon-btn pb-stage" title="Visualiser (V)" aria-label="Open visualiser">${ico('expand')}</button>
      <button class="icon-btn pb-queue" title="Queue (Q)" aria-label="Queue">${ico('queue')}</button>
      <div class="pb-volume">
        <button class="icon-btn pb-mute" title="Mute (M)" aria-label="Mute">${ico('volume')}${ico('volume-off')}</button>
        <div class="vol" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100">
          <div class="vol-track"><div class="vol-fill"></div></div>
          <div class="vol-knob"></div>
        </div>
      </div>
    </div>`;

  const q = (s) => host.querySelector(s);
  const art = q('.art-pb .art-img');
  const titleEl = q('.pb-title');
  const artistEl = q('.pb-artist');
  const playBtn = q('.pb-play');
  const seek = q('.seek');
  const fill = q('.seek-fill');
  const buffer = q('.seek-buffer');
  const knob = q('.seek-knob');
  const tip = q('.seek-tip');
  const elapsed = q('.pb-elapsed');
  const durationEl = q('.pb-duration');
  const volFill = q('.vol-fill');
  const volKnob = q('.vol-knob');

  /* ------------------------------------------------------------ transport */

  playBtn.addEventListener('click', () => {
    player.toggle();
    spring({ from: 0.86, to: 1, stiffness: 600, damping: 17,
             onUpdate: (v) => (playBtn.style.transform = `scale(${v})`) });
  });
  q('.pb-prev').addEventListener('click', () => player.prev());
  q('.pb-next').addEventListener('click', () => player.next(false));
  q('.pb-shuffle').addEventListener('click', () => {
    player.setShuffle();
    toast(player.state.shuffle ? 'Shuffle on' : 'Shuffle off');
  });
  q('.pb-repeat').addEventListener('click', () => {
    player.cycleRepeat();
    toast(player.state.repeat === 'off' ? 'Repeat off' : player.state.repeat === 'all' ? 'Repeat all' : 'Repeat one');
  });
  q('.pb-queue').addEventListener('click', () => document.dispatchEvent(new CustomEvent('sonora:toggle-queue')));
  q('.pb-stage').addEventListener('click', () => document.dispatchEvent(new CustomEvent('sonora:stage')));
  q('.pb-mute').addEventListener('click', () => player.toggleMute());
  q('.pb-more').addEventListener('click', (e) => {
    const t = player.state.current;
    if (t) menu(trackMenu([t]), { anchor: e.currentTarget });
  });

  const favBtn = q('.pb-fav');
  favBtn.addEventListener('click', () => {
    const t = player.state.current;
    if (!t) return;
    const on = lib.toggleFavourite(t.id);
    if (on) {
      spring({ from: 0.7, to: 1, stiffness: 620, damping: 16,
               onUpdate: (v) => (favBtn.style.transform = `scale(${v})`) });
    }
  });

  function paintFav() {
    const t = player.state.current;
    const on = !!t && lib.isFavourite(t.id);
    host.classList.toggle('is-fav', on);
    favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    favBtn.setAttribute('aria-label', on ? 'Remove from favourites' : 'Add to favourites');
    favBtn.title = on ? 'Favourited (F)' : 'Favourite (F)';
  }

  /* ------------------------------------------------------------ ribbon */

  // A hairline spectrum along the top edge of the bar. It shares the same
  // per-frame reading of the analyser as every other visualiser, so it is very
  // nearly free, and it fades out entirely when nothing is playing.
  const ribbon = createVisualizer(q('.pb-viz'), {
    mode: 'bars',
    bars: 72,
    intensity: 0.9,
    idleShimmer: false,
    visible: () => player.state.playing,
  });
  document.addEventListener('sonora:viz-mode', (e) => {
    // The ribbon only has room for bars; wave is the one other mode that reads
    // at 24 pixels tall.
    ribbon.setMode(e.detail === 'wave' ? 'wave' : 'bars');
  });
  if (storedMode() === 'wave') ribbon.setMode('wave');

  /* ------------------------------------------------------------ seeking */

  let scrubbing = false;
  let scrubValue = 0;

  draggable(seek, {
    onStart: () => { scrubbing = true; seek.classList.add('is-active'); },
    onMove: (r) => {
      scrubValue = r;
      paintProgress(r, true);
      const d = player.state.duration || 0;
      tip.textContent = fmtTime(r * d);
      tip.style.setProperty('--x', (r * 100).toFixed(2) + '%');
    },
    onEnd: (r) => {
      scrubbing = false;
      seek.classList.remove('is-active');
      player.seekRatio(r);
      player.play();
    },
  });

  seek.addEventListener('pointermove', (e) => {
    if (scrubbing) return;
    const rect = seek.getBoundingClientRect();
    const r = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    tip.textContent = fmtTime(r * (player.state.duration || 0));
    tip.style.setProperty('--x', (r * 100).toFixed(2) + '%');
  });

  seek.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') { player.seek(player.state.time + step); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { player.seek(player.state.time - step); e.preventDefault(); }
  });

  /* ------------------------------------------------------------ volume */

  const vol = q('.vol');
  draggable(vol, { onMove: (r) => player.setVolume(r), onEnd: (r) => player.setVolume(r) });
  vol.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { player.setVolume(player.state.volume + 0.05); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { player.setVolume(player.state.volume - 0.05); e.preventDefault(); }
  });

  function paintVolume() {
    const v = player.state.muted ? 0 : player.state.volume;
    volFill.style.transform = `scaleX(${v})`;
    volKnob.style.left = (v * 100).toFixed(2) + '%';
    vol.setAttribute('aria-valuenow', Math.round(v * 100));
    host.classList.toggle('is-muted', player.state.muted || v === 0);
  }

  /* ------------------------------------------------------------ progress */

  function paintProgress(ratio, force) {
    fill.style.transform = `scaleX(${ratio})`;
    knob.style.left = (ratio * 100).toFixed(3) + '%';
    if (force || !scrubbing) {
      const d = player.state.duration || 0;
      elapsed.textContent = fmtTime(ratio * d);
    }
    seek.setAttribute('aria-valuenow', Math.round(ratio * 100));
  }

  /* ------------------------------------------------------------ vu */

  /*
   * A needle with real ballistics.
   *
   * A VU meter is defined by how it *moves*, not by what it reads: 300 ms to
   * arrive at a step and a slower fall back, which is what stops a meter
   * flickering on every transient and is the reason people can read one at a
   * glance. Attack and release are therefore deliberately different constants,
   * and the peak dot falls under its own weight rather than following at all.
   *
   * It reads the same per-frame analysis object every visualiser reads, so it
   * costs no second look at the analyser — and it shares the transport's own
   * ticker, which already stops when playback does.
   */
  const vuNeedle = q('.vu-needle');
  const vuPeak = q('.vu-peak');
  let vu = 0, vuHold = 0;

  function paintVU(dt, a) {
    const target = Math.min(1, a.level * 1.25);
    // 300 ms to arrive, roughly a second to fall away.
    const k = target > vu ? Math.min(1, dt / 300) : Math.min(1, dt / 900);
    vu += (target - vu) * k;
    vuHold = Math.max(vuHold - dt / 2600, vu);
    vuNeedle.style.transform = `rotate(${(-42 + vu * 84).toFixed(2)}deg)`;
    vuPeak.style.transform = `rotate(${(-42 + vuHold * 84).toFixed(2)}deg)`;
    host.classList.toggle('vu-hot', vuHold > 0.86);
  }

  let bufferedAt = 0;
  const frame = (dt, now) => {
    if (!player.state.current) return;
    if (!reduceMotion.matches) paintVU(dt, player.analysis());
    if (!scrubbing) {
      const d = player.state.duration || 0;
      const t = player.currentTime();
      paintProgress(d ? clamp(t / d, 0, 1) : 0);
    }
    if (now - bufferedAt > 500) {                     // buffered range moves slowly
      bufferedAt = now;
      const d = player.state.duration || 0;
      buffer.style.transform = `scaleX(${d ? clamp(player.buffered() / d, 0, 1) : 0})`;
    }
  };

  // A paused player has a playhead that is not moving, so there is nothing for
  // a frame callback to do: unregister it and let the shared rAF loop stop.
  let stopFrame = null;
  function syncTicker() {
    const wanted = player.state.playing || player.state.loading;
    if (wanted && !stopFrame) stopFrame = tick(frame);
    else if (!wanted && stopFrame) {
      stopFrame();
      stopFrame = null;
      frame(0, performance.now());                    // one last, accurate paint
    }
  }

  /* ------------------------------------------------------------ binding */

  function paintTrack() {
    const t = player.state.current;
    host.classList.toggle('has-track', !!t);
    if (!t) {
      titleEl.textContent = 'Nothing playing';
      titleEl.removeAttribute('href');
      artistEl.textContent = 'Pick something from your library';
      artistEl.removeAttribute('href');
      paintArt(art, '');
      durationEl.textContent = '0:00';
      paintProgress(0);
      return;
    }
    if (titleEl.textContent !== t.title) {
      titleEl.textContent = t.title;
      animate(host.querySelector('.pb-text'),
        { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0)'] },
        { duration: 340, easing: ease.out });
    }
    titleEl.href = '#/album/' + t.albumKey;
    artistEl.textContent = t.artist;
    artistEl.href = '#/artist/' + t.artistKey;

    if (art.dataset.key !== t.albumKey) {
      animate(art.parentNode, { opacity: [0.4, 1], transform: ['scale(.94)', 'scale(1)'] },
              { duration: 380, easing: ease.out });
    }
    paintArt(art, t.albumKey);
    durationEl.textContent = fmtTime(t.duration || player.state.duration || 0);
  }

  function paintState() {
    host.classList.toggle('is-playing', player.state.playing);
    host.classList.toggle('is-loading', player.state.loading);
    playBtn.setAttribute('aria-label', player.state.playing ? 'Pause' : 'Play');
    playBtn.title = player.state.playing ? 'Pause (Space)' : 'Play (Space)';
    host.classList.toggle('shuffle-on', player.state.shuffle);
    host.dataset.repeat = player.state.repeat;
    const d = player.state.duration || 0;
    if (d) durationEl.textContent = fmtTime(d);
  }

  player.events.on('track', () => { paintTrack(); paintFav(); ribbon.kick(); });
  player.events.on('state', () => { paintState(); paintTrack(); syncTicker(); });
  player.events.on('queue', paintState);
  player.events.on('volume', paintVolume);
  lib.events.on('art', () => { if (player.state.current) paintArt(art, player.state.current.albumKey); });
  lib.events.on('favourites', paintFav);

  paintTrack();
  paintState();
  paintVolume();
  paintFav();
  syncTicker();
}
