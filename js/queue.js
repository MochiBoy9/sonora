/* queue.js — the right-hand panel: what's playing, and what's next.
 *
 * The queue list is virtualised too: "add every track in the library to the
 * queue" is a thing people do, and 40,000 rows must not stall the panel.
 */

import { el, ico, fmtTime, fmtCount } from './util.js';
import * as player from './player.js';
import * as lib from './library.js';
import { paintArt, artBox, menu, trackMenu, toast, emptyState } from './ui.js';
import { VirtualList } from './virtual.js';
import { createVisualizer } from './visualizer.js';
import { storedMode } from './stage.js';
import { tick, animate, enter, ease } from './motion.js';

const ROW_H = 56;

export function mountQueue(host) {
  host.innerHTML = `
    <div class="pane-tabs" role="tablist">
      <button class="pane-tab is-on" data-tab="now" role="tab">Now playing</button>
      <button class="pane-tab" data-tab="queue" role="tab">Queue</button>
      <button class="icon-btn ghost pane-close" title="Hide panel" aria-label="Hide panel">${ico('close')}</button>
    </div>
    <div class="pane-body">
      <section class="pane-view" data-view="now"></section>
      <section class="pane-view" data-view="queue" hidden></section>
    </div>`;

  const tabs = host.querySelectorAll('.pane-tab');
  const views = { now: host.querySelector('[data-view="now"]'), queue: host.querySelector('[data-view="queue"]') };
  let active = 'now';

  host.querySelector('.pane-close').addEventListener('click',
    () => document.dispatchEvent(new CustomEvent('sonora:toggle-queue')));

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      if (active === tab.dataset.tab) return;
      active = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle('is-on', t.dataset.tab === active);
      for (const k in views) {
        views[k].hidden = k !== active;
        if (k === active) animate(views[k], { opacity: [0, 1], transform: ['translateY(6px)', 'none'] }, { duration: 260, easing: ease.out });
      }
      if (active === 'queue') queueList.update();
    });
  }

  // Cheap enough to call every frame: no layout read, no style resolution.
  const visible = () =>
    active === 'now' && document.getElementById('app').classList.contains('pane-open');

  const nowView = buildNowPlaying(views.now, visible);
  const queueList = buildQueue(views.queue);

  player.events.on('track', () => { nowView.paint(); queueList.update(true); });
  player.events.on('state', () => nowView.paintState());
  player.events.on('queue', () => { queueList.update(); nowView.paint(); });
  lib.events.on('art', () => nowView.paintArtOnly());

  nowView.paint();
  queueList.update();

  return { showQueue: () => tabs[1].click() };
}

/* ------------------------------------------------------------------ now playing */

function buildNowPlaying(host, visible) {
  host.innerHTML = `
    <div class="np">
      <div class="np-stage">
        <div class="np-art art"><img class="art-img" alt="" decoding="async"></div>
        <canvas class="np-viz" aria-hidden="true"></canvas>
      </div>
      <div class="np-meta">
        <h3 class="np-title"></h3>
        <a class="np-artist" href="#"></a>
        <a class="np-album" href="#"></a>
      </div>
      <div class="np-facts"></div>
      <div class="np-next"></div>
    </div>`;

  const art = host.querySelector('.art-img');
  const title = host.querySelector('.np-title');
  const artist = host.querySelector('.np-artist');
  const album = host.querySelector('.np-album');
  const facts = host.querySelector('.np-facts');
  const upNext = host.querySelector('.np-next');
  const canvas = host.querySelector('.np-viz');

  const empty = emptyState({ icon: 'music', title: 'Nothing playing', note: 'Choose a track to begin.' });
  empty.classList.add('np-empty');

  mountVisualizer(canvas, visible);

  function paintArtOnly() {
    const t = player.state.current;
    if (t) paintArt(art, t.albumKey);
  }

  function paint() {
    const t = player.state.current;
    host.querySelector('.np').hidden = !t;
    if (!t) {
      if (!empty.parentNode) host.appendChild(empty);
      return;
    }
    empty.remove();

    if (title.textContent !== t.title) {
      title.textContent = t.title;
      animate(host.querySelector('.np-meta'),
        { opacity: [0, 1], transform: ['translateY(10px)', 'none'] }, { duration: 400, easing: ease.out });
      animate(host.querySelector('.np-stage'),
        { opacity: [0.5, 1], transform: ['scale(.95)', 'scale(1)'] }, { duration: 460, easing: ease.out });
    }
    artist.textContent = t.artist;
    artist.href = '#/artist/' + t.artistKey;
    album.textContent = t.album;
    album.href = '#/album/' + t.albumKey;
    paintArt(art, t.albumKey);

    facts.textContent = '';
    const bits = [t.year && String(t.year), t.genre, t.duration && fmtTime(t.duration)].filter(Boolean);
    for (const b of bits) facts.appendChild(el('span', { class: 'chip', text: b }));

    // "Up next" preview keeps the panel useful without switching tabs.
    upNext.textContent = '';
    const nextId = player.state.queue[player.state.index + 1];
    const nextTrack = nextId && lib.getTrack(nextId);
    if (nextTrack) {
      upNext.appendChild(el('span', { class: 'np-next-label', text: 'Up next' }));
      const row = el('button', {
        class: 'np-next-row',
        onclick: () => player.jumpTo(player.state.index + 1),
      },
        artBox(nextTrack.albumKey, 34, 'art-xs'),
        el('span', { class: 'np-next-text' },
          el('span', { class: 'np-next-title', text: nextTrack.title }),
          el('span', { class: 'np-next-artist', text: nextTrack.artist })));
      upNext.appendChild(row);
      enter([row], { y: 8 });
    }
  }

  function paintState() {
    // The class goes on .np, not on the panel: the artwork glow and the
    // visualiser's resting opacity both hang off it.
    host.querySelector('.np').classList.toggle('is-playing', player.state.playing);
  }

  return { paint, paintState, paintArtOnly };
}

/* ------------------------------------------------------------------ visualizer */

/**
 * The spectrum inside the now-playing artwork. The drawing is the shared
 * renderer; what happens here is the glow around the sleeve, which tracks the
 * overall level as a custom property so the CSS can own the look of it.
 */
function mountVisualizer(canvas, visible) {
  const viz = createVisualizer(canvas, {
    mode: storedMode(),
    bars: 44,
    visible,
    intensity: 1,
  });

  document.addEventListener('sonora:viz-mode', (e) => viz.setMode(e.detail));
  player.events.on('track', () => viz.kick());

  const np = canvas.closest('.np') || canvas.parentNode;
  let shown = -1;
  tick(() => {
    if (!visible()) return;
    const level = player.analysis().level;
    // Writing a custom property is a style invalidation; only bother when the
    // value has moved enough to be visible.
    if (Math.abs(level - shown) < 0.02) return;
    shown = level;
    np.style.setProperty('--viz-level', level.toFixed(3));
  });

  return viz;
}

/* ------------------------------------------------------------------ queue list */

function buildQueue(host) {
  const head = el('div', { class: 'queue-head' },
    el('div', { class: 'queue-summary' }),
    el('button', { class: 'link-btn', text: 'Clear', onclick: () => { player.clearQueue(); toast('Queue cleared'); } }));
  host.appendChild(head);

  const scroller = el('div', { class: 'queue-scroll' });
  host.appendChild(scroller);

  const emptyNode = emptyState({ icon: 'queue', title: 'The queue is empty', note: 'Play an album or add tracks to build one up.' });

  let items = [];
  let dragFrom = -1;

  const list = new VirtualList({
    viewport: scroller,
    rowHeight: ROW_H,
    create: () => {
      const row = el('div', { class: 'qrow', draggable: 'true' });
      row.innerHTML =
        `<div class="qrow-grip">${ico('grip')}</div>` +
        '<div class="art art-xs"><img class="art-img" alt="" decoding="async"></div>' +
        '<div class="qrow-text"><div class="qrow-title"></div><div class="qrow-sub"></div></div>' +
        `<div class="qrow-time"></div>` +
        `<button class="icon-btn ghost qrow-remove" aria-label="Remove">${ico('close')}</button>`;

      row.addEventListener('click', (e) => {
        const i = +row.dataset.index;
        if (e.target.closest('.qrow-remove')) player.removeAt(i);
        else player.jumpTo(i);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const t = items[+row.dataset.index];
        if (t) menu(trackMenu([t], { onRemove: () => player.removeAt(+row.dataset.index), removeLabel: 'Remove from queue' }), { event: e });
      });
      row.addEventListener('dragstart', (e) => {
        dragFrom = +row.dataset.index;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch {}
      });
      row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); dragFrom = -1; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('is-drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('is-drop');
        const to = +row.dataset.index;
        if (dragFrom < 0 || dragFrom === to) return;
        player.moveInQueue(dragFrom, to);
      });
      return row;
    },
    render: (row, track, i) => {
      if (!track) return;
      row.classList.toggle('is-current', i === player.state.index);
      row.classList.toggle('is-past', i < player.state.index);
      paintArt(row.querySelector('.art-img'), track.albumKey);
      row.querySelector('.qrow-title').textContent = track.title;
      row.querySelector('.qrow-sub').textContent = track.artist;
      row.querySelector('.qrow-time').textContent = track.duration ? fmtTime(track.duration) : '';
    },
  });

  function update(follow) {
    items = player.state.queue.map((id) => lib.getTrack(id)).filter(Boolean);
    const remaining = Math.max(0, items.length - player.state.index - 1);
    head.querySelector('.queue-summary').textContent = items.length
      ? `${fmtCount(items.length, 'track')} · ${remaining} up next`
      : 'Nothing queued';
    head.hidden = !items.length;

    if (!items.length) {
      if (!emptyNode.parentNode) host.appendChild(emptyNode);
      list.setItems([]);
      return;
    }
    emptyNode.remove();
    list.setItems(items);

    // Follow the playhead, but only when it has actually left the viewport —
    // yanking the list while someone is reading it would be worse than useless.
    const i = player.state.index;
    if (follow && i >= 0) {
      const top = scroller.scrollTop;
      const y = i * ROW_H;
      if (y < top || y + ROW_H > top + scroller.clientHeight) list.scrollToIndex(i, 'center');
    }
  }

  return { update, list };
}
