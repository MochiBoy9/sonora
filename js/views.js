/* views.js — every route in the app.
 *
 * A view is a function that fills the scroll host and returns a teardown.
 * Long lists go through the virtualiser; short ones (an album's tracks) are
 * rendered directly, because 12 nodes are cheaper than the machinery.
 */

import { el, ico, fmtTime, fmtTotal, fmtCount, fmtBytes, fmtAgo, cmpText, formatName, norm } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import * as db from './db.js';
import { VirtualList, VirtualGrid } from './virtual.js';
import {
  artBox, sleeve, paintArt, trackRowFactory, trackMenu, menu, toast, dialog, promptDialog, rulesDialog, Selection,
  sectionHead, emptyState, playFab, placeholderStyle,
} from './ui.js';
import { reduceMotion, enter, reveal, scramble, countTo, tilt3d, canDeviceTilt, deviceTiltRunning, requestDeviceTilt, stopDeviceTilt, startDeviceTilt } from './motion.js';
import { MODES, isMode } from './visualizer.js';
import { mountCircles } from './circles.js';
import { mountSound } from './sound.js';
import * as rules from './rules.js';
import * as offline from './offline.js';
import * as stats from './stats.js';
import * as rack from './audio.js';
import * as band from './band.js';
import * as session from './session.js';
import * as looks from './looks.js';
import * as backup from './backup.js';
import * as m3u from './m3u.js';

const ROW_H = 56;

/* ------------------------------------------------------------------ helpers */

/**
 * Views are rebuilt whenever the library changes underneath them, which during
 * an import is several times a second. Entrance effects must not restart on
 * those repaints — a title that keeps dissolving back into noise reads as a
 * fault — so they are gated on the route having actually changed.
 */
let lastRouteKey = null;
let freshRoute = true;

/** Resolves a heading out of noise, once per arrival. */
function decode(node, text, opts) {
  if (!node) return;
  if (!freshRoute) { node.textContent = text; return; }
  scramble(node, text, opts);
}

/** Rolls a number up, once per arrival. */
function readout(node, value, opts) {
  if (!node) return;
  if (!freshRoute) { node.textContent = value.toLocaleString(); return; }
  countTo(node, value, opts);
}

const albumOf = (key) => lib.state.albumBy.get(key);
const artistOf = (key) => lib.state.artistBy.get(key);

/**
 * Marks the one element that should fly between two routes rather than
 * cross-fade with the rest of the page.
 *
 * Exactly one element may wear a given `view-transition-name` at a time — two
 * of them and the browser declines to run the transition at all — so this is
 * put on the cover being left behind, and again on the record being arrived
 * at. The two never coexist, because the old view is torn down and the new one
 * built inside the same callback.
 *
 * `data-vt` is the handle app.js uses to take the names off again afterwards.
 */
export function markTransition(node, name = 'vt-sleeve') {
  if (!node || typeof document.startViewTransition !== 'function') return;
  node.style.setProperty('view-transition-name', name);
  node.setAttribute('data-vt', '');
}

function playAll(tracks, index = 0, origin) {
  if (!tracks.length) return;
  player.playTracks(tracks, index, origin);
}

function shuffleAll(tracks, origin) {
  if (!tracks.length) return;
  player.setShuffle(true);
  player.playTracks(tracks, (Math.random() * tracks.length) | 0, origin);
}

/** A virtualised track table wired to the standard row menu. */
/* Every live table, so the router can ask whether anybody is mid-selection.
   A Set rather than a counter: a view torn down without its destroy() running
   would leak a count forever, and a stale entry here is at worst one skipped
   repaint. */
const liveTables = new Set();

/**
 * Is the listener in the middle of picking tracks?
 *
 * app.js repaints the whole view when the library changes, which during an
 * import is several times a second, and that repaint rebuilds this table and
 * everything it is holding. It already declines to do that when the listener
 * has scrolled away from the top; a half-built selection is the same kind of
 * work in progress and gets the same protection. Without this, selecting
 * anything while a scan is running is impossible.
 */
export const hasLiveSelection = () => {
  for (const t of liveTables) if (t.selection.size) return true;
  return false;
};

function trackTable(host, getTracks, { origin, columns, onRemove, removeLabel, sortKey } = {}) {
  let tracks = getTracks();

  /* Building a thirty-track playlist used to be thirty right-clicks. Rows can
     be picked now, and every action that took one track takes the picked set
     instead. The bar only exists while something is picked. */
  const selection = new Selection(() => { list.refresh(); paintBar(); });
  const bar = el('div', { class: 'selbar', hidden: true, role: 'toolbar', 'aria-label': 'Selected tracks' });

  const factory = trackRowFactory({
    columns: columns || ['index', 'title', 'album', 'duration'],
    selection,
    onPlay: (i) => playAll(tracks, i, origin),
    onPick: (i, mods) => {
      const t = tracks[i];
      if (!t) return;
      if (mods.range) selection.range(tracks, t.id);
      else if (mods.toggle) selection.toggle(t.id);
      else if (selection.size === 1 && selection.has(t.id)) selection.clear();
      else selection.only(t.id);
    },
    onMenu: (i, anchor, event) => {
      const t = tracks[i];
      if (!t) return;
      /* Right-clicking inside a selection acts on the whole of it; right-
         clicking outside one is about the row under the pointer, and moves the
         selection there rather than silently acting on something off-screen. */
      if (!selection.has(t.id)) selection.only(t.id);
      const picked = selection.tracksIn(tracks);
      menu(trackMenu(picked.length ? picked : [t], {
        origin,
        onRemove: onRemove && (() => {
          for (const track of (picked.length ? picked : [t])) {
            onRemove(track, tracks.indexOf(track));
          }
          selection.clear();
        }),
        removeLabel,
      }), { anchor, event });
    },
  });

  const list = new VirtualList({ viewport: host, rowHeight: ROW_H, ...factory });
  list.setItems(tracks);

  /* On the body rather than in the page: it floats above the transport, and a
     list that scrolls must not scroll its own toolbar out of reach. */
  document.body.appendChild(bar);

  function paintBar() {
    const n = selection.size;
    bar.hidden = n === 0;
    if (!n) return;
    const picked = () => selection.tracksIn(tracks);
    bar.textContent = '';
    bar.append(
      el('span', { class: 'selbar-count', text: fmtCount(n, 'track', 'tracks') }),
      el('button', { class: 'btn sm primary', text: 'Play', onclick: () => {
        const p = picked(); if (p.length) player.playTracks(p, 0, origin); } }),
      el('button', { class: 'btn sm ghost', text: 'Play next', onclick: () => {
        const p = picked(); if (p.length) { player.playNext(p); toast(`${fmtCount(p.length, 'track', 'tracks')} up next`); } } }),
      el('button', { class: 'btn sm ghost', text: 'Queue', onclick: () => {
        const p = picked(); if (p.length) { player.enqueue(p); toast(`${fmtCount(p.length, 'track', 'tracks')} queued`); } } }),
      el('button', { class: 'btn sm ghost', text: 'More', onclick: (e) => {
        const p = picked(); if (p.length) menu(trackMenu(p, { origin }), { anchor: e.currentTarget }); } }),
      el('button', { class: 'icon-btn selbar-close', 'aria-label': 'Clear selection',
        html: ico('close'), onclick: () => selection.clear() }),
    );
  }

  /*
   * Type the name of the thing you want.
   *
   * Every file manager and every media player for thirty years has done this,
   * and typing in a list here did nothing at all — on a fifty-thousand track
   * library that means the only way to reach the S's is to throw the scrollbar
   * and look. Letters accumulate for three quarters of a second, so "bea"
   * finds *Beacon* rather than stopping at the first B, and the buffer clears
   * on a pause the way everybody expects it to.
   *
   * It matches on whichever column the list is currently ordered by, because
   * jumping alphabetically through a list sorted by length is not a feature,
   * it is a bug that happens to move the scrollbar.
   */
  let buffer = '';
  let bufferAt = 0;
  const jumpKey = (t) => {
    const k = sortKey && sortKey();
    if (k === 'album') return t.album || '';
    if (k === 'artist') return t.artist || '';
    return t.title || '';
  };
  const jumpTo = (prefix) => {
    const p = prefix.toLowerCase();
    const i = tracks.findIndex((t) => norm(jumpKey(t)).startsWith(p));
    if (i < 0) return false;
    // Top of the viewport, not the middle: a jump is "show me from here", and
    // centring buries the row you asked for under the ones before it.
    list.scrollToIndex(i, 'start');
    return true;
  };

  /* Escape clears; ctrl-A takes the lot — but only when the pointer is not in
     a text field, or select-all in the search box would select the library. */
  const onKey = (e) => {
    if (!host.isConnected) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '') ||
                   document.activeElement?.isContentEditable;
    if (e.key === 'Escape' && selection.size) { selection.clear(); e.stopPropagation(); return; }
    if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && !typing) {
      e.preventDefault();
      selection.all(tracks);
      return;
    }
    /* One printable character, no modifiers, nothing focused that wants it.
       The single-letter transport shortcuts live on the same keys, so this
       only takes over once a *second* character arrives inside the window —
       "n" is next track, "no" is looking for Nocturne. */
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1 || e.key === ' ') return;
    const now = performance.now();
    if (now - bufferAt > 750) buffer = '';
    bufferAt = now;
    const next = buffer + e.key;
    if (next.length < 2) { buffer = next; return; }
    if (jumpTo(next)) { buffer = next; e.preventDefault(); e.stopPropagation(); }
    else buffer = next;
  };
  document.addEventListener('keydown', onKey);

  // A star pressed anywhere — a row, the transport, a menu — has to land on
  // every visible copy of that track, so the rows on screen are repainted
  // rather than rebuilt: `refresh` rewrites what is live and moves nothing.
  const offFav = lib.events.on('favourites', () => list.refresh());

  const api = {
    list,
    bar,
    selection,
    update() {
      tracks = getTracks();
      list.setItems(tracks);
      // The list changed underneath the selection; anything gone is gone.
      selection.prune(tracks);
      paintBar();
    },
    refresh() { list.refresh(); },
    destroy() {
      offFav();
      document.removeEventListener('keydown', onKey);
      liveTables.delete(api);
      bar.remove();
      list.destroy();
    },
    get tracks() { return tracks; },
  };

  liveTables.add(api);
  return api;
}

function columnHeader(columns, sortState, onSort) {
  const head = el('div', { class: 'trow thead' });
  let html = '';
  if (columns.includes('index')) html += '<div class="trow-index">#</div>';
  html += '<div class="trow-main"><button class="sortable" data-sort="title">Title</button></div>';
  if (columns.includes('album')) html += '<div class="trow-album"><button class="sortable" data-sort="album">Album</button></div>';
  if (columns.includes('dr')) html += '<div class="trow-dr"><button class="sortable" data-sort="dr" title="Dynamic range">DR</button></div>';
  if (columns.includes('plays')) html += '<div class="trow-plays"><button class="sortable" data-sort="plays" title="How many times you have played it">Plays</button></div>';
  if (columns.includes('played')) html += '<div class="trow-played"><button class="sortable" data-sort="played" title="When you last played it">Last</button></div>';
  if (columns.includes('duration')) html += `<div class="trow-time"><button class="sortable" data-sort="duration">${ico('clock')}</button></div>`;
  html += '<div class="trow-actions"></div>';
  head.innerHTML = html;

  const paint = () => {
    for (const btn of head.querySelectorAll('.sortable')) {
      const active = btn.dataset.sort === sortState.key;
      btn.classList.toggle('is-active', active);
      btn.dataset.dir = active ? (sortState.dir > 0 ? 'asc' : 'desc') : '';
    }
  };
  head.addEventListener('click', (e) => {
    const btn = e.target.closest('.sortable');
    if (!btn) return;
    const key = btn.dataset.sort;
    if (sortState.key === key) sortState.dir *= -1;
    else { sortState.key = key; sortState.dir = 1; }
    paint();
    onSort();
  });
  paint();
  return head;
}

/*
 * The control that orders a wall.
 *
 * Songs has had sortable column headers since the first release, because a
 * table has somewhere to put them. A grid of records has no columns, so the
 * order was whatever the index happened to hold — and there was no way to ask
 * for 1978, or the longest record, or the one nobody has ever played.
 *
 * A menu rather than a row of segmented buttons: eight keys in a segmented
 * control is a wall of words competing with the four view modes beside it,
 * where a menu is one button that says what the order currently is. Choosing
 * the key that is already on turns it round, which is what a column header
 * does and is the thing people try first.
 *
 * The choice is remembered per list, because how you like to look at your
 * records is a way of working rather than a decision to retake every visit.
 */
function sortControl({ store, keys, fallback, onChange }) {
  let state = { key: fallback, dir: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(store) || 'null');
    if (saved && keys.some(([k]) => k === saved.key)) state = { key: saved.key, dir: saved.dir === -1 ? -1 : 1 };
  } catch { /* private */ }

  const labelOf = (k) => (keys.find(([key]) => key === k) || keys[0])[1];
  const btn = el('button', { class: 'btn ghost sm sort-btn', 'aria-haspopup': 'menu' });

  const paint = () => {
    btn.innerHTML = ico('sliders') +
      `<span>${labelOf(state.key)}</span>` +
      `<span class="sort-dir" aria-hidden="true">${state.dir > 0 ? '↑' : '↓'}</span>`;
    btn.setAttribute('aria-label',
      `Sorted by ${labelOf(state.key).toLowerCase()}, ${state.dir > 0 ? 'ascending' : 'descending'}. Change`);
    try { localStorage.setItem(store, JSON.stringify(state)); } catch { /* private */ }
  };

  btn.addEventListener('click', (e) => {
    menu(keys.map(([k, label]) => ({
      label,
      checked: k === state.key,
      // The arrow is on the row that is already chosen, because that is the
      // one where picking it again means "the other way round".
      hint: k === state.key ? (state.dir > 0 ? '↑' : '↓') : '',
      onSelect: () => {
        if (state.key === k) state.dir *= -1; else { state.key = k; state.dir = 1; }
        paint();
        onChange(state);
      },
    })), { anchor: e.currentTarget });
  });

  paint();
  return { node: btn, get state() { return state; } };
}

/*
 * The letter rail.
 *
 * A fifty-thousand track list is virtualised so it costs nothing to draw, and
 * until now the only way to reach the S's was to throw the scrollbar and watch
 * the rows go past. The rail is the oldest answer to that and it is still the
 * right one — and it is nearly free here, because the sorted array already
 * knows the index of the first row under every letter, so a jump is one
 * `scrollTo` and no search.
 *
 * Letters the library has nothing under are still drawn, and dimmed. A rail
 * that only shows the letters you own changes shape as the collection grows,
 * which makes it something you have to read rather than something your hand
 * learns — and the gaps are information: a collection with no Q in it looks
 * like one.
 */
const RAIL_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/* A leading digit, a leading symbol and a leading article all belong under "#"
   rather than under whatever character happens to be first. Shared, because
   the A–Z rail and the shelf's dividers have to agree about which letter a
   record files under — and both have to agree with the sort, which uses the
   same `norm`. */
function letterOf(v) {
  const c = norm(v).trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

function letterRail({ getItems, keyOf, onJump }) {
  const node = el('div', { class: 'az-rail', role: 'navigation', 'aria-label': 'Jump to a letter' });
  const buttons = new Map();
  for (const ch of RAIL_LETTERS) {
    const b = el('button', { class: 'az-key', text: ch, 'aria-label': `Jump to ${ch === '#' ? 'numbers' : ch}` });
    b.addEventListener('click', () => {
      const i = indexOf(ch);
      if (i >= 0) onJump(i);
    });
    buttons.set(ch, b);
    node.appendChild(b);
  }

  const bucket = letterOf;

  let first = new Map();
  function indexOf(ch) { return first.has(ch) ? first.get(ch) : -1; }

  function measure() {
    const items = getItems();
    first = new Map();
    for (let i = 0; i < items.length; i++) {
      const ch = bucket(keyOf(items[i]));
      if (!first.has(ch)) first.set(ch, i);
    }
    for (const [ch, b] of buttons) b.classList.toggle('is-empty', !first.has(ch));
  }

  measure();
  return { node, measure };
}

/* ------------------------------------------------------------------ cards */

export function albumCard(album, { onOpen } = {}) {
  const card = el('article', { class: 'card', tabindex: '0', role: 'button' });
  card.innerHTML =
    '<div class="card-art sleeve-stage">' +
      '<div class="sleeve">' +
        '<i class="art-edge" aria-hidden="true"></i>' +
        '<div class="art art-3d"><img class="art-img" alt="" decoding="async"></div>' +
      '</div>' +
      '<i class="card-tick tl"></i><i class="card-tick br"></i>' +
      '<button class="fab card-fab" tabindex="-1" aria-label="Play">' + ico('play') + '</button>' +
    '</div>' +
    '<div class="card-title"></div><div class="card-sub"></div>';

  // The sleeve turns toward the pointer on a spring and takes its light with
  // it: the tilt publishes where the pointer is, and the stylesheet slides the
  // highlight, the rim and the shadow to match. The ticks and the play button
  // stay on the stage rather than on the sleeve — they are marks *on* the
  // interface, and a target that tilts away is a target you cannot hit.
  tilt3d(card.querySelector('.sleeve'), { max: 10, lift: 22, scale: 1.02 });

  card.querySelector('.card-fab').addEventListener('click', (e) => {
    e.stopPropagation();
    const key = card.dataset.key;
    const al = albumOf(key);
    if (al) playAll(al.tracks, 0, { type: 'album', key, label: al.title });
  });
  const open = () => {
    if (onOpen) return onOpen(card.dataset.key);
    // The cover you clicked is the thing that should arrive on the next page,
    // so it is named on the way out and the album's record is named on the way
    // in. Everything else about the two pages cross-fades around it.
    markTransition(card.querySelector('.sleeve'));
    location.hash = '#/album/' + card.dataset.key;
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const al = albumOf(card.dataset.key);
    if (al) menu(trackMenu(al.tracks, { origin: { type: 'album', key: al.key, label: al.title } }), { event: e });
  });

  if (album) renderAlbumCard(card, album);
  return card;
}

/**
 * How thick a record is: a single is a card, a double LP is a slab.
 *
 * Twelve tracks is the length of an ordinary album and sits at 1, which is the
 * thickness the edge plane was drawn for. Clamped hard at both ends, because a
 * one-track release still has to be a physical object and a 90-track box set
 * cannot be allowed to become a wall.
 */
const thicknessOf = (album) =>
  Math.max(0.45, Math.min(1.9, Math.sqrt((album.tracks.length || 1) / 12)));

export function renderAlbumCard(card, album) {
  card.dataset.key = album.key;
  paintArt(card.querySelector('.art-img'), album.key);
  card.querySelector('.sleeve')?.style.setProperty('--thick', thicknessOf(album).toFixed(3));
  // Two extra plates behind a record that came on more than one disc. Drawn by
  // the sleeve's own pseudo-elements, so a set costs no more DOM than a single.
  const discs = Math.min(3, new Set(album.tracks.map((t) => t.disc || 1)).size);
  const sleeve = card.querySelector('.sleeve');
  if (sleeve) { if (discs > 1) sleeve.dataset.discs = String(discs); else delete sleeve.dataset.discs; }
  const t = card.querySelector('.card-title');
  if (t.textContent !== album.title) t.textContent = album.title;
  const s = card.querySelector('.card-sub');
  const sub = album.year ? `${album.artist} · ${album.year}` : album.artist;
  if (s.textContent !== sub) s.textContent = sub;
}

function artistCard(artist) {
  const card = el('article', { class: 'card card-artist', tabindex: '0', role: 'button' });
  card.innerHTML =
    '<div class="card-art sleeve-stage round">' +
      '<div class="sleeve">' +
        '<i class="art-edge" aria-hidden="true"></i>' +
        '<div class="art art-3d"><img class="art-img" alt="" decoding="async"></div>' +
      '</div>' +
      '<button class="fab card-fab" tabindex="-1" aria-label="Play">' + ico('play') + '</button>' +
    '</div>' +
    '<div class="card-title"></div><div class="card-sub"></div>';
  tilt3d(card.querySelector('.sleeve'), { max: 9, lift: 18, scale: 1.025 });
  const open = () => (location.hash = '#/artist/' + card.dataset.key);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  card.querySelector('.card-fab').addEventListener('click', (e) => {
    e.stopPropagation();
    const a = artistOf(card.dataset.key);
    if (a) shuffleAll(a.tracks, { type: 'artist', key: a.key, label: a.name });
  });
  if (artist) renderArtistCard(card, artist);
  return card;
}

function renderArtistCard(card, artist) {
  card.dataset.key = artist.key;
  const first = artist.albumList?.[0];
  paintArt(card.querySelector('.art-img'), first ? first.key : artist.key);
  card.querySelector('.card-title').textContent = artist.name;
  card.querySelector('.card-sub').textContent =
    `${fmtCount(artist.albumList?.length || 0, 'album')} · ${fmtCount(artist.tracks.length, 'track')}`;
}

/** Horizontal, non-virtualised strip used on Home. */
function shelf(title, items, makeCard, { seeAll } = {}) {
  if (!items.length) return null;
  const wrap = el('section', { class: 'shelf' });
  wrap.appendChild(sectionHead(title, seeAll ? 'See all' : null, () => (location.hash = seeAll)));

  const rail = el('div', { class: 'rail' });
  for (const item of items) rail.appendChild(makeCard(item));

  const page = (dir) => rail.scrollBy({ left: dir * rail.clientWidth * 0.82, behavior: 'smooth' });
  const prev = el('button', { class: 'rail-nav prev', 'aria-label': 'Scroll left', hidden: true, html: ico('chev-left'), onclick: () => page(-1) });
  const next = el('button', { class: 'rail-nav next', 'aria-label': 'Scroll right', hidden: true, html: ico('chev-right'), onclick: () => page(1) });

  const sync = () => {
    const max = rail.scrollWidth - rail.clientWidth;
    prev.hidden = rail.scrollLeft < 4;
    next.hidden = max < 4 || rail.scrollLeft > max - 4;
    // The rack only turns on a rail that can actually be flipped through. A
    // view timeline on a scroller with nowhere to scroll never advances, and
    // the cards would sit frozen on the first keyframe — permanently askew.
    rail.classList.toggle('is-flippable', max > 4);
  };
  rail.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(rail);

  wrap.appendChild(el('div', { class: 'rail-wrap' }, rail, prev, next));
  // The cards are revealed by viewHome once the whole page is in the document:
  // an IntersectionObserver on a node that is still in a fragment observes
  // nothing, and a shelf four screens down should not have played its arrival
  // before anyone has scrolled to it.
  return wrap;
}

/* ------------------------------------------------------------------ flourish */

/**
 * The vector on the home header: a dial. Fifty-six spokes, two rings, a
 * crosshair and a sweep, all generated rather than drawn by hand — so it
 * scales to any size, takes the accent with it, and costs one element and no
 * requests.
 */
function soundBloom() {
  const R = 110, spokes = 56;
  let d = '';
  for (let i = 0; i < spokes; i++) {
    const angle = (i / spokes) * Math.PI * 2;
    const wobble = Math.sin(i * 0.72) * 0.5 + Math.sin(i * 0.23 + 1.7) * 0.5;
    const inner = 54 + wobble * 4;
    const len = 10 + Math.abs(Math.sin(i * 0.9 + 0.6)) * 30;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    d += `M${(R + cos * inner).toFixed(2)} ${(R + sin * inner).toFixed(2)}` +
         `L${(R + cos * (inner + len)).toFixed(2)} ${(R + sin * (inner + len)).toFixed(2)}`;
  }

  // A 70° wedge from the centre — the sweep.
  const a0 = -0.61, a1 = 0.61, rad = 96;
  const wedge = `M${R} ${R} L${(R + Math.cos(a0) * rad).toFixed(2)} ${(R + Math.sin(a0) * rad).toFixed(2)}` +
                ` A${rad} ${rad} 0 0 1 ${(R + Math.cos(a1) * rad).toFixed(2)} ${(R + Math.sin(a1) * rad).toFixed(2)} Z`;

  const node = el('div', { class: 'bloom', 'aria-hidden': 'true' });
  node.innerHTML =
    `<svg viewBox="0 0 220 220" fill="none">
       <defs>
         <radialGradient id="bloomSweep" cx="0.5" cy="0.5" r="0.5">
           <stop offset="0" stop-color="rgb(var(--accent-rgb))" stop-opacity=".34"/>
           <stop offset="1" stop-color="rgb(var(--accent-rgb))" stop-opacity="0"/>
         </radialGradient>
       </defs>
       <path class="bloom-sweep" d="${wedge}"/>
       <circle class="bloom-ring" cx="110" cy="110" r="48"/>
       <circle class="bloom-ring bloom-ring-2" cx="110" cy="110" r="96"/>
       <path class="bloom-cross" d="M110 6 V38 M110 182 V214 M6 110 H38 M182 110 H214"/>
       <g class="bloom-spokes"><path d="${d}"/></g>
       <g class="bloom-core">
         <rect x="99" y="99" width="4" height="22"/>
         <rect x="106" y="92" width="4" height="36"/>
         <rect x="113" y="102" width="4" height="18"/>
       </g>
     </svg>`;
  return node;
}

/* ------------------------------------------------------------------ HOME */

function viewHome(host) {
  const frag = document.createDocumentFragment();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const total = lib.trackCount();
  if (!total) {
    host.appendChild(emptyState({
      icon: 'folder',
      title: 'Your library is empty',
      note: 'Point Sonora at a folder of music on this computer. Nothing is uploaded — files are read straight off your disk.',
      action: { label: 'Add music folder', onSelect: () => document.dispatchEvent(new CustomEvent('sonora:add')) },
    }));
    return () => {};
  }

  const all = lib.allTracks();
  const recentTrack = lib.recentTracks()[0];

  const title = el('h1', { class: 'page-title grad-text', text: 'Your library' });
  /* Not named `stats`: this function also reads the listening stats module,
     and an element by that name shadowed the import — `stats.forTrack` then
     resolved to an HTMLElement and threw on every Home render. */
  const countLine = el('p', { class: 'page-sub' });
  const head = el('header', { class: 'home-hero' },
    el('div', { class: 'home-hero-text' },
      el('p', { class: 'eyebrow', text: greeting }),
      title,
      countLine,
      el('div', { class: 'hero-actions' },
        el('button', {
          class: 'btn primary', html: ico('shuffle') + '<span>Shuffle everything</span>',
          onclick: () => shuffleAll(all, { type: 'all', label: 'Your library' }),
        }),
        recentTrack ? el('button', {
          class: 'btn ghost', html: ico('play') + '<span>Resume</span>',
          title: recentTrack.title,
          onclick: () => playAll(lib.recentTracks(), 0, { type: 'recent', label: 'Recently played' }),
        }) : null,
        el('button', {
          class: 'btn ghost', html: ico('expand') + '<span>Visualiser</span>',
          onclick: () => document.dispatchEvent(new CustomEvent('sonora:stage')),
        }))),
    soundBloom());
  frag.appendChild(head);

  // The count rolls up rather than appearing: a readout settling on a value.
  const counted = el('span');
  countLine.append(counted, ' tracks \u00b7 ',
    `${lib.state.albums.length} albums \u00b7 ${lib.state.artists.length} artists \u00b7 ` +
    fmtTotal(all.reduce((n, t) => n + (t.duration || 0), 0)).toUpperCase());
  readout(counted, total, { duration: 1100 });
  decode(title, 'Your library', { duration: 700 });

  const recent = lib.recentAlbums(10);
  const shelfRecent = shelf('Jump back in', recent, (a) => albumCard(a));
  if (shelfRecent) frag.appendChild(shelfRecent);

  const added = lib.state.albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 10);
  const shelfAdded = shelf('Recently added', added, (a) => albumCard(a), { seeAll: '#/albums' });
  if (shelfAdded) frag.appendChild(shelfAdded);

  const topArtists = lib.state.artists.slice()
    .sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 10);
  const shelfArtists = shelf('Artists', topArtists, (a) => artistCard(a), { seeAll: '#/artists' });
  if (shelfArtists) frag.appendChild(shelfArtists);

  /* This day, other years.
   *
   * Every play has been stamped since the history existed, and nothing has
   * ever read those stamps for anything but ordering. A shelf of what you were
   * playing a year ago today costs one filter and gives a local library the
   * one thing no streaming service can honestly offer: a memory that belongs
   * to you, computed on your machine, from a log nobody else has a copy of.
   *
   * Only shown when there is genuinely something there. A shelf that says
   * "nothing yet" every day for a year is worse than no shelf. */
  const today = new Date();
  const anniversaries = [];
  const seenAlbums = new Set();
  for (const t of lib.allTracks()) {
    if (!t.lastPlayed) continue;
    const d = new Date(t.lastPlayed);
    if (d.getFullYear() >= today.getFullYear()) continue;      // this year is not a memory
    if (d.getMonth() !== today.getMonth() || d.getDate() !== today.getDate()) continue;
    const al = lib.state.albumBy.get(t.albumKey);
    if (al && !seenAlbums.has(al.key)) { seenAlbums.add(al.key); anniversaries.push(al); }
  }
  const shelfThen = shelf('On this day', anniversaries.slice(0, 10), (a) => albumCard(a));
  if (shelfThen) frag.appendChild(shelfThen);

  /* Records where one track has all the listening.
   *
   * Sonora counts seconds rather than plays, so it can tell the difference
   * between a record you have listened to and a record you own. An album where
   * one track has most of the time and the rest have almost none is a specific
   * and common situation — either you love one song, or you never gave the
   * thing a chance — and it is the most interesting page a local library can
   * show you about itself.
   */
  const lopsided = [];
  for (const al of lib.state.albums) {
    if (!al.tracks || al.tracks.length < 4) continue;
    const secs = al.tracks.map((t) => stats.forTrack(t.id) || 0);
    const total = secs.reduce((s, v) => s + v, 0);
    if (total < 120) continue;                                  // barely touched either way
    const top = Math.max(...secs);
    // Most of the listening in one track, and the rest of the record cold.
    const share = top / total;
    if (share > 0.7) lopsided.push({ album: al, share });
  }
  lopsided.sort((a, b) => b.share - a.share);
  const shelfOne = shelf('One song from these', lopsided.slice(0, 10).map((x) => x.album),
    (a) => albumCard(a));
  if (shelfOne) frag.appendChild(shelfOne);

  /* Records you have never once played.
   *
   * `playCount` has been counted since the first release and nothing had ever
   * asked it this question, which is a shame, because on a large collection it
   * is the most useful one there is: not "what do you like" — every other shelf
   * on this page answers that — but "what is in here that you have never
   * heard". A local library accumulates records the way a shelf accumulates
   * books, and the unplayed ones are invisible precisely because nothing ever
   * surfaces them.
   *
   * Oldest first, so the ones that have been waiting longest come up.
   */
  const untouched = lib.state.albums
    .filter((al) => !al.plays && al.tracks.length)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const shelfNew = shelf('Never played', untouched.slice(0, 10), (a) => albumCard(a));
  if (shelfNew) frag.appendChild(shelfNew);

  /* And records you used to play and have not been back to.
   *
   * The other half of the same idea, and the one that reads as a suggestion
   * rather than as an accusation: something you played enough to mean it and
   * have not touched in a year. A record with two plays a year ago is a record
   * you tried; one with twenty is one you loved and forgot.
   */
  const YEAR = 365 * 24 * 3600 * 1000;
  const lapsed = lib.state.albums
    .filter((al) => al.plays >= 5 && al.lastPlayed && Date.now() - al.lastPlayed > YEAR)
    .sort((a, b) => b.plays - a.plays);
  const shelfBack = shelf('You used to play these', lapsed.slice(0, 10), (a) => albumCard(a));
  if (shelfBack) frag.appendChild(shelfBack);

  // A compact "surprise me" strip: random albums, reshuffled on every visit.
  const pool = lib.state.albums.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const shelfRandom = shelf('From the shelf', pool.slice(0, 10), (a) => albumCard(a));
  if (shelfRandom) frag.appendChild(shelfRandom);

  host.appendChild(frag);
  enter([head], { y: 12, z: -60 });

  // Each shelf arrives as it is scrolled to, and its records come up out of
  // depth rather than sliding in from the side. Observers, not a scroll
  // handler: the crossing is computed off the main thread, which is the only
  // version of this that a virtualised list further down the page can afford.
  // Each shelf arrives as one thing rather than as a stagger of cards, and the
  // observer is pointed at the shelf itself. Both follow from
  // `content-visibility: auto`: a skipped subtree has no boxes, so an observer
  // watching the cards inside it would be watching nothing — while the shelf
  // is exactly the element the browser is already deciding about. The cards
  // get their own motion from the rack as you flip through them.
  const offShelves = reveal(host.querySelectorAll('.shelf'), { y: 26, z: -110, rotate: 3, each: 0, duration: 700 });
  return () => offShelves();
}

/* ------------------------------------------------------------------ SONGS */

const songSort = { key: 'title', dir: 1 };

function viewSongs(host) {
  const columns = ['index', 'art', 'title', 'album', 'dr', 'plays', 'played', 'duration'];
  const all = lib.allTracks();
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Songs' }),
    el('p', { class: 'page-sub', text: `${fmtCount(all.length, 'track')} · ${fmtTotal(all.reduce((s, t) => s + (t.duration || 0), 0))}` }));
  const get = () => lib.sortTracks(lib.allTracks(), songSort.key, songSort.dir);

  const bar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('play') + '<span>Play all</span>', onclick: () => playAll(get(), 0, { type: 'all', label: 'All songs' }) }),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(get(), { type: 'all', label: 'All songs' }) }));

  host.appendChild(head);
  host.appendChild(bar);
  decode(head.querySelector('.page-title'), 'Songs');

  const header = columnHeader(columns, songSort, () => { table.update(); syncRail(); });
  host.appendChild(header);

  const table = trackTable(host, get, {
    origin: { type: 'all', label: 'All songs' }, columns,
    sortKey: () => songSort.key,
  });

  /* Only where the order is alphabetical. A rail down a list sorted by length
     would move the scrollbar and land nowhere, which is worse than not
     offering it — so it is hidden rather than left to mislead. */
  const LETTERED = new Set(['title', 'artist', 'album']);
  const rail = letterRail({
    getItems: () => table.tracks,
    keyOf: (t) => (songSort.key === 'album' ? t.album : songSort.key === 'artist' ? t.artist : t.title),
    onJump: (i) => table.list.scrollToIndex(i, 'start'),
  });
  /* On `.main`, not inside `#view`.
     The rail must stay put while the list it steers scrolls past it, and
     anything appended to the scroller scrolls with it. `.main` is the frame
     around the scroller and is already positioned, so the rail sits against
     the right edge of whatever width the view currently has — which changes
     when the queue pane opens, and should. */
  const frame = host.parentElement || host;
  frame.appendChild(rail.node);
  const syncRail = () => {
    rail.node.hidden = !LETTERED.has(songSort.key) || table.tracks.length < 40;
    if (!rail.node.hidden) rail.measure();
  };
  syncRail();

  enter([head, bar], { y: 10 });

  const off = lib.events.on('change', () => { table.update(); syncRail(); });
  return () => { off(); rail.node.remove(); table.destroy(); };
}

/* ------------------------------------------------------------------ ALBUMS */

function viewAlbums(host) {
  const albums = lib.state.albums;
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Albums' }),
    el('p', { class: 'page-sub', text: fmtCount(albums.length, 'album') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Albums');

  if (!albums.length) {
    host.appendChild(emptyState({ icon: 'album', title: 'No albums yet', note: 'Add a folder to get started.' }));
    return () => {};
  }

  /* Two ways to look at a wall of records: as a wall, or as a crate you flip
     through. The choice is remembered, because it is a way of working rather
     than a novelty to be re-chosen every visit. */
  const MODES = ['grid', 'crate', 'shelf', 'floor'];
  let mode = 'grid';
  try {
    const saved = localStorage.getItem(ALBUM_VIEW);
    if (MODES.includes(saved)) mode = saved;
  } catch { /* private */ }

  const bar = el('div', { class: 'toolbar' }, el('div', { class: 'segmented', role: 'tablist' }));
  const seg = bar.firstChild;
  for (const [id, label] of [['grid', 'Grid'], ['crate', 'Crate'], ['shelf', 'Shelf'], ['floor', 'Floor']]) {
    seg.appendChild(el('button', {
      class: 'seg' + (id === mode ? ' is-on' : ''), role: 'tab', text: label,
      'aria-selected': id === mode ? 'true' : 'false',
      onclick: () => setMode(id),
    }));
  }
  /* The Floor orders itself by release year — that is the whole of what it is —
     so the control is hidden there rather than offered and ignored. */
  const sorter = sortControl({
    store: ALBUM_SORT,
    fallback: 'artist',
    keys: [['artist', 'Artist'], ['title', 'Title'], ['year', 'Year'], ['added', 'Recently added'],
           ['length', 'Length'], ['tracks', 'Track count'], ['plays', 'Times played'], ['played', 'Last played']],
    onChange: () => { setMode(mode, true); },
  });
  bar.appendChild(sorter.node);
  host.appendChild(bar);

  const ordered = () => lib.sortAlbums(lib.state.albums, sorter.state.key, sorter.state.dir);
  /* Which key the wall is sorted by, hung off the function itself so a view
     that wants to group by it — the shelf's dividers — can read it without
     being handed a second argument it would have to thread through four
     mounts. */
  Object.defineProperty(ordered, 'sort', { get: () => sorter.state.key });

  const slot = el('div', { class: 'album-slot' });
  host.appendChild(slot);

  let teardown = () => {};
  function setMode(next, force) {
    if (next === mode && slot.firstChild && !force) return;
    mode = next;
    try { localStorage.setItem(ALBUM_VIEW, mode); } catch { /* private */ }
    for (const b of seg.children) {
      const on = b.textContent.toLowerCase() === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    try { teardown(); } catch (err) { console.warn(err); }
    slot.textContent = '';
    host.classList.toggle('albums-floor', mode === 'floor');
    sorter.node.hidden = mode === 'floor';
    teardown = mode === 'crate' ? mountCrate(slot, ordered)
             : mode === 'shelf' ? mountShelf(slot, ordered)
             : mode === 'floor' ? mountFloor(slot, host)
             : mountGrid(slot);
  }

  function mountGrid(into) {
    const grid = new VirtualGrid({
      viewport: host, minCell: 168, gap: 22, aspect: 1, footer: 64,
      create: () => albumCard(null),
      render: (node, album) => renderAlbumCard(node, album),
    });
    grid.setItems(ordered());
    const off = lib.events.on('change', () => grid.setItems(ordered()));
    const offArt = lib.events.on('art', () => grid.refresh());
    void into;
    return () => { off(); offArt(); grid.destroy(); };
  }

  setMode(mode);
  enter([head, bar], { y: 10 });
  return () => { try { teardown(); } catch (err) { console.warn(err); } };
}

const ALBUM_VIEW = 'sonora:albumview';
const ALBUM_SORT = 'sonora:albumsort';
const ARTIST_SORT = 'sonora:artistsort';

/* ------------------------------------------------------------------ shelf */

/**
 * Records on a shelf, seen edge-on.
 *
 * The one way of storing records that every other view here refuses to
 * consider, and the way almost everybody actually stores them. A wall of
 * covers is a shop; a shelf of spines is a collection, and reading along it is
 * a different and older kind of browsing.
 *
 * The width of each spine is the album's own thickness — the same `--thick`
 * the sleeve has been using to decide how far its edge plane sits behind its
 * face, derived from how many tracks are on the record. Nothing new is
 * computed; a value that was being used for a shadow is used for a width, and
 * a double album is visibly fatter than a single.
 *
 * The spine turns to face you as you point at it, which is what a hand does to
 * a record it is considering.
 */
function mountShelf(host, ordered) {
  /*
   * Windowed, like the crate is.
   *
   * The first version built one element per album and rebuilt every one of
   * them on each `change` and each `art` event — which during an import is a
   * full DOM rebuild several times a second, on the thread that also has to
   * answer scrolling. The crate next door keeps eleven records in the DOM
   * however large the library is; a shelf drawn the naive way was the one
   * album view that did not scale, which is a poor showing for the view whose
   * whole premise is a collection too big for a wall.
   *
   * A spine is a fixed width for a given thickness, so the run's total width
   * is known without measuring and only the spines inside the scrolled window
   * need to exist. The spacer either side holds the scroll range open.
   */
  const shelf = el('div', { class: 'shelf-run', role: 'list', 'aria-label': 'Albums by spine' });
  const before = el('div', { class: 'shelf-pad', 'aria-hidden': 'true' });
  const after = el('div', { class: 'shelf-pad', 'aria-hidden': 'true' });
  shelf.append(before, after);

  /* Width of one spine, in px, matching the CSS: 13 + 11 × thickness. Kept in
     step with `.spine { width: calc(13px + 11px * var(--thick)) }` — if that
     changes, this has to. */
  const GAP = 2;
  const widthOf = (album) => 13 + 11 * thicknessOf(album) + GAP;

  let albums = [];
  let offsets = [];          // running x position of each spine
  let tabs = [];             // { at, x, label } dividers between groups
  let total = 0;
  const live = new Map();    // album key -> element, for what is on screen now
  const liveTabs = new Map();

  /* R3: the dividers.
   *
   * What makes a real shelf navigable is not the spines — a hundred of them
   * read as one undifferentiated run — it is the cards standing proud between
   * the groups. Which groups is not this function's decision to make: it is
   * whatever the shelf is currently sorted by, so an artist sort gets initials
   * and a year sort gets decades. Sorted by anything else, a divider would be
   * a card with nothing written on it, so there are none. */
  const TAB_W = 26;

  function tabFor(album, sort) {
    if (sort === 'artist' || sort === 'title') {
      return letterOf(sort === 'artist' ? album.artist : album.title);
    }
    if (sort === 'year') return album.year > 0 ? String(Math.floor(album.year / 10) * 10) + 's' : 'No year';
    return null;
  }

  function measure() {
    albums = ordered ? ordered() : lib.state.albums;
    const sort = (ordered && ordered.sort) || '';
    offsets = new Array(albums.length);
    tabs = [];
    let x = 0;
    let last = null;
    for (let i = 0; i < albums.length; i++) {
      const t = tabFor(albums[i], sort);
      if (t && t !== last) { tabs.push({ at: i, x, label: t }); x += TAB_W; last = t; }
      offsets[i] = x;
      x += widthOf(albums[i]);
    }
    total = x;
  }

  function build(album) {
    const spine = el('a', {
      class: 'spine', role: 'listitem', href: '#/album/' + album.key,
      style: `--thick:${thicknessOf(album).toFixed(3)}`,
      'aria-label': `${album.title} by ${album.artist}`,
    },
      el('span', { class: 'spine-face', style: { background: placeholderStyle(album.key) } }),
      el('span', { class: 'spine-text' },
        el('b', { class: 'spine-title', text: album.title }),
        el('span', { class: 'spine-artist', text: album.artist })),
      el('span', { class: 'spine-edge', 'aria-hidden': 'true' }));
    // The colour the importer pulled out of the cover, so a shelf of spines
    // is still recognisably a shelf of *these* records.
    const rgb = lib.accentFor(album.key);
    if (rgb) spine.style.setProperty('--spine-rgb', rgb.join(' '));
    return spine;
  }

  let raf = 0;
  function place() {
    raf = 0;
    if (!albums.length) return;
    const left = shelf.scrollLeft;
    const right = left + shelf.clientWidth;
    // A screen either side, so flicking sideways never shows a gap.
    const pad = shelf.clientWidth;

    let from = 0, to = albums.length - 1;
    while (from < albums.length && offsets[from] + widthOf(albums[from]) < left - pad) from++;
    while (to >= 0 && offsets[to] > right + pad) to--;

    const wanted = new Set();
    for (let i = from; i <= to; i++) wanted.add(albums[i].key);

    for (const [key, node] of live) {
      if (!wanted.has(key)) { node.remove(); live.delete(key); }
    }
    for (let i = from; i <= to; i++) {
      const album = albums[i];
      if (live.has(album.key)) continue;
      const node = build(album);
      node.style.position = 'absolute';
      node.style.left = offsets[i] + 'px';
      shelf.appendChild(node);
      live.set(album.key, node);
    }
    /* The dividers, windowed the same way the spines are. There are far fewer
       of them than there are records, but a library sorted by title has
       twenty-seven and a shelf shows six — building all of them would be the
       one un-virtualised thing in a view whose whole point is that it is
       virtualised. */
    const wantTabs = new Set();
    for (const t of tabs) if (t.x > left - pad && t.x < right + pad) wantTabs.add(t.label + '@' + t.at);
    for (const [id, node] of liveTabs) {
      if (!wantTabs.has(id)) { node.remove(); liveTabs.delete(id); }
    }
    for (const t of tabs) {
      const id = t.label + '@' + t.at;
      if (!wantTabs.has(id) || liveTabs.has(id)) continue;
      const node = el('span', { class: 'shelf-tab', 'aria-hidden': 'true', text: t.label });
      node.style.left = t.x + 'px';
      shelf.appendChild(node);
      liveTabs.set(id, node);
    }

    before.style.width = total + 'px';
  }

  function rebuild() {
    for (const node of live.values()) node.remove();
    for (const node of liveTabs.values()) node.remove();
    live.clear();
    liveTabs.clear();
    measure();
    place();
  }

  /* An art batch changes colours, not the arrangement — so it repaints what is
     on screen instead of rebuilding the shelf. This is the event that fires
     several times a second during a scan. */
  function repaintColours() {
    for (const [key, node] of live) {
      const rgb = lib.accentFor(key);
      if (rgb) node.style.setProperty('--spine-rgb', rgb.join(' '));
    }
  }

  const onScroll = () => { if (!raf) raf = requestAnimationFrame(place); };
  shelf.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => place());
  ro.observe(shelf);

  host.appendChild(shelf);
  rebuild();

  const off = lib.events.on('change', rebuild);
  const offArt = lib.events.on('art', repaintColours);
  return () => {
    off(); offArt(); ro.disconnect();
    shelf.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}

/* ------------------------------------------------------------------ floor */

/**
 * The library standing on the world behind it.
 *
 * Sonora draws a real 3D room and then floats a flat interface in front of it,
 * and the two have never touched. Every depth effect so far — the sleeve, the
 * rack, the crate — happens on the flat layer in its own pocket of perspective.
 * This puts the records on the backdrop's own ground plane, so the world is a
 * place the library is standing in rather than wallpaper behind it.
 *
 * Three things had to be answered, and each answer is also a design decision:
 *
 *   Legibility. Titles at the far plane are unreadable, so titles do not
 *   recede at all — they fade out past the third row. Distant rows become
 *   covers only, which is what a room full of records actually looks like.
 *
 *   Scroll length. Perspective compresses, so a three-hundred-album library
 *   would become a corridor nobody reaches the end of. The Z range is bounded:
 *   past the far plane rows stop receding and the list scrolls linearly.
 *
 *   Hit testing. The browser inverts the transform for clicks, so those still
 *   land — but keyboard order and drag-selection stop matching what the eye
 *   sees. That is why this is a fourth mode beside Grid, Crate and Shelf and
 *   never the only way to see the library.
 */
function mountFloor(host, viewport) {
  const ROW_DEPTH = 210;              // px of Z between one row and the next
  const FAR = 6;                      // rows past which nothing recedes further
  const NEAR_ROWS = 3;                // rows that still get a readable title
  const SLOT = 194;                   // px of X per album, cover plus its gap

  /* An empty year still costs something to walk past, because the emptiness is
     information — a collection with nothing between 1979 and 1994 should feel
     like it. Not a full row each, though: at full depth a fifteen-year gap is
     a corridor with nothing in it, and the point is to notice the gap, not to
     be punished for it. A quarter of a row, and the run is capped. */
  const GAP_DEPTH = 0.28;
  const GAP_MAX = 2.2;                // rows, however long the drought

  const stage = el('div', {
    class: 'floor', tabindex: '0', role: 'group',
    'aria-label': 'Albums by year. Scroll to walk through the years, left and right arrows to walk sideways, ' +
      'Enter to step into the room, P to walk to what is playing.',
  });
  /* Everything that is not the room itself lives on one layer above it.
   *
   * It has to be a layer rather than two sticky siblings: a sticky element
   * pins where its *flow* position reaches the top, so a rail placed after the
   * camera would only pin after 78vh of scrolling, which is to say never at
   * the top of the page where it is wanted. The HUD takes no height at all,
   * so the camera still begins at the top of the scroll range, and everything
   * on it is placed against the frame rather than against the floor. */
  const hud = el('div', { class: 'floor-hud' });
  stage.appendChild(hud);
  hud.appendChild(el('p', {
    class: 'floor-hint label',
    text: 'Scroll to walk · ← → sideways · Enter to step in · P for what is playing',
  }));
  const camera = el('div', { class: 'floor-camera' });
  stage.appendChild(camera);

  /* R2: the decades, down the right edge.
   *
   * The Floor is walked by scrolling and by nothing else, and over forty years
   * that is a long walk with the decade markings on the ground as the only
   * indication of where you are. The rail is the same information standing up:
   * which decades this library actually has, which one you are in, and a way
   * to arrive at one without walking past everything in between.
   *
   * `lanesFor()` already works the decades out to place the markers, so this
   * reads them off `rows` rather than computing anything of its own. */
  const rail = el('nav', { class: 'floor-rail', 'aria-label': 'Decades' });
  hud.appendChild(rail);
  let railBtns = [];

  function buildRail() {
    rail.textContent = '';
    railBtns = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const lane = rows[i];
      const key = lane.undated ? 'undated' : Math.floor(lane.year / 10) * 10;
      if (seen.has(key)) continue;
      seen.add(key);
      const btn = el('button', {
        class: 'floor-rail-btn',
        text: lane.undated ? 'No year' : String(key).slice(2) + 's',
        title: lane.undated ? 'Records with no year' : String(key) + 's',
      });
      btn.dataset.row = i;
      btn.addEventListener('click', () => walkTo(i));
      rail.appendChild(btn);
      railBtns.push(btn);
    }
    rail.hidden = railBtns.length < 2;
  }

  /** Puts the camera in front of row `r`, scrolling rather than jumping. */
  function walkTo(r, { x = null, smooth = true } = {}) {
    const lane = rows[r];
    if (!lane) return;
    if (x !== null) camX = Math.max(0, Math.min(maxX, x));
    viewport.scrollTo({ top: lane.at * ROW_DEPTH, behavior: smooth && !reduceMotion.matches ? 'smooth' : 'instant' });
    if (!raf) raf = requestAnimationFrame(place);
  }

  let rowCount = 0;
  let items = [];
  let rows = [];                      // { year, albums, depth, label }
  let camX = 0;                       // where along the floor you are standing
  let maxX = 0;
  let depthSpan = 0;                  // rows of walking from the first year to the last

  /* Rows exist only while the camera can see them.
   *
   * The first version built every row up front and then hid the distant ones,
   * which is the expensive half of virtualising done backwards: a
   * four-hundred-album library still put a hundred rows and four hundred
   * covers into the DOM, and only then declined to draw most of them. Now a
   * row is built when it comes within range and dropped when it leaves, so
   * what exists is bounded by the depth of the room rather than by the size of
   * the collection — which is the same argument the crate makes next door.
   *
   * `rows` is a sparse array indexed by row number; the gaps are the rows that
   * do not currently exist. */
  const liveRows = new Map();       // row index -> element

  function buildRow(r) {
    const lane = rows[r];
    const row = el('div', { class: 'floor-row' + (lane.undated ? ' is-undated' : '') });

    /* The year, lying on the ground in front of its records. On the floor
       rather than upright, because a label standing up would be a sign in the
       room and this is a marking on it — and because a decade you are walking
       over reads as a place rather than as a caption. Only decades are called
       out: a marker per year would be a wall of numbers, and the decade is the
       unit people actually think in. */
    if (lane.mark) {
      row.appendChild(el('span', { class: 'floor-mark', 'aria-hidden': 'true', text: lane.mark }));
    }

    for (const album of lane.albums) {
      const card = el('a', {
        class: 'floor-card', href: '#/album/' + album.key,
        'aria-label': `${album.title} by ${album.artist}${album.year ? ', ' + album.year : ''}`,
      },
        el('span', { class: 'floor-art', style: { background: placeholderStyle(album.key) } },
          el('img', { class: 'art-img', alt: '', decoding: 'async', loading: 'lazy' })),
        el('span', { class: 'floor-text' },
          el('b', { text: album.title }),
          el('span', { text: album.artist })));
      paintArt(card.querySelector('.art-img'), album.key);
      card.dataset.key = album.key;
      /* A2: one tab stop for the whole room, moved by the arrow keys. Ten
         thousand covers in the tab order would be the same mistake the grid
         made, and a floor whose focus order runs left-to-right through rows
         you cannot see is worse than no focus order at all. */
      card.tabIndex = -1;
      row.appendChild(card);
    }
    camera.appendChild(row);
    liveRows.set(r, row);
    return row;
  }

  /* ------------------------------------------------------------- the axis
   *
   * Depth is the release year, oldest nearest, so walking forward is walking
   * forward through time and the decade markers count up as you go. Counting
   * down would have been the other option — newest first, like everything else
   * in the app — and it reads wrong on a floor: a timeline that runs backwards
   * as you advance makes every marker a subtraction.
   *
   * Records with no year are a real and common case, not an edge one: a rip
   * with no tags, a bootleg, anything ripped before somebody cared. They are
   * not guessed into a year and not dropped. They go past the end of the axis
   * behind a wider gap, so the timeline stays honest about what it is showing
   * and the undated pile is somewhere you can still walk to.
   */
  function lanesFor(albums) {
    const byYear = new Map();
    const undated = [];
    for (const a of albums) {
      if (a.year > 0) {
        if (!byYear.has(a.year)) byYear.set(a.year, []);
        byYear.get(a.year).push(a);
      } else undated.push(a);
    }

    const years = [...byYear.keys()].sort((x, y) => x - y);
    const out = [];
    let prev = null;
    let lastDecade = null;
    for (const y of years) {
      // Distance to walk before this year, from however long the drought was.
      const gap = prev === null ? 0 : Math.min(GAP_MAX, (y - prev - 1) * GAP_DEPTH);
      const decade = Math.floor(y / 10) * 10;
      out.push({
        year: y,
        albums: byYear.get(y),
        gap,
        mark: decade !== lastDecade ? `${decade}s` : '',
      });
      lastDecade = decade;
      prev = y;
    }
    if (undated.length) {
      out.push({ year: 0, albums: undated, gap: years.length ? 1.4 : 0, mark: 'No year', undated: true });
    }
    return out;
  }

  function build() {
    items = lib.state.albums;
    rows = lanesFor(items);
    camera.textContent = '';
    liveRows.clear();
    rowCount = rows.length;

    /* Where each lane sits in depth, accumulated once rather than derived per
       frame: the gaps make a lane's position depend on every lane before it,
       and recomputing that on every scroll frame would be the one O(n) thing
       in a view that is otherwise bounded by what you can see. */
    let at = 0;
    for (const lane of rows) { at += 1 + lane.gap; lane.at = at - 1; }
    depthSpan = at;

    // The widest year decides how far there is to walk sideways.
    maxX = Math.max(0, rows.reduce((m, l) => Math.max(m, l.albums.length), 0) * SLOT - SLOT);
    camX = Math.min(camX, maxX);
    place();
  }

  /* Where each row sits, written once per scroll rather than per frame.
   *
   * The camera moves forward through a fixed arrangement instead of the rows
   * moving past a fixed camera — the same thing to look at, and much cheaper
   * to think about: a row's Z is a function of its index and the scroll
   * position, and nothing has to be animated. */
  let raf = 0;
  function place() {
    raf = 0;
    if (!rowCount) return;
    const scrolled = viewport.scrollTop;
    // One row per this many pixels of scroll.
    const advance = scrolled / ROW_DEPTH;

    /* Walking sideways.
     *
     * One translate on the camera, and perspective does the rest: a fixed
     * distance in world space projects to a smaller distance on screen the
     * further away it is, so the near year slides past quickly and the far
     * ones drift. That parallax is the whole reason this reads as walking
     * rather than as a list scrolling horizontally, and it costs nothing —
     * the browser is already dividing by z for every one of these rows. */
    camera.style.transform = `translate3d(${(-camX).toFixed(1)}px, 0, 0)`;

    // Which rows the camera can see: one behind, and as far ahead as the far
    // plane plus a little. Everything outside this does not exist.
    let first = 0, last = -1;
    for (let i = 0; i < rowCount; i++) {
      const d = rows[i].at - advance;
      if (d < -1.2) first = i + 1;
      if (d <= FAR + 3) last = i;
    }
    first = Math.min(first, rowCount - 1);

    for (const [i, row] of liveRows) {
      if (i < first || i > last) { row.remove(); liveRows.delete(i); }
    }

    for (let i = first; i <= last; i++) {
      const row = liveRows.get(i) || buildRow(i);
      const d = rows[i].at - advance;              // rows ahead of the camera
      // Bounded: past the far plane rows stop receding, so a long library is a
      // long list rather than an infinitely compressed corridor.
      const z = -Math.min(d, FAR) * ROW_DEPTH;
      /* Every lane starts at the same X, rather than each being centred on
         itself. A centred row would put 1974's four records and 1991's twenty
         over different ground, so walking right would arrive somewhere
         different in each year and the sideways axis would mean nothing.
         Left-aligned, one step sideways is the same step in every year.

         Where that left edge sits is the stylesheet's business — see
         `--floor-gutter` — so the room can be given a different margin at a
         different width without this having to know about it. */
      row.style.transform = `translate3d(0, 0, ${z.toFixed(1)}px)`;
      // Depth fade, so the far end goes into the room rather than stopping.
      row.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, d) / (FAR + 2.5))).toFixed(3));
      row.classList.toggle('is-near', d < NEAR_ROWS);
    }
    paintPlaying();
    paintRail(advance);
  }

  /* R1: a quiet lamp on the record that is playing.
   *
   * The Floor is a room the library is standing in and it had no idea what was
   * on the turntable — which is the first thing you would ask a room like
   * this. The lamp is a class, so the light itself is the stylesheet's; this
   * only says which record it belongs to. */
  let litKey = '';
  function paintPlaying() {
    const key = player.state.current?.albumKey || '';
    for (const row of liveRows.values()) {
      for (const card of row.children) {
        if (!card.dataset.key) continue;
        card.classList.toggle('is-playing', !!key && card.dataset.key === key);
      }
    }
    litKey = key;
  }

  /** Lights the decade the camera is standing in. */
  function paintRail(advance) {
    if (!railBtns.length) return;
    let cur = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].at <= advance + 0.5) cur = i;
    let best = railBtns[0];
    for (const b of railBtns) if (+b.dataset.row <= cur) best = b;
    for (const b of railBtns) b.classList.toggle('is-on', b === best);
  }

  /**
   * Walks to the record that is playing.
   *
   * Both axes: the row is its year and the X is where it sits along that year,
   * so arriving means standing in front of it rather than merely in the right
   * decade.
   */
  function walkToPlaying() {
    const key = player.state.current?.albumKey;
    if (!key) { toast('Nothing is playing'); return false; }
    for (let r = 0; r < rows.length; r++) {
      const i = rows[r].albums.findIndex((a) => a.key === key);
      if (i < 0) continue;
      /* Centred rather than flush left: the record you asked for should be in
         front of you, and the gutter is where a row *starts*, not where you
         are made to stand. */
      const mid = Math.max(0, viewport.clientWidth / 2 - SLOT);
      walkTo(r, { x: i * SLOT - mid });
      return true;
    }
    toast('That record is not on the floor');
    return false;
  }

  /** Steps sideways, clamped to the floor's own width. */
  function walk(dx) {
    const next = Math.max(0, Math.min(maxX, camX + dx));
    if (next === camX) return false;
    camX = next;
    if (!raf) raf = requestAnimationFrame(place);
    return true;
  }

  const onScroll = () => { if (!raf) raf = requestAnimationFrame(place); };
  viewport.addEventListener('scroll', onScroll, { passive: true });

  /* Three ways to walk sideways, because there is no one gesture everybody
     has: a trackpad's second axis, a drag, and the arrow keys. The keys are
     not a courtesy — a view that can only be moved by dragging is a view some
     people cannot move at all. */
  const onWheel = (e) => {
    // A horizontal wheel, or a vertical one with Shift — the pair every
    // horizontally-scrolling thing on the web already answers to.
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    if (walk(dx)) e.preventDefault();
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  /* A2: a keyboard route through the room.
   *
   * The comment at the top of this function says the Floor is a fourth mode
   * and never the only one, precisely because a transformed layout stops
   * matching the tab order. That is honest and it is also the reason to close
   * it: a roving focus that follows the *visual* arrangement — left and right
   * along a year, up and down between years — walks the same room the eye
   * does, and the camera follows so the focused record is never behind you.
   *
   * `cursor` is a position in the room, not an index into a list: a row and a
   * column, both clamped to what that year actually holds. */
  let cursor = null;                  // { r, c }

  function focusCell(r, c, { walkX = true } = {}) {
    const lane = rows[r];
    if (!lane || !lane.albums.length) return;
    c = Math.max(0, Math.min(lane.albums.length - 1, c));
    cursor = { r, c };
    /* Bring the record into the frame before asking for focus. `.focus()` on
       something outside the viewport would make the browser scroll to it, and
       the Floor's scroll position *is* its depth — a browser-initiated scroll
       here walks the camera somewhere nobody asked to go. */
    const mid = Math.max(0, viewport.clientWidth / 2 - SLOT);
    if (walkX) camX = Math.max(0, Math.min(maxX, c * SLOT - mid));
    viewport.scrollTo({ top: lane.at * ROW_DEPTH, behavior: 'instant' });
    place();
    const card = liveRows.get(r)?.children[lane.mark ? c + 1 : c];
    if (card) card.focus({ preventScroll: true });
  }

  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? SLOT * 3 : SLOT;

    /* Two keyboards in one view, and the difference is where focus is. On the
       room itself the arrows walk the camera, which is what somebody who has
       just tabbed in expects. On a record they move between records. */
    const onCard = e.target.classList?.contains('floor-card');

    if (e.key === 'ArrowLeft') {
      if (onCard && cursor) { focusCell(cursor.r, cursor.c - 1); e.preventDefault(); }
      else if (walk(-step)) e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      if (onCard && cursor) { focusCell(cursor.r, cursor.c + 1); e.preventDefault(); }
      else if (walk(step)) e.preventDefault();
    } else if (e.key === 'ArrowUp' && onCard && cursor && cursor.r > 0) {
      focusCell(cursor.r - 1, cursor.c); e.preventDefault();
    } else if (e.key === 'ArrowDown' && onCard && cursor && cursor.r < rowCount - 1) {
      focusCell(cursor.r + 1, cursor.c); e.preventDefault();
    } else if (e.key === 'Home') {
      if (onCard && cursor) focusCell(cursor.r, 0);
      else { camX = 0; place(); }
      e.preventDefault();
    } else if (e.key === 'End') {
      if (onCard && cursor) focusCell(cursor.r, rows[cursor.r].albums.length - 1);
      else { camX = maxX; place(); }
      e.preventDefault();
    } else if (e.key === 'Enter' && !onCard) {
      /* Entering the room from its own tab stop: the first record in front of
         you, rather than the first in the collection. */
      const advance = viewport.scrollTop / ROW_DEPTH;
      let r = 0;
      for (let i = 0; i < rows.length; i++) if (rows[i].at <= advance + 0.5) r = i;
      focusCell(r, Math.round(camX / SLOT), { walkX: false });
      e.preventDefault();
    } else if (e.key === 'p' || e.key === 'P') {
      /* R1. A key rather than a button, because the Floor has no chrome and
         should not grow any: it is a room, and the affordances that belong in
         it are the ones you can walk to. The hint above the rail says so. */
      if (walkToPlaying()) e.preventDefault();
    }
  };
  stage.addEventListener('keydown', onKey);

  /* Dragging. The cards are links, so a drag that ends on one would otherwise
     navigate — past a few pixels of movement this stops being a click and the
     next one is swallowed. */
  let drag = null;
  /* Set when a drag ends past the threshold, cleared by the click it swallows
     or by the next press. A flag rather than a one-shot listener taken back
     off on a timer: the click follows the release in the same sequence of
     tasks *usually*, and "usually" is how you get a view that occasionally
     opens an album because the pointer was busy. */
  let swallowClick = false;
  const onClick = (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  stage.addEventListener('click', onClick, true);

  const onDown = (e) => {
    if (e.button !== 0) return;
    /* Not on the controls. `setPointerCapture` below redirects the rest of the
       gesture — the click included — to the stage, so a press that began on a
       decade button would be captured away from it and the button would never
       hear about it. The room is dragged; the things standing on it are not. */
    if (e.target.closest?.('.floor-hud')) return;
    swallowClick = false;
    drag = { x: e.clientX, from: camX, moved: 0 };
    stage.setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    camX = Math.max(0, Math.min(maxX, drag.from - dx));
    if (drag.moved > 6) stage.classList.add('is-walking');
    if (!raf) raf = requestAnimationFrame(place);
  };
  const onUp = (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    stage.classList.remove('is-walking');
    stage.releasePointerCapture?.(e.pointerId);
    swallowClick = moved > 6;
  };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onDragMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);

  // The stage has to be tall enough to scroll through every row.
  function resize() {
    // Guarded for the same reason the virtualiser's is: this runs from a
    // ResizeObserver on the viewport, and making the stage taller can bring a
    // scrollbar in, which resizes the viewport, which runs this again.
    const h = `${Math.max(1, depthSpan) * ROW_DEPTH + viewport.clientHeight * 0.4}px`;
    if (stage.style.height !== h) stage.style.height = h;
  }
  const ro = new ResizeObserver(() => { resize(); place(); });
  ro.observe(viewport);

  build();
  buildRail();
  resize();
  host.appendChild(stage);
  place();

  const off = lib.events.on('change', () => { build(); buildRail(); resize(); });
  /* The lamp follows the turntable, and only repaints when the record changes
     — a repaint per second of playback would be a style write per second for
     something that changes once a track. */
  const offTrack = player.events.on('track', () => {
    if ((player.state.current?.albumKey || '') !== litKey) place();
  });
  // Only the rows that exist, which is only the ones you can see.
  const offArt = lib.events.on('art', () => {
    for (const row of liveRows.values()) {
      for (const img of row.querySelectorAll('.art-img')) {
        if (img.dataset.key) paintArt(img, img.dataset.key);
      }
    }
  });

  return () => {
    off(); offArt(); offTrack(); ro.disconnect();
    viewport.removeEventListener('scroll', onScroll);
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('keydown', onKey);
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onDragMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onUp);
    stage.removeEventListener('click', onClick, true);
    if (raf) cancelAnimationFrame(raf);
  };
}

/* ------------------------------------------------------------------ crate */

/**
 * Records in a crate, seen from the front.
 *
 * Only a window of records around the current one exists in the DOM — eleven
 * of them, recycled — so a crate of fifty thousand costs the same as a crate
 * of eleven. That is the same argument the virtualiser makes, made again in a
 * shape the virtualiser cannot help with, because these are positioned by
 * their distance from the middle rather than by their index.
 *
 * Positions are written in JavaScript rather than by a scroll-driven
 * animation, and deliberately: nothing moves per frame here. Eleven transforms
 * are written when the selection changes and never again — a keypress, not a
 * scroll. CSS then eases each record to where it was put, which is what makes
 * the whole rack swing rather than jump.
 */
function mountCrate(host, ordered) {
  const WINDOW = 5;                       // how many either side of the middle
  const box = el('div', {
    class: 'crate', tabindex: '0', role: 'listbox', 'aria-label': 'Albums',
    /* The records behind the front one recede past the right-hand edge and
       are meant to: a crate that fits inside its own box is a shelf. Said
       out loud so `tools/looks.mjs` does not report it every run. */
    'data-clips': '',
  });
  const rail = el('div', { class: 'crate-rail' });
  const meta = el('div', { class: 'crate-meta' },
    el('h2', { class: 'crate-title' }),
    el('p', { class: 'crate-sub' }));
  const hint = el('p', { class: 'crate-hint label', text: 'Arrow keys to flip · F to turn it over · Enter to open' });
  /* R4: where you are in the crate.
   *
   * Eleven records exist at once and every one of them stood behind the front
   * one, so a crate of fifty thousand looked exactly like a crate of eleven
   * and flipping gave no sense of travel at all. Real crate-digging is mostly
   * about what you have already pushed past, so the near half now leans the
   * other way — the same eleven nodes, redistributed, which costs nothing —
   * and the count says the rest. */
  const count = el('p', { class: 'crate-count label' });
  box.append(rail, meta, count, hint);
  host.appendChild(box);

  let albums = ordered ? ordered() : lib.state.albums;
  let at = 0;
  const cards = new Map();                // offset -> node, recycled in place

  function paint() {
    albums = ordered ? ordered() : lib.state.albums;
    if (!albums.length) return;
    at = Math.max(0, Math.min(albums.length - 1, at));

    for (let o = -WINDOW; o <= WINDOW; o++) {
      let node = cards.get(o);
      if (!node) {
        node = albumCard(null);
        node.classList.add('crate-item');
        rail.appendChild(node);
        cards.set(o, node);
      }
      const album = albums[at + o];
      if (!album) { node.hidden = true; continue; }
      node.hidden = false;
      renderAlbumCard(node, album);

      // Fanned out from the middle: the further away, the further back, the
      // more turned, and the dimmer. The record at the front is the exception
      // and has to be — it is centred, square to the viewer and a little
      // forward of the rest, because it is the one being looked at. Folding it
      // into the same formula as its neighbours turns it 42 degrees and pushes
      // it sideways, which is a crate with nothing at the front of it.
      /* R4. The records behind the front one are what is still to come and
         they recede; the ones in front of it are what you have already pushed
         past, and they lean the other way, toward you, the way a stack does
         when you have tipped half of it forward. The two halves therefore read
         as different piles rather than as one symmetrical fan, which is the
         whole difference between flipping through a crate and looking at a
         carousel. */
      const s = o < 0 ? -1 : 1;
      const d = Math.abs(o);
      const passed = o < 0;
      const x = d === 0 ? 0 : s * (passed ? 44 + (d - 1) * 22 : 58 + (d - 1) * 30);
      const z = d === 0 ? 70 : (passed ? 40 - d * 26 : -d * 120);
      const ry = d === 0 ? 0 : (passed ? 62 : -44) * -s;
      // The -50% pair is the centring the stylesheet asked for and cannot
      // apply itself, because this line replaces the whole transform.
      node.style.transform =
        `translate(-50%, -50%) translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(0)}px)` +
        ` rotateY(${ry.toFixed(0)}deg)`;
      node.style.opacity = d === 0 ? '1' : String(Math.max(0.15, 1 - d * (passed ? 0.16 : 0.22)));
      /* A passed record is nearer the eye than the front one, so it has to be
         drawn over it, or the near half sinks into the record it is in front
         of and the lean means nothing. */
      node.style.zIndex = String(passed ? 30 + d : 20 - d);
      node.classList.toggle('is-passed', passed);
      node.classList.toggle('is-front', o === 0);
      node.setAttribute('aria-selected', o === 0 ? 'true' : 'false');
      // Only the record at the front is a target. Clicking one behind it and
      // getting a different album than the one you pointed at is the classic
      // failure of every cover-flow ever shipped.
      node.style.pointerEvents = o === 0 ? 'auto' : 'none';
    }

    const cur = albums[at];
    meta.querySelector('.crate-title').textContent = cur.title;
    meta.querySelector('.crate-sub').textContent =
      [cur.artist, cur.year || null, fmtCount(cur.tracks.length, 'track')].filter(Boolean).join(' · ');
    count.textContent = `${at + 1} of ${albums.length}`;
    box.setAttribute('aria-activedescendant', '');
    paintBack();
  }

  /* R5: turn the record over.
   *
   * The back cover is typeset, real and legible, and exactly one of the four
   * album views could reach it — which is odd, because holding a record up to
   * look at it is precisely the moment you turn it over. Only the front record
   * gets a back: the other ten are edge-on and would be ten back covers nobody
   * can see, built and thrown away on every keypress.
   */
  let flipped = false;
  let backKey = '';

  function paintBack() {
    const node = cards.get(0);
    const album = albums[at];
    if (!node || !album) return;
    const inner = node.querySelector('.sleeve');
    if (!inner) return;

    if (backKey !== album.key) {
      backKey = album.key;
      inner.querySelector('.sleeve-flip')?.replaceWith(...inner.querySelector('.sleeve-flip').childNodes);
      inner.querySelector('.sleeve-back')?.remove();
      /* The same two-element arrangement `sleeve()` builds, for the same
         reason: the pointer tilt is written inline on `.sleeve`, so the flip
         needs an element of its own or one would overwrite the other. */
      const face = [...inner.children];
      const flip = el('div', { class: 'sleeve-flip' }, ...face, backCover(album));
      inner.appendChild(flip);
      inner.classList.add('has-back');
    }
    inner.classList.toggle('is-flipped', flipped);
    inner.querySelector('.sleeve-back')?.setAttribute('aria-hidden', flipped ? 'false' : 'true');
    node.setAttribute('aria-label', `${album.title} by ${album.artist}${flipped ? ', back cover' : ''}`);
  }

  /* Flipping to the next record puts the new one face out. Carrying the turn
     across would mean arriving at a record you have never seen from the back,
     which is not what turning one over means. */
  const move = (by) => { at += by; flipped = false; paint(); };

  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }
    else if (e.key === 'Home') { at = 0; paint(); e.preventDefault(); }
    else if (e.key === 'End') { at = albums.length - 1; paint(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { flipped = !flipped; paintBack(); e.preventDefault(); }
    else if (e.key === 'Enter' && albums[at]) {
      markTransition(cards.get(0)?.querySelector('.sleeve'));
      location.hash = '#/album/' + albums[at].key;
    }
  });

  // A wheel is how people flip through a crate on a laptop. Either axis: a
  // horizontal trackpad swipe and a vertical wheel mean the same thing here.
  let wheelAt = 0;
  box.addEventListener('wheel', (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 110) return;      // one record per gesture, not per event
    wheelAt = now;
    move(d > 0 ? 1 : -1);
  }, { passive: false });

  paint();

  /* Take focus only if nothing else has it.
   *
   * The crate needs focus for the arrow keys to reach it, and arriving at
   * Albums with nothing else selected should leave you able to flip
   * immediately. But the mode is remembered, so this runs on *every* visit to
   * the route — and grabbing focus unconditionally means that typing in the
   * search box and landing here sends the next arrow key to the records
   * instead of to the caret. `<body>` as the active element is the browser's
   * way of saying nobody has claimed it. */
  if (document.activeElement === document.body || !document.activeElement) {
    box.focus({ preventScroll: true });
  }
  const off = lib.events.on('change', paint);
  const offArt = lib.events.on('art', paint);
  return () => { off(); offArt(); box.remove(); cards.clear(); };
}

/* ------------------------------------------------------------------ ALBUM */

function viewAlbum(host, key) {
  const album = albumOf(key);
  if (!album) return notFound(host, 'Album not found');

  const origin = { type: 'album', key, label: album.title };
  const hero = el('header', { class: 'hero hero-show' });
  // The album page is the one place worth putting the record on a stand: it is
  // a page about a single object, so the object gets a floor, an edge and a
  // reflection, and it turns to follow the pointer.
  const art = sleeve(key, 'hero-art', { reflect: true, back: backCover(album), record: true });
  const meta = el('div', { class: 'hero-meta' },
    el('p', { class: 'eyebrow', text: 'Album' }),
    el('h1', { class: 'hero-title', text: album.title }),
    el('p', { class: 'hero-sub' },
      el('a', { class: 'hero-link', href: '#/artist/' + album.artistKey, text: album.artist }),
      /* One unit, so a narrow hero breaks after the artist rather than
         between a fact and the separator that belongs to it. */
      el('span', { class: 'hero-facts' },
        el('span', { class: 'dot' }),
        album.year ? el('span', { text: String(album.year) }) : null,
        album.year ? el('span', { class: 'dot' }) : null,
        el('span', { text: fmtCount(album.tracks.length, 'track') }),
        el('span', { class: 'dot' }),
        el('span', { text: fmtTotal(album.duration) }))));

  const actions = el('div', { class: 'hero-actions' },
    playFab(() => playAll(album.tracks, 0, origin)),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(album.tracks, origin) }),
    el('button', { class: 'icon-btn', html: ico('queue'), title: 'Add to queue', onclick: () => { player.enqueue(album.tracks); toast('Added to queue'); } }),
    el('button', { class: 'icon-btn', html: ico('more'), title: 'More',
      onclick: (e) => menu(coverMenu(key, album).concat(trackMenu(album.tracks, { origin })), { anchor: e.currentTarget }) }));
  meta.appendChild(actions);

  hero.append(art, meta);
  host.appendChild(hero);
  applyHeroTint(hero, key);
  decode(hero.querySelector('.hero-title'), album.title, { duration: 620 });
  markTransition(art.querySelector('.sleeve'));
  const untilt = tilt3d(art.querySelector('.sleeve'), { max: 11, lift: 30, scale: 1.012 });

  /* Turning the record over.
   *
   * A real button rather than a click on the artwork: the sleeve is 232px of
   * inviting target that people will click expecting it to play, and a page
   * whose largest element does something unguessable is a page that has
   * traded discoverability for a trick. The button says what it does, takes
   * focus, and answers Enter and Space for free. */
  const flip = art.querySelector('.sleeve');
  const flipBtn = el('button', {
    class: 'flip-btn', 'aria-pressed': 'false',
    title: 'Turn the sleeve over', 'aria-label': 'Show the back of the sleeve',
    html: ico('refresh') + '<span>Back</span>',
    onclick: () => {
      const on = !flip.classList.contains('is-flipped');
      flip.classList.toggle('is-flipped', on);
      flipBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      flipBtn.setAttribute('aria-label', on ? 'Show the front of the sleeve' : 'Show the back of the sleeve');
      flipBtn.querySelector('span').textContent = on ? 'Front' : 'Back';
      // The back is real content, not decoration, so it stops being hidden
      // from a screen reader the moment it is the side facing out.
      art.querySelector('.sleeve-back').setAttribute('aria-hidden', on ? 'false' : 'true');
    },
  });
  art.appendChild(flipBtn);

  const columns = ['index', 'title', 'duration'];
  const oneArtist = album.tracks.every((t) => t.artist === album.artist);
  const list = el('div', { class: 'plain-list' + (oneArtist ? ' no-sub' : '') });
  const factory = trackRowFactory({
    columns,
    onPlay: (i) => playAll(album.tracks, i, origin),
    onMenu: (i, anchor, event) => menu(trackMenu([album.tracks[i]], { origin }), { anchor, event }),
  });

  // Asked once, not once per track: `some` inside the loop made this quadratic.
  const multiDisc = album.tracks.some((t) => t.disc > 1);
  let discNo = 0;
  album.tracks.forEach((t, i) => {
    if (multiDisc && t.disc !== discNo) {
      discNo = t.disc;
      list.appendChild(el('div', { class: 'disc-head', text: `Disc ${discNo}` }));
    }
    const row = factory.create();
    row.dataset.index = i;
    row.classList.add('static-row');
    factory.render(row, t, i);
    list.appendChild(row);
  });

  host.appendChild(list);
  enter([hero], { y: 16, z: -90, wipe: true });
  enter(list.children, { each: 13, y: 8, delay: 80 });

  const refresh = () => {
    for (const row of list.children) {
      const i = parseInt(row.dataset.index, 10);
      if (!isNaN(i)) factory.render(row, album.tracks[i], i);
    }
    // The record comes out of the sleeve for this album and no other, and it
    // stops turning rather than disappearing when playback pauses — which is
    // what a paused turntable looks like.
    const mine = player.state.current && player.state.current.albumKey === key;
    flip.classList.toggle('is-playing', !!mine);
    flip.classList.toggle('is-paused', !!mine && !player.state.playing);
  };
  refresh();
  const off = player.events.on('track', refresh);
  const offState = player.events.on('state', refresh);
  const undrop = acceptCover(art, key);
  const offArt = lib.events.on('art', (keys) => {
    if (keys && !keys.includes(key)) return;
    /* Everything the cover feeds, repainted from one event: the face, the
       reflection standing on the floor beneath it, and the page tint — which
       is read off the accent colour the new picture was sampled for. */
    const img = art.querySelector('.art-img');
    if (img) { img.dataset.key = ''; paintArt(img, key); }
    const echo = art.querySelector('.art-echo-img');
    // Through loadArt rather than off the face's src: reverting to the
    // original empties the cache, so the face is still waiting at this point.
    if (echo) {
      lib.loadArt(key).then((url) => {
        if (url) echo.setAttribute('src', url); else echo.removeAttribute('src');
      });
    }
    applyHeroTint(hero, key);
  });
  return () => { off(); offState(); untilt(); undrop(); offArt(); };
}

/* ---------------------------------------------------------------- covers
 *
 * Some albums arrive with no picture, and some arrive with the wrong one —
 * a scan of a CD-R, a placeholder from a rip, the same generic square across
 * forty bootlegs. Sonora will not write to the files, so the fix is the same
 * shape as a tag correction: your picture goes into Sonora's index, the
 * album's own cover stays where it was, and "use the original" is one click.
 *
 * Three ways in, because the right one depends on where the picture is:
 * dropped from a folder, pasted from wherever you just copied it, or picked
 * through the file dialog when neither of those is convenient.
 */

function coverMenu(key, album) {
  const bound = rack.bindingOf('album', key);
  const choose = async (file) => {
    if (!file) return;
    toast('Fitting the cover…');
    const ok = await lib.setArtwork(key, file);
    toast(ok ? `New cover for “${album.title}”` : 'That file could not be read as a picture');
  };
  return [
    {
      label: 'Choose a cover…', icon: 'image', hint: 'or drop one on the sleeve',
      onSelect: () => {
        /* An <input type=file> rather than showOpenFilePicker: this one needs
           no handle afterwards, works in every browser, and does not have to
           be reconnected on the next launch the way a music folder does. */
        const pick = el('input', { type: 'file', accept: 'image/*' });
        pick.style.display = 'none';
        pick.addEventListener('change', () => { choose(pick.files[0]); pick.remove(); });
        document.body.appendChild(pick);
        pick.click();
      },
    },
    lib.hasOwnArt(key) ? {
      label: 'Use the original cover', icon: 'refresh',
      onSelect: async () => {
        await lib.clearArtwork(key);
        toast(`“${album.title}” is back to its own cover`);
      },
    } : null,
    {
      label: 'Rack for this album…', icon: 'sliders',
      hint: bound || '',
      onSelect: () => rackPicker('album', key, album.title),
    },
    { separator: true },
  ].filter(Boolean);
}

/**
 * Picks the rack a record should arrive with.
 *
 * A dialog rather than a submenu because the list is long — eleven presets
 * plus however many racks you have saved — and because the row that matters
 * most is the one at the top saying there is no rack, which a submenu buries.
 */
async function rackPicker(scope, key, label) {
  const current = rack.bindingOf(scope, key);
  const saved = await rack.savedRacks();
  const list = el('div', { class: 'rack-pick' });

  const row = (id, name, note) => {
    const on = (id || null) === (current || null);
    return el('button', {
      class: 'rack-pick-row' + (on ? ' is-on' : ''),
      onclick: async () => {
        await rack.bindTo(scope, key, id);
        closeDialog();
        /* Takes effect on the next track that asks for it. Saying so is the
           honest thing: the change is real but you will not hear it until the
           record comes round, and silence here reads as a control that did
           nothing. */
        const now = player.state.current;
        const mine = now && (scope === 'album' ? now.albumKey : now.artistKey) === key;
        if (mine) await rack.followTrack(now);
        toast(id
          ? (mine ? `“${label}” is on the ${name} rack` : `“${label}” will arrive on the ${name} rack`)
          : `“${label}” goes back to your rack`);
      },
    },
      el('span', { class: 'rack-pick-name', text: name }),
      note ? el('span', { class: 'rack-pick-note', text: note }) : null,
      el('span', { class: 'rack-pick-mark', html: on ? ico('star-fill') : '' }));
  };

  list.appendChild(row(null, 'Your rack', 'whatever the Sound page says'));
  if (saved.length) {
    list.appendChild(el('p', { class: 'rack-pick-head', text: 'Saved' }));
    for (const r of saved) list.appendChild(row(r.name, r.name));
  }
  list.appendChild(el('p', { class: 'rack-pick-head', text: 'Presets' }));
  for (const p of rack.PRESETS) list.appendChild(row(p.id, p.label));

  let closeDialog = () => {};
  const d = dialog({
    title: 'A rack for this record',
    body: el('div', {},
      el('p', { class: 'dialog-note', text:
        `Sonora puts this chain in circuit whenever ${scope === 'album' ? 'this album' : 'this artist'} plays, ` +
        'and takes it out again afterwards. Your own rack is never overwritten.' }),
      list),
    width: 460,
    actions: [{ label: 'Done' }],
  });
  closeDialog = () => d.close();
}

/**
 * Lets an album's sleeve take a picture by drag or by paste.
 *
 * The paste listener is on the document rather than the sleeve because a
 * sleeve cannot hold focus and ⌘V has to work the moment the page is open;
 * it is filtered on the clipboard actually carrying an image, so pasting
 * text into the search box while an album page is behind it does nothing.
 */
function acceptCover(art, key) {
  const album = albumOf(key);
  let depth = 0;                 // dragenter/dragleave fire per child element

  const take = async (file) => {
    art.classList.remove('is-dropping');
    if (!file) return;
    art.classList.add('is-fitting');
    const ok = await lib.setArtwork(key, file);
    art.classList.remove('is-fitting');
    toast(ok ? `New cover for “${album ? album.title : 'the album'}”`
             : 'That file could not be read as a picture');
  };

  const hasImage = (dt) => !!dt && [...(dt.items || [])].some((i) => i.kind === 'file' && /^image\//.test(i.type));

  const onEnter = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    art.classList.add('is-dropping');
  };
  const onOver = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = () => { if (--depth <= 0) { depth = 0; art.classList.remove('is-dropping'); } };
  const onDrop = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    /* Stopped here, not just prevented: the window-level handler treats a drop
       as "add this music to the library", and an image dropped on a sleeve is
       a different instruction that happens to use the same gesture. */
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    take([...e.dataTransfer.files].find((f) => /^image\//.test(f.type)));
  };
  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!img) return;
    e.preventDefault();
    take(img.getAsFile());
  };

  art.addEventListener('dragenter', onEnter);
  art.addEventListener('dragover', onOver);
  art.addEventListener('dragleave', onLeave);
  art.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);

  return () => {
    art.removeEventListener('dragenter', onEnter);
    art.removeEventListener('dragover', onOver);
    art.removeEventListener('dragleave', onLeave);
    art.removeEventListener('drop', onDrop);
    document.removeEventListener('paste', onPaste);
  };
}

/* ------------------------------------------------------------------ back cover */

/**
 * The back of the sleeve: the tracklist as it is printed on a record, and
 * under it the spec block for what the files actually are.
 *
 * Everything here was already in the index. The tag reader worked the
 * technical fields out on its way to the duration and the worker now keeps
 * them, so this is a printing job rather than a parsing one.
 *
 * A library imported before those fields existed simply has fewer rows — the
 * block prints what is known and says nothing about what is not, which is the
 * only honest thing to do with a record that predates the question.
 */
function backCover(album) {
  const back = el('div', { class: 'sleeve-back', 'aria-hidden': 'true' });

  back.appendChild(el('div', { class: 'back-head' },
    el('span', { class: 'back-artist', text: album.compilation ? 'Various Artists' : album.artist }),
    el('span', { class: 'back-title', text: album.title })));

  /* R8: a set is printed as a set.
   *
   * A multi-disc release already draws as more than one sleeve on the shelf
   * and already gets disc headings in the page's own tracklist, and then the
   * back cover flattened it into one numbered run where track 1 appeared
   * twice. Real sleeves put a rule and a side. */
  const discs = [...new Set(album.tracks.map((t) => t.disc || 1))].sort((a, b) => a - b);
  const list = el('ol', { class: 'back-list' });
  let printed = 0;
  for (const t of album.tracks) {
    if (discs.length > 1 && (t.disc || 1) !== printed) {
      printed = t.disc || 1;
      list.appendChild(el('li', { class: 'back-disc' },
        el('span', { class: 'back-t', text: 'Disc ' + printed })));
    }
    list.appendChild(el('li', {},
      el('span', { class: 'back-n', text: String(t.track || '') }),
      el('span', { class: 'back-t', text: t.title }),
      el('span', { class: 'back-d', text: t.duration ? fmtTime(t.duration) : '' })));
  }
  back.appendChild(list);

  /* One line per fact, and only for facts. A mixed-format album says so rather
     than picking whichever file happened to be first. */
  const uniq = (fn) => [...new Set(album.tracks.map(fn).filter(Boolean))];
  const formats = uniq((t) => formatName(t.name || ''));
  const rates = uniq((t) => t.sampleRate);
  const depths = uniq((t) => t.bitDepth);
  const chans = uniq((t) => t.channels);
  const rateOf = (n) => (n % 1000 === 0 ? n / 1000 + ' kHz' : (n / 1000).toFixed(1) + ' kHz');
  const bitrates = album.tracks.map((t) => t.bitrate).filter((n) => n > 0);
  const avg = bitrates.length ? Math.round(bitrates.reduce((a, b) => a + b, 0) / bitrates.length) : 0;
  const bytes = album.tracks.reduce((n, t) => n + (t.size || 0), 0);

  const spec = el('dl', { class: 'back-spec' });
  const row = (k, v) => { if (v) { spec.appendChild(el('dt', { text: k })); spec.appendChild(el('dd', { text: v })); } };
  row('Format', formats.join(' · '));
  row('Rate', rates.length ? rates.sort((a, b) => a - b).map(rateOf).join(' · ') : '');
  row('Depth', depths.length ? depths.sort((a, b) => a - b).map((d) => d + '-bit').join(' · ') : '');
  row('Channels', chans.length ? chans.map((c) => (c === 1 ? 'Mono' : c === 2 ? 'Stereo' : c + ' ch')).join(' · ') : '');
  row('Bitrate', avg ? '~' + avg + ' kbps' : '');
  // Only the tracks that have actually been listened to have a figure, so the
  // count comes with it: "DR11 · 4 of 9" is a partial reading, and saying so is
  // the difference between a measurement and a claim.
  const drs = album.tracks.map((t) => t.dr).filter((n) => n > 0);
  row('Dynamic range', drs.length
    ? 'DR' + Math.round(drs.reduce((a, b) => a + b, 0) / drs.length) +
      (drs.length < album.tracks.length ? ` · ${drs.length} of ${album.tracks.length}` : '')
    : '');
  row('Discs', discs.length > 1 ? String(discs.length) : '');
  row('On disk', bytes ? fmtBytes(bytes) : '');
  row('Runtime', album.duration ? fmtTotal(album.duration) : '');
  if (spec.children.length) back.appendChild(spec);

  // The album key, which is a hash, set where a catalogue number goes. It is
  // the only stable name this record has inside the app.
  back.appendChild(el('div', { class: 'back-cat' },
    el('span', { text: 'SNR-' + String(album.key).toUpperCase() }),
    album.year ? el('span', { text: String(album.year) }) : null));

  return back;
}

/** Paints a soft wash of the album's own colour behind its header. */
function applyHeroTint(hero, key) {
  /* Removing, not just setting. This runs again when the cover changes, and
     putting an album back to a picture with no colour of its own has to take
     the old tint away — otherwise the page stays lit by artwork that is no
     longer on it. */
  const paint = (rgb) => {
    if (rgb) hero.style.setProperty('--hero-rgb', rgb.join(' '));
    else hero.style.removeProperty('--hero-rgb');
  };
  const rgb = lib.accentFor(key);
  if (rgb) paint(rgb);
  else lib.loadArt(key).then(() => paint(lib.accentFor(key)));
}

/* ------------------------------------------------------------------ ARTISTS */

function viewArtists(host) {
  const artists = lib.state.artists;
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Artists' }),
    el('p', { class: 'page-sub', text: fmtCount(artists.length, 'artist') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Artists');

  if (!artists.length) {
    host.appendChild(emptyState({ icon: 'artist', title: 'No artists yet' }));
    return () => {};
  }

  const sorter = sortControl({
    store: ARTIST_SORT,
    fallback: 'name',
    keys: [['name', 'Name'], ['albums', 'Albums'], ['tracks', 'Tracks'],
           ['length', 'Length'], ['plays', 'Times played'], ['played', 'Last played']],
    onChange: () => grid.setItems(ordered()),
  });
  const bar = el('div', { class: 'toolbar' }, sorter.node);
  host.appendChild(bar);

  const ordered = () => lib.sortArtists(lib.state.artists, sorter.state.key, sorter.state.dir);

  const grid = new VirtualGrid({
    viewport: host, minCell: 156, gap: 22, aspect: 1, footer: 64,
    create: () => artistCard(null),
    render: (node, artist) => renderArtistCard(node, artist),
  });
  grid.setItems(ordered());
  enter([head, bar], { y: 10 });

  const off = lib.events.on('change', () => grid.setItems(ordered()));
  const offArt = lib.events.on('art', () => grid.refresh());
  return () => { off(); offArt(); grid.destroy(); };
}

function viewArtist(host, key) {
  const artist = artistOf(key);
  if (!artist) return notFound(host, 'Artist not found');
  const origin = { type: 'artist', key, label: artist.name };

  const hero = el('header', { class: 'hero hero-artist' });
  const first = artist.albumList[0];
  const art = artBox(first ? first.key : key, null, 'hero-art round');
  const meta = el('div', { class: 'hero-meta' },
    el('p', { class: 'eyebrow', text: 'Artist' }),
    el('h1', { class: 'hero-title', text: artist.name }),
    el('p', { class: 'hero-sub' },
      el('span', { text: fmtCount(artist.albumList.length, 'album') }),
      el('span', { class: 'dot' }),
      el('span', { text: fmtCount(artist.tracks.length, 'track') }),
      el('span', { class: 'dot' }),
      el('span', { text: fmtTotal(artist.duration) })));
  meta.appendChild(el('div', { class: 'hero-actions' },
    playFab(() => playAll(artist.tracks, 0, origin)),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(artist.tracks, origin) }),
    el('button', { class: 'icon-btn', html: ico('more'), onclick: (e) => menu(trackMenu(artist.tracks, { origin }), { anchor: e.currentTarget }) })));
  hero.append(art, meta);
  host.appendChild(hero);
  if (first) applyHeroTint(hero, first.key);

  const top = artist.tracks.slice()
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || cmpText(a.title, b.title))
    .slice(0, 5);

  const section = el('section', { class: 'block' }, sectionHead('Popular'));
  const list = el('div', { class: 'plain-list' });
  const factory = trackRowFactory({
    columns: ['index', 'art', 'title', 'duration'],
    onPlay: (i) => playAll(top, i, origin),
    onMenu: (i, anchor, event) => menu(trackMenu([top[i]], { origin }), { anchor, event }),
  });
  top.forEach((t, i) => {
    const row = factory.create();
    row.dataset.index = i;
    row.classList.add('static-row');
    factory.render(row, t, i);
    list.appendChild(row);
  });
  section.appendChild(list);
  host.appendChild(section);

  const albumsBlock = el('section', { class: 'block' }, sectionHead('Albums'));
  const grid = el('div', { class: 'grid' });
  for (const a of artist.albumList) grid.appendChild(albumCard(a));
  albumsBlock.appendChild(grid);
  host.appendChild(albumsBlock);

  host.appendChild(bandOverview(artist.name));

  enter([hero], { y: 14, wipe: true });
  enter(list.children, { each: 16, y: 8, delay: 60 });
  enter(grid.children, { each: 22, y: 12, delay: 120 });

  const refresh = () => {
    for (const row of list.children) {
      const i = parseInt(row.dataset.index, 10);
      if (!isNaN(i)) factory.render(row, top[i], i);
    }
  };
  const off = player.events.on('track', refresh);
  const offState = player.events.on('state', refresh);
  return () => { off(); offState(); };
}

/* ------------------------------------------------------------------ PLAYLISTS */

/*
 * What you have just been listening to.
 *
 * `history.recent` has been kept since the first release — sixty ids, newest
 * first, written on every play and restored from IndexedDB — and the only thing
 * that ever read it was one button on Home. There was no page to go to and no
 * way to see past the top of it, which makes the single most common question a
 * music player is asked ("what was that?") one it could not answer.
 *
 * Newest first and *not* sortable: this is a log, and the order is the
 * information. Sorting it by title would turn it back into the library.
 */
function viewRecent(host) {
  // `fmtAgo` is written for a narrow column, where "now" is the whole answer.
  // In a sentence it needs the rest of the words around it.
  const ago = (ts) => { const a = fmtAgo(ts); return a === 'now' ? 'just now' : a + ' ago'; };
  const origin = { type: 'recent', label: 'Recently played' };
  const get = () => lib.recentTracks();
  const tracks0 = get();

  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Recently played' }),
    el('p', { class: 'page-sub' }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Recently played');

  const paintSub = () => {
    const list = get();
    head.querySelector('.page-sub').textContent = list.length
      ? `${fmtCount(list.length, 'track')} · last played ${ago(list[0].lastPlayed)}`
      : 'Nothing played yet';
  };
  paintSub();

  if (!tracks0.length) {
    host.appendChild(emptyState({
      icon: 'clock',
      title: 'Nothing played yet',
      note: 'Everything you play lands here, newest first — the last sixty tracks.',
      action: { label: 'Browse songs', onSelect: () => (location.hash = '#/songs') },
    }));
    enter([head], { y: 10 });
    const off = lib.events.on('history', () => {
      if (get().length) document.dispatchEvent(new CustomEvent('sonora:refresh'));
    });
    return () => off();
  }

  const bar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('play') + '<span>Play all</span>', onclick: () => playAll(get(), 0, origin) }),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(get(), origin) }));
  host.appendChild(bar);

  const table = trackTable(host, get, {
    origin,
    columns: ['index', 'art', 'title', 'album', 'played', 'duration'],
  });
  enter([head, bar], { y: 10 });

  /* The list reorders under you as you listen, which is correct and would be
     unreadable if it happened while you were reading it — so the repaint waits
     for the track to change rather than following the playhead. */
  const off = lib.events.on('history', () => { table.update(); paintSub(); });
  const offChange = lib.events.on('change', () => { table.update(); paintSub(); });
  return () => { off(); offChange(); table.destroy(); };
}

function viewPlaylists(host) {
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Playlists' }),
    el('p', { class: 'page-sub', text: fmtCount(lib.state.playlists.length, 'playlist') }));
  host.appendChild(head);

  const m3uPicker = el('input', {
    type: 'file', accept: '.m3u,.m3u8,audio/x-mpegurl', hidden: true,
    onchange: async () => {
      const f = m3uPicker.files && m3uPicker.files[0];
      m3uPicker.value = '';
      if (f) offerM3U(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    },
  });

  const bar = el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn primary', html: ico('plus') + '<span>New playlist</span>',
      onclick: () => promptDialog({
        title: 'New playlist', label: 'Name', value: 'My playlist', confirm: 'Create',
        onConfirm: async (name) => { if (name) { const p = await lib.createPlaylist(name); location.hash = '#/playlist/' + p.id; } },
      }),
    }),
    m3uPicker,
    el('button', {
      /* L13: read one in. A file input as well as the drop target, because
         "open a playlist" is a thing people go looking for. */
      class: 'btn ghost', html: ico('folder') + '<span>Open an .m3u</span>',
      onclick: () => m3uPicker.click(),
    }));
  host.appendChild(bar);

  const grid = el('div', { class: 'grid' });
  const paint = () => {
    grid.textContent = '';
    for (const p of lib.state.playlists) {
      const tracks = lib.playlistTracks(p);
      const card = el('article', { class: 'card', tabindex: '0', role: 'button', onclick: () => (location.hash = '#/playlist/' + p.id) });
      const cover = tracks[0]?.albumKey;
      card.innerHTML =
        `<div class="card-art"><div class="art" style="background:${placeholderStyle(p.id)}"><img class="art-img" alt="" decoding="async"></div>` +
        '<i class="card-tick tl"></i><i class="card-tick br"></i>' +
        `<button class="fab card-fab" tabindex="-1" aria-label="Play">${ico('play')}</button></div>` +
        '<div class="card-title"></div><div class="card-sub"></div>';
      tilt3d(card.querySelector('.card-art'), { max: 8, lift: 16, scale: 1.015 });
      if (cover) paintArt(card.querySelector('.art-img'), cover);
      card.querySelector('.card-title').textContent = p.name;
      card.querySelector('.card-sub').textContent = fmtCount(tracks.length, 'track') + (p.smart ? ' · describes itself' : '');
      card.querySelector('.card-fab').addEventListener('click', (e) => {
        e.stopPropagation();
        playAll(tracks, 0, { type: 'playlist', key: p.id, label: p.name });
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu([
          { label: 'Rename', icon: 'edit', onSelect: () => promptDialog({ title: 'Rename playlist', label: 'Name', value: p.name, onConfirm: (n) => n && lib.updatePlaylist(p.id, { name: n }) }) },
          { label: 'Delete', icon: 'trash', danger: true, onSelect: () => lib.removePlaylist(p.id) },
        ], { event: e });
      });
      grid.appendChild(card);
    }
    if (!lib.state.playlists.length) {
      grid.appendChild(emptyState({ icon: 'playlist', title: 'No playlists yet', note: 'Right-click any track to add it to one.' }));
    }
    enter(grid.children, { each: 24, y: 12 });
  };
  paint();
  host.appendChild(grid);
  enter([head, bar], { y: 10 });

  const off = lib.events.on('playlists', paint);
  return () => off();
}

/* ------------------------------------------------------------------ FAVOURITES */

/**
 * The starred tracks, newest mark first — the one list in the app whose order
 * is neither alphabetical nor the order of a record, because it is a record of
 * decisions rather than of music. Sorting it would throw that away, so it is
 * the only track table with no column header.
 */
function viewFavourites(host) {
  const origin = { type: 'favourites', label: 'Favourites' };
  const get = () => lib.favouriteTracks();
  const tracks0 = get();

  /**
   * A list and an empty state are two different pages, so the swap between
   * them is a route refresh — and that refresh is always one task away from
   * the event that asked for it.
   *
   * Doing it inline deadlocks the app: `Emitter.emit` walks a Set, a Set
   * visits entries added to it *while* it is being walked, and rebuilding the
   * view from inside the walk hands the new page's subscription straight back
   * to the loop that is still running. It re-renders until the tab gives up.
   * Deferring costs a frame nobody can see and makes the whole shape safe.
   */
  let queued = false;
  const rebuild = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      document.dispatchEvent(new CustomEvent('sonora:refresh'));
    }, 0);
  };

  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Favourites' }),
    el('p', { class: 'page-sub' }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Favourites');

  const paintSub = () => {
    const list = get();
    head.querySelector('.page-sub').textContent = list.length
      ? `${fmtCount(list.length, 'track')} · ${fmtTotal(list.reduce((s, t) => s + (t.duration || 0), 0))}`
      : 'Nothing starred yet';
  };
  paintSub();

  if (!tracks0.length) {
    // The mark is on the row and on the transport, and the key is the same in
    // both places — say which, because a feature nobody can find is not one.
    host.appendChild(emptyState({
      icon: 'star',
      title: 'No favourites yet',
      note: 'Press the star on any track — or F while it is playing — and it lands here, newest first.',
      action: { label: 'Browse songs', onSelect: () => (location.hash = '#/songs') },
    }));
    enter([head], { y: 10 });
    // Only when there is something to show: a star set and cleared again
    // while this page is open must not rebuild it twice for nothing.
    const off = lib.events.on('favourites', () => { if (get().length) rebuild(); });
    const offChange = lib.events.on('change', () => { if (get().length) rebuild(); });
    return () => { off(); offChange(); };
  }

  const bar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('play') + '<span>Play all</span>', onclick: () => playAll(get(), 0, origin) }),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(get(), origin) }));
  host.appendChild(bar);

  const table = trackTable(host, get, {
    origin,
    columns: ['index', 'art', 'title', 'album', 'duration'],
    removeLabel: 'Remove from favourites',
    onRemove: (t) => lib.toggleFavourite(t.id, false),
  });
  enter([head, bar], { y: 10 });

  // Unstarring from this page removes the row, so the list is rebuilt rather
  // than repainted — everywhere else in the app the set does not change. When
  // the last one goes the page has to become the empty state instead.
  const sync = () => {
    if (!get().length) return rebuild();
    paintSub();
    table.update();
  };
  const off = lib.events.on('favourites', sync);
  const offChange = lib.events.on('change', sync);
  return () => { off(); offChange(); table.destroy(); };
}

/** L13: writes one playlist out as Extended M3U. */
function saveM3U(p) {
  const tracks = lib.playlistTracks(p);
  if (!tracks.length) { toast('Nothing in it to save'); return; }
  const blob = new Blob([m3u.write(p.name, tracks)], { type: 'audio/x-mpegurl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: m3u.fileName(p.name) });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Saved ${fmtCount(tracks.length, 'track')}`);
}

/**
 * L13/L14: reads M3U text in, and says plainly what it could not find.
 *
 * A path from another player is a path from another machine, so a playlist
 * that arrives 90% matched is the normal case rather than a failure — and the
 * missing tenth is worth naming, because it is usually one album that has been
 * moved rather than ten files that are gone.
 */
function offerM3U(text, fallbackName) {
  const parsed = m3u.parse(text);
  if (!parsed.entries.length) { toast('That playlist file is empty'); return; }
  const { found, missing } = m3u.resolve(parsed.entries);
  const name = parsed.name || fallbackName || 'Imported playlist';

  const body = el('div', {},
    el('p', { text: `“${name}” lists ${fmtCount(parsed.entries.length, 'track')}. ${found.length} of them are in your library.` }),
    missing.length
      ? el('details', { class: 'm3u-missing' },
        el('summary', { text: `${missing.length} not found` }),
        el('ul', { class: 'fail-list' }, missing.slice(0, 40).map((e) =>
          el('li', {}, el('span', { class: 'fail-name', text: e.label || e.path })))),
        missing.length > 40 ? el('p', { class: 'muted', text: `and ${missing.length - 40} more` }) : null)
      : null,
    !found.length
      ? el('p', { class: 'muted', text: 'None of these paths match anything here. If the music is in a folder Sonora has not been given, add it first.' })
      : null);

  dialog({
    title: 'Import this playlist?',
    body,
    width: 520,
    actions: [
      { label: 'Cancel' },
      { label: 'Import', primary: true, onSelect: async () => {
        if (!found.length) { toast('Nothing to import'); return; }
        await lib.createPlaylist(name, found.map((t) => t.id));
        toast(`Imported “${name}” — ${fmtCount(found.length, 'track')}`);
      } },
    ],
  });
}

function viewPlaylist(host, id) {
  const p = lib.state.playlists.find((x) => x.id === id);
  if (!p) return notFound(host, 'Playlist not found');
  const origin = { type: 'playlist', key: id, label: p.name };

  const hero = el('header', { class: 'hero' });
  const tracks0 = lib.playlistTracks(p);
  const art = artBox(tracks0[0]?.albumKey || p.id, null, 'hero-art');
  const meta = el('div', { class: 'hero-meta' },
    el('p', { class: 'eyebrow', text: p.smart ? 'Smart shelf' : 'Playlist' }),
    el('h1', { class: 'hero-title', text: p.name }),
    el('p', { class: 'hero-sub' },
      el('span', { text: fmtCount(tracks0.length, 'track') }),
      el('span', { class: 'dot' }),
      el('span', { text: fmtTotal(tracks0.reduce((s, t) => s + (t.duration || 0), 0)) })));
  meta.appendChild(el('div', { class: 'hero-actions' },
    playFab(() => playAll(lib.playlistTracks(p), 0, origin)),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(lib.playlistTracks(p), origin) }),
    el('button', {
      class: 'icon-btn', html: ico('more'), onclick: (e) => menu([
        { label: 'Rename', icon: 'edit', onSelect: () => promptDialog({ title: 'Rename playlist', label: 'Name', value: p.name, onConfirm: (n) => n && lib.updatePlaylist(p.id, { name: n }) }) },
        p.smart && {
          label: 'Edit the rules…', icon: 'sliders',
          onSelect: () => rulesDialog(p, (set) => {
            lib.updatePlaylist(p.id, {
              name: set.name, match: set.match, rules: set.rules,
              sort: set.sort, sortDir: set.sortDir, limit: set.limit,
            });
            document.dispatchEvent(new CustomEvent('sonora:refresh'));
          }),
        },
        { label: 'Add to queue', icon: 'queue', onSelect: () => { player.enqueue(lib.playlistTracks(p)); toast('Added to queue'); } },
        { separator: true },
        /* L13: out of the box. A playlist that exists only inside IndexedDB is
           the same lock-in this application objects to everywhere else. */
        { label: 'Save as .m3u8', icon: 'file', onSelect: () => saveM3U(p) },
        { separator: true },
        { label: 'Delete playlist', icon: 'trash', danger: true, onSelect: () => { lib.removePlaylist(p.id); location.hash = '#/playlists'; } },
      ], { anchor: e.currentTarget }),
    })));
  hero.append(art, meta);
  host.appendChild(hero);
  if (tracks0[0]) applyHeroTint(hero, tracks0[0].albumKey);

  if (!tracks0.length) {
    host.appendChild(emptyState(p.smart
      ? { icon: 'sparkle', title: 'Nothing matches yet',
          note: `This shelf describes ${rules.describe(p)}. Edit the rules, or give the library time to catch up.` }
      : { icon: 'playlist', title: 'This playlist is empty', note: 'Right-click a track anywhere and choose “Add to playlist”.' }));
    enter([hero], { y: 14 });
    const off = lib.events.on('playlists', () =>
      document.dispatchEvent(new CustomEvent('sonora:refresh')));
    return () => off();
  }

  const columns = ['index', 'art', 'title', 'album', 'dr', 'duration'];
  if (p.smart) host.appendChild(el('p', { class: 'smart-note note', text: rules.describe(p) }));

  /* A smart shelf has nothing to remove from: its contents are a consequence
     of its rules, so taking a track out would either be undone on the next
     repaint or quietly rewrite the description. The rules are the edit. */
  const table = trackTable(host, () => lib.playlistTracks(p), {
    origin, columns,
    removeLabel: p.smart ? null : 'Remove from playlist',
    onRemove: p.smart ? null : (t) => {
      const i = p.tracks.indexOf(t.id);
      if (i >= 0) { p.tracks.splice(i, 1); lib.updatePlaylist(p.id, { tracks: p.tracks }); }
    },
  });
  enter([hero], { y: 14 });

  const rerender = () => table.update();
  const off = lib.events.on('playlists', rerender);
  return () => { off(); table.destroy(); };
}

/* ------------------------------------------------------------------ SEARCH */

function viewSearch(host, query) {
  const head = el('header', { class: 'page-head' },
    el('h1', { class: 'page-title', text: query ? `Results for “${query}”` : 'Search' }));
  host.appendChild(head);

  if (!query) {
    host.appendChild(emptyState({ icon: 'search', title: 'Search your library', note: 'Titles, artists, albums and genres.' }));
    return () => {};
  }

  const res = lib.search(query);
  if (!res.tracks.length && !res.albums.length && !res.artists.length) {
    host.appendChild(emptyState({ icon: 'search', title: 'Nothing found', note: `No matches for “${query}”.` }));
    return () => {};
  }

  if (res.artists.length) {
    const block = el('section', { class: 'block' }, sectionHead('Artists'));
    const grid = el('div', { class: 'grid' });
    for (const a of res.artists.slice(0, 6)) grid.appendChild(artistCard(a));
    block.appendChild(grid);
    host.appendChild(block);
    enter(grid.children, { each: 20, y: 10 });
  }

  if (res.albums.length) {
    const block = el('section', { class: 'block' }, sectionHead('Albums'));
    const grid = el('div', { class: 'grid' });
    for (const a of res.albums.slice(0, 12)) grid.appendChild(albumCard(a));
    block.appendChild(grid);
    host.appendChild(block);
    enter(grid.children, { each: 18, y: 10, delay: 40 });
  }

  if (res.tracks.length) {
    const block = el('section', { class: 'block' }, sectionHead('Songs'));
    host.appendChild(block);
    const list = el('div', { class: 'plain-list' });
    const factory = trackRowFactory({
      columns: ['index', 'art', 'title', 'album', 'duration'],
      onPlay: (i) => playAll(res.tracks, i, { type: 'search', label: query }),
      onMenu: (i, anchor, event) => menu(trackMenu([res.tracks[i]]), { anchor, event }),
    });
    res.tracks.slice(0, 40).forEach((t, i) => {
      const row = factory.create();
      row.dataset.index = i;
      row.classList.add('static-row');
      factory.render(row, t, i);
      list.appendChild(row);
    });
    block.appendChild(list);
    enter(list.children, { each: 12, y: 8, delay: 80 });
  }

  enter([head], { y: 10 });
  return () => {};
}

/* ------------------------------------------------------------------ ANALYSIS */

function viewCircles(host) {
  const api = mountCircles(host);

  const onReset = () => dialog({
    title: 'Reset listening data?',
    body: el('p', { class: 'muted', text: 'Every second counted so far is discarded. Your library, playlists and files are untouched — only the analytics are cleared.' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Reset', danger: true, onSelect: async () => { await stats.reset(); api.refresh(); toast('Listening data cleared'); } },
    ],
  });
  host.addEventListener('circles:reset', onReset);

  enter(host.children, { each: 60, y: 12 });
  return () => { host.removeEventListener('circles:reset', onReset); api.destroy(); };
}

/* ------------------------------------------------------------------ SOUND */

const viewSound = (host) => mountSound(host);

/* ------------------------------------------------------------------ BAND */

/**
 * The Band Overview: four cards of context about whoever you are listening to,
 * fetched only when the feature is on, only when asked, and cached for a month.
 */
function bandOverview(artistName) {
  const wrap = el('section', { class: 'block band' });
  const body = el('div', { class: 'band-body' });
  const status = el('div', { class: 'band-status' });

  const runBtn = el('button', {
    class: 'btn ghost sm', html: ico('globe') + '<span>Analyse online</span>',
    onclick: () => start(),
  });
  wrap.append(sectionHead('Band overview', null, null), status, body);
  wrap.querySelector('.section-head').appendChild(runBtn);

  const say = (text, kind = '') => {
    status.textContent = '';
    status.className = 'band-status' + (kind ? ' is-' + kind : '');
    status.appendChild(el('span', { text }));
  };

  function consentDialog() {
    return new Promise((resolve) => {
      dialog({
        title: 'Look this artist up online?',
        width: 520,
        body: el('div', {},
          el('p', { class: 'muted', text: 'Sonora is offline by design. Turning this on sends one thing to two public services, and only when you ask for it:' }),
          el('ul', { class: 'band-consent' },
            el('li', { text: 'The artist name — to MusicBrainz, for biography, line-up and discography.' }),
            el('li', { text: 'The matching page title — to Wikipedia, for the summary paragraph.' }),
            el('li', { text: 'Nothing else. Not your library, not your listening history, not a file name.' })),
          el('p', { class: 'muted small', text: 'Answers are cached on this device for 30 days, and you can clear them or switch this off again in Settings.' })),
        actions: [
          { label: 'Not now', onSelect: () => resolve(false) },
          { label: 'Enable lookups', primary: true, onSelect: () => resolve(true) },
        ],
      });
    });
  }

  async function start() {
    if (!band.isEnabled()) {
      const ok = await consentDialog();
      if (!ok) return;
      band.setEnabled(true);
    }
    if (!band.isOnline()) { say('No connection — this needs the internet.', 'warn'); return; }

    runBtn.disabled = true;
    say('Looking up ' + artistName + '…');
    try {
      const data = await band.analyseArtist(artistName);
      status.textContent = '';
      paint(data);
    } catch (err) {
      const why = {
        offline: 'No connection — this needs the internet.',
        'not-found': `Nothing found online for “${artistName}”.`,
        consent: 'Online lookups are switched off.',
      }[err.message] || 'Lookup failed — the service may be busy. Try again in a moment.';
      say(why, 'warn');
    } finally {
      runBtn.disabled = false;
    }
  }

  function paint(data) {
    body.textContent = '';
    runBtn.innerHTML = ico('refresh') + '<span>Refresh</span>';

    const card = (title, ...kids) => {
      const c = el('article', { class: 'band-card' },
        el('h3', { class: 'band-card-title label', text: title }));
      c.append(...kids.filter(Boolean));
      return c;
    };

    /* --- biography ---------------------------------------------------- */
    const bio = data.bio?.extract
      ? el('p', { class: 'band-text', text: data.bio.extract })
      : el('p', { class: 'band-text muted', text: 'No summary available for this artist.' });
    const bioCard = card('Biography', bio,
      data.bio?.url ? el('a', { class: 'link-btn', href: data.bio.url, target: '_blank', rel: 'noreferrer noopener', text: 'Read on Wikipedia' }) : null);

    /* --- activity ----------------------------------------------------- */
    const facts = el('dl', { class: 'info-grid band-facts' });
    const fact = (k, v) => { if (!v) return; facts.append(el('dt', { text: k }), el('dd', { text: String(v) })); };
    fact('Type', data.type);
    fact('From', data.area);
    fact('Began', data.began);
    fact(data.ended ? 'Ended' : 'Status', data.ended || (data.active ? 'Active' : 'Unknown'));
    fact('Tags', data.tags.join(', '));
    const activityCard = card('Activity', facts);

    /* --- discography -------------------------------------------------- */
    const list = el('div', { class: 'band-list' });
    const owned = new Map(lib.state.albums.map((a) => [a.title.toLowerCase(), a]));
    for (const rel of data.releases) {
      const mine = owned.get(rel.title.toLowerCase());
      const row = el('div', { class: 'band-row' + (mine ? ' is-owned' : '') },
        el('span', { class: 'band-row-year mono', text: rel.year || '—' }),
        el('span', { class: 'band-row-title', text: rel.title }),
        el('span', { class: 'chip', text: rel.type }),
        mine
          ? el('button', {
              class: 'icon-btn sm', title: 'Play from your library', 'aria-label': `Play ${rel.title}`,
              html: ico('play'), onclick: () => playAll(mine.tracks, 0, { type: 'album', key: mine.key, label: mine.title }),
            })
          : el('button', {
              class: 'icon-btn sm', title: 'Analyse this record', 'aria-label': `Analyse ${rel.title}`,
              html: ico('info'), onclick: (e) => deepen(e.currentTarget, rel),
            }));
      if (mine) row.addEventListener('dblclick', () => (location.hash = '#/album/' + mine.key));
      list.appendChild(row);
    }
    const discCard = card('Discography', data.releases.length ? list
      : el('p', { class: 'band-text muted', text: 'No releases listed.' }));

    /* --- people and links --------------------------------------------- */
    const people = el('div', { class: 'band-chips' });
    for (const m of data.members) people.appendChild(el('span', { class: 'chip', text: m.name + (m.ended ? ' (past)' : '') }));
    for (const l of data.links) {
      people.appendChild(el('a', {
        class: 'chip band-link', href: l.url, target: '_blank', rel: 'noreferrer noopener',
        text: l.label,
      }));
    }
    const peopleCard = card('Line-up and links',
      people.children.length ? people : el('p', { class: 'band-text muted', text: 'Nothing listed.' }));

    body.append(bioCard, activityCard, discCard, peopleCard);
    body.appendChild(el('p', { class: 'band-source small faint',
      text: 'Data from MusicBrainz and Wikipedia · cached on this device' }));
    enter(body.children, { each: 60, y: 12 });
  }

  /** One record, looked at more closely, on demand. */
  async function deepen(btn, rel) {
    btn.disabled = true;
    try {
      const detail = await band.analyseRelease(artistName, rel.title);
      const bits = [detail.type, ...(detail.secondary || []), detail.year && 'First released ' + detail.year]
        .filter(Boolean).join(' · ');
      const row = btn.closest('.band-row');
      row.appendChild(el('span', { class: 'band-row-detail small faint', text: bits || 'No further detail' }));
      btn.remove();
    } catch {
      toast('Could not analyse that record');
      btn.disabled = false;
    }
  }

  // Anything already cached appears without a request being made.
  band.peek('artist:' + artistName.toLowerCase()).then((hit) => {
    if (hit?.data) paint(hit.data);
    else if (!band.isEnabled()) say('Off by default. Nothing is fetched until you ask.');
    else if (!band.isOnline()) say('Offline — connect to look this artist up.');
    else say('Not looked up yet.');
  });

  return wrap;
}

/* ------------------------------------------------------------------ SETTINGS */

function viewSettings(host) {
  const offs = [];
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'System' }),
    el('h1', { class: 'page-title', text: 'Settings' }),
    el('p', { class: 'page-sub', text: 'Playback · folders · appearance · visualiser · storage' }));
  host.appendChild(head);

  /* --- playback ---
   *
   * One slider for gapless and crossfade, because they are one mechanism: at
   * zero the next track starts the instant the last one ends, and above zero
   * they overlap. Splitting them into two controls would suggest they can
   * disagree, and would leave a listener wondering which one wins. */
  const playback = el('section', { class: 'block' }, sectionHead('Playback'));
  const pbRows = el('div', { class: 'rows' });

  const fadeValue = el('span', { class: 'settings-value' });
  const fadeSlider = el('input', {
    type: 'range', min: '0', max: String(player.MAX_CROSSFADE), step: '0.5',
    class: 'settings-range', 'aria-label': 'Crossfade length in seconds',
    value: String(player.state.crossfade),
  });
  const paintFade = () => {
    const v = player.state.crossfade;
    fadeValue.textContent = v === 0 ? 'Gapless' : v.toFixed(1).replace(/\.0$/, '') + 's';
    fadeSlider.value = String(v);
    fadeSlider.setAttribute('aria-valuetext', fadeValue.textContent);
  };
  fadeSlider.addEventListener('input', () => {
    player.setCrossfade(parseFloat(fadeSlider.value));
    paintFade();
  });
  paintFade();

  const seamlessSwitch = el('button', {
    class: 'switch' + (player.state.seamless ? ' is-on' : ''),
    role: 'switch', 'aria-checked': String(player.state.seamless),
  }, el('span', { class: 'switch-knob' }));
  seamlessSwitch.addEventListener('click', () => {
    player.setSeamless(!player.state.seamless);
    const on = player.state.seamless;
    seamlessSwitch.classList.toggle('is-on', on);
    seamlessSwitch.setAttribute('aria-checked', String(on));
    fadeSlider.disabled = !on;
  });
  fadeSlider.disabled = !player.state.seamless;

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('next') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Run tracks together' }),
      el('div', { class: 'settings-note', text: 'Hand over to the next track without stopping. Off leaves the gap between them.' })),
    el('div', { class: 'settings-actions' }, seamlessSwitch)));

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('shuffle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Crossfade' }),
      el('div', { class: 'settings-note', text: 'How long the two overlap. At zero the next track starts the instant the last one ends — what a live album needs.' })),
    el('div', { class: 'settings-actions settings-slider' }, fadeSlider, fadeValue)));

  /* Q7: which shape the overlap takes. Two ramps that each run 0..1 sum to 1
     in amplitude, which is a dip of about 3dB in the middle where the two
     tracks are uncorrelated — audible on anything with a steady bed under it.
     The equal-power pair sums to 1 in *power* instead and holds the level, at
     the cost of a bump where the two do correlate. Neither is right for every
     pair of records, so it is a choice rather than a constant. */
  const curvePick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Crossfade shape' });
  for (const [mode, label, hint] of [
    ['equal', 'Hold the level', 'Equal power: the overlap stays as loud as either track alone'],
    ['linear', 'Straight lines', 'Equal amplitude: dips slightly in the middle, and never bumps'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.fadeCurve === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.fadeCurve === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setFadeCurve(mode);
      for (const x of curvePick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    curvePick.appendChild(b);
  }

  const curveRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('sliders') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Crossfade shape' }),
      el('div', { class: 'settings-note', text: 'Holding the level suits most records. Straight lines are the safer choice where two tracks share a drone or a room \u2014 there, holding the level can bump.' })),
    el('div', { class: 'settings-actions' }, curvePick));
  curveRow.hidden = player.state.crossfade === 0;
  pbRows.appendChild(curveRow);

  /* The shape only exists while there is an overlap to shape, so the row
     appears with the slider rather than sitting there greyed out. */
  const paintCurveRow = () => { curveRow.hidden = !player.state.seamless || player.state.crossfade === 0; };
  fadeSlider.addEventListener('input', paintCurveRow);
  seamlessSwitch.addEventListener('click', paintCurveRow);
  paintCurveRow();

  const levelPick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Loudness levelling' });
  for (const [mode, label, hint] of [
    ['off', 'Off', 'Play every file at the level it was mastered'],
    ['track', 'Track', 'Even out every song against every other'],
    ['album', 'Album', 'Move each record as a whole, keeping its internal balance'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.levelling === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.levelling === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setLevelling(mode);
      for (const x of levelPick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    levelPick.appendChild(b);
  }

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('volume') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Even out the volume' }),
      el('div', { class: 'settings-note', text: 'Uses the ReplayGain tag where a file has one, and what Sonora measured on the first listen where it does not.' })),
    el('div', { class: 'settings-actions' }, levelPick)));

  const shufPick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Shuffle style' });
  for (const [mode, label, hint] of [
    ['even', 'Even', 'Every track equally likely'],
    ['weighted', 'Learned', 'Leans towards what you play and away from what you just heard'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.shuffleMode === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.shuffleMode === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setShuffleMode(mode);
      for (const x of shufPick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    shufPick.appendChild(b);
  }

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('shuffle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Shuffle style' }),
      el('div', { class: 'settings-note', text: 'Learned leans gently towards what you actually play, and hard away from anything heard in the last hour.' })),
    el('div', { class: 'settings-actions' }, shufPick)));

  /** A plain on/off row driven by a player setter. */
  const toggleRow = (icon, name, note, get, set) => {
    const btn = el('button', {
      class: 'switch' + (get() ? ' is-on' : ''),
      role: 'switch', 'aria-checked': String(get()),
    }, el('span', { class: 'switch-knob' }));
    btn.addEventListener('click', () => {
      set(!get());
      const on = get();
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
    });
    return el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico(icon) }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: name }),
        el('div', { class: 'settings-note', text: note })),
      el('div', { class: 'settings-actions' }, btn));
  };

  pbRows.appendChild(toggleRow('play', 'Skip the silence at the start',
    'Most rips carry a second or two of nothing before the first note. Starts at the music instead, and the scrubber still shows what was skipped.',
    () => player.state.trimSilence, (v) => player.setTrimSilence(v)));

  pbRows.appendChild(toggleRow('sliders', 'Land the crossfade on the beat',
    'Where both tracks have a clear tempo and the two are close, the overlap starts on a beat rather than on a stopwatch.',
    () => player.state.beatMatch, (v) => player.setBeatMatch(v)));

  /* Q8: which output the sound leaves by. The browser will only name devices
     once it has been given permission to look at them, and asking for that
     permission means asking for a microphone \u2014 too steep a price to pay on
     the chance somebody owns two sets of speakers. So the list stays a button
     until it is wanted. */
  if (player.canRouteOutput()) {
    const pick = el('select', { class: 'settings-select', 'aria-label': 'Output device' });
    const note = el('div', { class: 'settings-note', text: 'Sonora plays through whatever the system is using. Choose a different output to send it somewhere else.' });
    let loaded = false;

    const fill = async () => {
      const devices = await player.outputs();
      pick.textContent = '';
      pick.appendChild(el('option', { value: '', text: 'System default' }));
      for (const d of devices) pick.appendChild(el('option', { value: d.deviceId, text: d.label }));
      pick.value = player.state.sink || '';
      loaded = true;
    };

    const reveal = el('button', { class: 'btn sm', text: 'Choose\u2026' });
    reveal.addEventListener('click', async () => {
      reveal.disabled = true;
      const ok = await player.askForOutputs();
      reveal.disabled = false;
      if (!ok) { note.textContent = 'The browser would not list the outputs. Sonora keeps using the system default.'; return; }
      reveal.hidden = true;
      pick.hidden = false;
      await fill();
    });
    pick.hidden = true;
    pick.addEventListener('change', async () => {
      const res = await player.setSink(pick.value);
      if (!res.ok && pick.value) {
        pick.value = '';
        toast('That output is no longer there');
      }
    });
    /* Where permission has already been granted the list can be built without
       asking again, so the button never appears. */
    player.outputsNamed().then((named) => {
      if (!named) return;
      reveal.hidden = true;
      pick.hidden = false;
      if (!loaded) fill();
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (loaded) fill(); });

    pbRows.appendChild(el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico('volume') }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: 'Play through' }), note),
      el('div', { class: 'settings-actions' }, reveal, pick)));
  }

  playback.appendChild(pbRows);
  host.appendChild(playback);

  /* --- folders --- */
  const folders = el('section', { class: 'block' }, sectionHead('Music folders'));
  const list = el('div', { class: 'rows' });

  const onOff = (root) => {
    const btn = el('button', {
      class: 'switch' + (root.off ? '' : ' is-on'),
      role: 'switch', 'aria-checked': String(!root.off),
      title: root.off ? 'Bring this folder back into the library' : 'Hide this folder without forgetting anything about it',
    }, el('span', { class: 'switch-knob' }));
    btn.addEventListener('click', async () => {
      await lib.setRootOff(root.id, !root.off);
      paintRoots();
      toast(root.off ? `“${root.name}” is back` : `“${root.name}” hidden — nothing was forgotten`);
    });
    return btn;
  };

  const paintRoots = () => {
    list.textContent = '';
    if (!lib.state.roots.length) {
      list.appendChild(el('p', { class: 'muted', text: 'No folders added yet.' }));
    }
    for (const root of lib.state.roots) {
      const row = el('div', { class: 'settings-row' + (root.off ? ' is-off' : '') },
        el('div', { class: 'settings-ico', html: ico('folder') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: root.name }),
          el('div', { class: 'settings-note', text:
            root.off ? 'Off — its tracks are out of the library, and everything you have told Sonora about them is kept'
            : root.needsPermission ? 'Permission needed — click Reconnect'
            : root.needsReconnect ? 'Re-add this folder to play its files this session'
            : `${fmtCount(root.count || 0, 'file')} · ${root.kind === 'handle' ? 'linked folder' : 'session only'}` })),
        el('div', { class: 'settings-actions' },
          /* I4: off, not gone. The only two options were keep and remove, and
             removing empties everything that came from the folder —
             corrections and favourites included. A drive that is not plugged
             in today is not a folder you want to forget. */
          onOff(root),
          (root.needsPermission || root.needsReconnect)
            ? el('button', { class: 'btn ghost sm', text: 'Reconnect', onclick: () => document.dispatchEvent(new CustomEvent('sonora:add')) })
            : el('button', { class: 'btn ghost sm', text: 'Rescan', disabled: !!root.off, onclick: () => lib.scanRoot(root) }),
          el('button', {
            class: 'icon-btn', html: ico('trash'), title: 'Remove',
            onclick: () => dialog({
              title: `Remove “${root.name}”?`,
              body: el('p', { class: 'muted', text: 'Tracks from this folder are removed from the library. Nothing on disk is touched.' }),
              actions: [{ label: 'Cancel' }, { label: 'Remove', danger: true, onSelect: () => lib.removeRoot(root.id) }],
            }),
          })));
      list.appendChild(row);
    }
  };
  paintRoots();
  folders.appendChild(list);
  folders.appendChild(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('plus') + '<span>Add folder</span>', onclick: () => document.dispatchEvent(new CustomEvent('sonora:add')) }),
    el('button', { class: 'btn ghost', html: ico('refresh') + '<span>Rescan all</span>', onclick: () => lib.rescanAll() })));
  host.appendChild(folders);

  /* --- what the imports did ---
   *
   * I3. "Added 50 tracks · merged Graduation" was a toast: it named the merge,
   * which is exactly right, and then it was gone in four seconds and the merge
   * was unreviewable. I2's failures had nowhere to be read at all. The last few
   * runs are kept and both live here.
   */
  const imports = el('section', { class: 'block' }, sectionHead('Recent imports'));
  const runList = el('div', { class: 'rows' });
  imports.appendChild(runList);
  imports.appendChild(el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn ghost', html: ico('refresh') + '<span>Check for new files</span>',
      title: 'Walk the folders again. Only files that changed are re-read.',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const r = await lib.rescanAll();
        btn.disabled = false;
        if (!r.ok) toast('No folders to check');
      },
    })));

  const paintRuns = () => {
    const runs = lib.importRuns();
    runList.textContent = '';
    if (!runs.length) {
      runList.appendChild(el('p', { class: 'muted', text: 'Nothing imported yet this library. Runs that add, merge or fail on something are listed here.' }));
      return;
    }
    for (const run of runs) {
      const bits = [];
      if (run.added) bits.push(fmtCount(run.added, 'track') + ' added');
      if (run.merged.length) bits.push('merged ' + run.merged.slice(0, 3).map((t) => `“${t}”`).join(', ') +
        (run.merged.length > 3 ? ` and ${run.merged.length - 3} more` : ''));
      if (run.failed) bits.push(`${run.failed} read from the folder name`);

      const row = el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico(run.failed ? 'info' : 'database') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtAgo(run.at) + (run.ms > 1500 ? ` · ${(run.ms / 1000).toFixed(0)}s` : '') }),
          el('div', { class: 'settings-note', text: bits.join(' · ') || 'Nothing changed' })),
        el('div', { class: 'settings-actions' },
          run.failures.length
            ? el('button', {
              class: 'btn ghost sm', text: 'Which ones',
              onclick: () => dialog({
                title: `${fmtCount(run.failed, 'file')} Sonora learned nothing from`,
                width: 520,
                body: el('div', {},
                  el('p', { class: 'muted', text: 'Everything about these came from the folder they are in rather than from the files themselves. They were imported all the same, and they play — but the artist and album are a guess, and this is the list to check when the library has come out wrong. Sonora never writes to your files.' }),
                  el('ul', { class: 'fail-list' }, run.failures.map((f) =>
                    el('li', {},
                      el('span', { class: 'fail-name', text: f.name }),
                      el('span', { class: 'fail-why', text: f.reason })))),
                  run.failed > run.failures.length
                    ? el('p', { class: 'muted', text: `and ${run.failed - run.failures.length} more` })
                    : null),
                actions: [{ label: 'Close', primary: true }],
              }),
            })
            : null));
      runList.appendChild(row);
    }
  };
  paintRuns();
  offs.push(lib.events.on('runs', paintRuns));
  host.appendChild(imports);

  /* --- what you have overridden ---
   *
   * L17. A chosen cover and a bound rack are invisible until you walk into the
   * record that has one, which makes them overrides you cannot find and
   * therefore cannot undo six months later. Listed, with a way back to each.
   */
  const overrides = el('section', { class: 'block' }, sectionHead('Your overrides'));
  const overRows = el('div', { class: 'rows' });
  overrides.appendChild(overRows);

  const paintOverrides = async () => {
    overRows.textContent = '';
    const covers = lib.chosenCovers();
    const bindings = rack.allBindings();

    if (!covers.length && !bindings.length) {
      overRows.appendChild(el('p', { class: 'muted', text: 'None yet. Drop a picture on a record to give it a cover, or bind a rack to an album from the Sound page.' }));
      return;
    }

    if (covers.length) {
      overRows.appendChild(el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('image') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtCount(covers.length, 'chosen cover') }),
          el('div', { class: 'settings-note' },
            el('span', { class: 'over-list' }, covers.slice(0, 12).map((c) =>
              el('a', { class: 'over-chip', href: '#/album/' + c.key,
                text: c.album ? c.album.title : 'a record that has gone' })),
              covers.length > 12 ? el('span', { class: 'muted', text: ` and ${covers.length - 12} more` }) : null)))));
    }

    if (bindings.length) {
      const named = [];
      for (const b of bindings) {
        const label = b.scope === 'album' ? (lib.state.albumBy.get(b.key)?.title || 'a record that has gone')
          : b.scope === 'artist' ? (lib.state.artists.find((a) => a.key === b.key)?.name || 'an artist that has gone')
          : b.key;
        named.push({ ...b, label });
      }
      overRows.appendChild(el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('sliders') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtCount(named.length, 'bound rack') }),
          el('div', { class: 'settings-note' },
            el('span', { class: 'over-list' }, named.slice(0, 12).map((b) =>
              el('a', {
                class: 'over-chip',
                href: b.scope === 'album' ? '#/album/' + b.key : '#/artist/' + b.key,
                text: b.label,
              })))))));
    }
  };
  paintOverrides();
  offs.push(lib.events.on('change', paintOverrides));
  offs.push(rack.events.on('bound', paintOverrides));
  host.appendChild(overrides);

  /* --- older libraries ---
   *
   * L18. `guessed` has only been recorded since 2.6, so a library imported
   * before that gets silently worse album merging than a fresh import would.
   * The row only appears when there is something to do.
   */
  const backfill = el('section', { class: 'block' }, sectionHead('Older imports'));
  const bfNote = el('div', { class: 'settings-note' });
  const bfBtn = el('button', { class: 'btn ghost sm', text: 'Re-read those tags' });
  backfill.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('refresh') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Tracks imported before Sonora recorded what it guessed' }), bfNote),
    el('div', { class: 'settings-actions' }, bfBtn)));

  const paintBackfill = () => {
    const n = lib.needsBackfill();
    backfill.hidden = n === 0;
    bfNote.textContent = n
      ? `${fmtCount(n, 'track')} came in before Sonora kept track of which fields it had to take from the folder name. Until it does, albums merge slightly worse than they should.`
      : '';
  };
  bfBtn.addEventListener('click', async () => {
    bfBtn.disabled = true;
    const res = await lib.backfillGuessed((done, total) => {
      bfBtn.textContent = `${done} of ${total}…`;
    });
    bfBtn.disabled = false;
    bfBtn.textContent = 'Re-read those tags';
    paintBackfill();
    toast(res.ok ? `Re-read ${fmtCount(res.done, 'track')}` : 'Already running');
  });
  paintBackfill();
  offs.push(lib.events.on('change', paintBackfill));
  host.appendChild(backfill);

  /* --- connection --- */
  const conn = el('section', { class: 'block' }, sectionHead('Connection'));
  conn.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('plug') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Reconnect on launch' }),
      el('div', { class: 'settings-note', text: 'Re-open the folders you linked and pick up the track you left, without being asked' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('autoconnect', true))));

  const stateRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('refresh') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Connection state' }),
      el('div', { class: 'settings-note', id: 'conn-note', text: connectionNote() })),
    el('div', { class: 'settings-actions' },
      session.isDisconnected()
        ? el('button', { class: 'btn ghost sm', text: 'Reconnect now', onclick: () => { document.dispatchEvent(new CustomEvent('sonora:reconnect')); setTimeout(() => document.dispatchEvent(new CustomEvent('sonora:refresh')), 400); } })
        : el('button', { class: 'btn ghost sm', text: 'Disconnect', onclick: () => { document.dispatchEvent(new CustomEvent('sonora:disconnect')); document.dispatchEvent(new CustomEvent('sonora:refresh')); } })));
  conn.appendChild(stateRow);
  host.appendChild(conn);

  /* --- looks --- */
  host.appendChild(looksPanel());

  /* --- appearance --- */
  const appearance = el('section', { class: 'block' }, sectionHead('Appearance'));

  /* Device tilt. Only offered where the platform can actually report it —
     a switch that does nothing on a desktop is worse than no switch. */
  if (canDeviceTilt()) {
    const tiltBtn = el('button', {
      class: 'switch' + (deviceTiltRunning() ? ' is-on' : ''),
      role: 'switch', 'aria-checked': String(deviceTiltRunning()),
    }, el('span', { class: 'switch-knob' }));
    tiltBtn.addEventListener('click', async () => {
      if (deviceTiltRunning()) {
        stopDeviceTilt();
        try { localStorage.setItem('sonora:tilt', '0'); } catch { /* private mode */ }
      } else {
        // Must happen inside this click: iOS refuses the prompt otherwise.
        const ok = await requestDeviceTilt();
        try { localStorage.setItem('sonora:tilt', ok ? '1' : '0'); } catch { /* private mode */ }
        if (!ok) toast('Your device would not share its orientation');
      }
      const on = deviceTiltRunning();
      tiltBtn.classList.toggle('is-on', on);
      tiltBtn.setAttribute('aria-checked', String(on));
    });

    appearance.appendChild(el('div', { class: 'rows' },
      el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('cube') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: 'Tilt with the device' }),
          el('div', { class: 'settings-note', text: 'Artwork catches the light from however you are holding it, the way a record held up to a window does.' })),
        el('div', { class: 'settings-actions' }, tiltBtn))));
  }

  const accentRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('palette') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Colour from artwork' }),
      el('div', { class: 'settings-note', text: 'Tint the interface with the current album’s colour' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('accent', true)));
  appearance.appendChild(accentRow);

  const backdropRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('sparkle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Motion backdrop' }),
      el('div', { class: 'settings-note', text: 'The 3D depth field behind the interface, drawn on the GPU' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('backdrop', true)));
  appearance.appendChild(backdropRow);
  host.appendChild(appearance);

  /* --- visualiser --- */
  const viz = el('section', { class: 'block' }, sectionHead('Visualiser'));
  viz.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('wave') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Style' }),
      el('div', { class: 'settings-note', text: 'How the spectrum is drawn, everywhere it appears' })),
    el('div', { class: 'settings-actions' }, vizSwitch())));
  viz.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('expand') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Immersive view' }),
      el('div', { class: 'settings-note', text: 'Full-screen artwork and spectrum — press V at any time' })),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', html: ico('play') + '<span>Open</span>',
        onclick: () => document.dispatchEvent(new CustomEvent('sonora:stage')),
      }))));
  host.appendChild(viz);

  /* --- online --- */
  const online = el('section', { class: 'block' }, sectionHead('Online'));
  online.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('globe') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Band overview' }),
      el('div', { class: 'settings-note', text: 'Off by default. When on, an artist name (and nothing else) can be sent to MusicBrainz and Wikipedia — only when you press Analyse.' })),
    el('div', { class: 'settings-actions' }, onlineSwitch())));
  online.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('database') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Cached lookups' }),
      el('div', { class: 'settings-note', id: 'band-cache', text: 'Counting…' })),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear cache',
        onclick: async () => { await band.clearCache(); toast('Online cache cleared'); paintCacheCount(); },
      }))));
  host.appendChild(online);
  paintCacheCount();

  /* --- listening --- */
  const listening = el('section', { class: 'block' }, sectionHead('Listening data'));
  listening.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('circles') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Circle Analysis Center' }),
      el('div', { class: 'settings-note', text: `${fmtTotal(stats.total()) || '0 min'} counted across ${fmtCount(stats.trackedCount(), 'track')} — never leaves this device` })),
    el('div', { class: 'settings-actions' },
      el('button', { class: 'btn ghost sm', text: 'Open', onclick: () => (location.hash = '#/circles') }),
      el('button', {
        class: 'btn ghost sm', text: 'Reset',
        onclick: () => dialog({
          title: 'Reset listening data?',
          body: el('p', { class: 'muted', text: 'Every second counted so far is discarded. Your library and files are untouched.' }),
          actions: [{ label: 'Cancel' }, { label: 'Reset', danger: true, onSelect: async () => { await stats.reset(); toast('Listening data cleared'); document.dispatchEvent(new CustomEvent('sonora:refresh')); } }],
        }),
      }))));
  host.appendChild(listening);

  /* --- storage --- */
  const storage = el('section', { class: 'block' }, sectionHead('Storage'));
  const note = el('div', { class: 'settings-note', text: 'Reading…' });
  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('database') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Cached metadata and artwork' }), note),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear library',
        onclick: () => dialog({
          title: 'Clear the library?',
          body: el('p', { class: 'muted', text: 'Removes all cached metadata, artwork and playlists. Your audio files are never touched.' }),
          actions: [{ label: 'Cancel' }, { label: 'Clear everything', danger: true, onSelect: async () => { await db.wipe(); location.reload(); } }],
        }),
      }))));
  db.usage().then((u) => {
    note.textContent = u
      ? `${fmtBytes(u.used)} used${u.quota ? ` of ${fmtBytes(u.quota)} available` : ''}`
      : `${fmtCount(lib.trackCount(), 'track')} indexed`;
    /* Room runs out quietly. An origin at its ceiling stops being able to write
       — a new import half-lands, a playlist does not save — and nothing about
       that failure names the cause unless somebody says so first. */
    if (u && u.quota && u.used / u.quota > 0.8) {
      note.appendChild(el('span', { class: 'settings-warn',
        text: ` · ${Math.round(100 * u.used / u.quota)}% of what this browser allows` }));
    }
  });

  /*
   * Whether the browser has promised to keep any of it.
   *
   * This is the row that matters most on this page and it is the one that did
   * not exist. Everything Sonora lets you change lives in IndexedDB and nowhere
   * else — playlists, favourites, tag corrections, chosen covers, bound racks,
   * every hour of listening. Without a persistence grant that is *best-effort*
   * storage, which a browser short of room may evict without asking, and there
   * is no server copy to come back from, because there is no server.
   */
  /* D3 and D4: the copy that lives somewhere else.
   *
   * The row above is honest about destroying the overlays and there was no way
   * to take a copy first — which, in an application with no account and no
   * server, means there was no other copy of months of corrections anywhere.
   * Written and read as one JSON file. */
  const backupNote = el('div', { class: 'settings-note',
    text: 'Playlists, favourites, corrections, chosen covers, racks, listening totals and settings. Not the audio.' });
  const withArt = el('button', {
    class: 'switch', role: 'switch', 'aria-checked': 'false',
    title: 'Include the artwork thumbnails. Much larger, and they can be rebuilt from your files in seconds.',
  }, el('span', { class: 'switch-knob' }));
  let artIn = false;
  withArt.addEventListener('click', () => {
    artIn = !artIn;
    withArt.classList.toggle('is-on', artIn);
    withArt.setAttribute('aria-checked', String(artIn));
  });

  const saveBackup = el('button', {
    class: 'btn ghost sm', text: 'Save a backup',
    onclick: async () => {
      saveBackup.disabled = true;
      saveBackup.textContent = 'Collecting…';
      try {
        const doc = await backup.build({ art: artIn });
        const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `sonora-backup-${doc.saved.slice(0, 10)}.json` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast(`Saved ${fmtCount(doc.counts.overlays, 'correction')} · ${fmtCount(doc.counts.playlists, 'playlist')} · ${fmtCount(doc.counts.favourites, 'favourite')}`);
      } finally {
        saveBackup.disabled = false;
        saveBackup.textContent = 'Save a backup';
      }
    },
  });

  const restorePicker = el('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async () => {
      const file = restorePicker.files && restorePicker.files[0];
      restorePicker.value = '';
      if (file) offerBackup(await file.text());
    },
  });
  const restoreBtn = el('button', {
    class: 'btn ghost sm', text: 'Read one back',
    onclick: () => restorePicker.click(),
  });

  /** Shows what merging a backup would do, and merges only if asked. */
  function offerBackup(text) {
    const read = backup.inspect(text);
    if (!read.ok) { toast(read.reason); return; }
    const s = read.summary;
    const lines = [];
    if (s.overlays) lines.push(`${fmtCount(s.overlays, 'correction')}, ${s.matched} of which match tracks you have`);
    if (s.favourites) lines.push(`${fmtCount(s.favourites, 'favourite')}, ${s.favMatched} matched`);
    if (s.playlists) lines.push(`${fmtCount(s.playlists, 'playlist')}, ${s.newPlaylists} new to this library`);
    if (s.art) lines.push(`${fmtCount(s.art, 'cover')}`);

    /* Settings are off by default and stated separately. The common case is a
       fresh browser that has just rescanned the same folder, where what is
       wanted back is the work — and quietly replacing the crossfade, the Look
       and the output device with a six-month-old machine's is a surprise. */
    let bringSettings = false;
    const settingsSwitch = el('button', {
      class: 'switch', role: 'switch', 'aria-checked': 'false',
    }, el('span', { class: 'switch-knob' }));
    settingsSwitch.addEventListener('click', () => {
      bringSettings = !bringSettings;
      settingsSwitch.classList.toggle('is-on', bringSettings);
      settingsSwitch.setAttribute('aria-checked', String(bringSettings));
    });

    const body = el('div', {},
      el('p', { text: read.saved ? `Saved ${read.saved.slice(0, 10)}.` : 'A Sonora backup.' }),
      lines.length
        ? el('ul', { class: 'backup-list' }, lines.map((t) => el('li', { text: t })))
        : el('p', { class: 'muted', text: 'There is nothing in it this library does not already have.' }),
      s.roots.length
        ? el('p', { class: 'muted', text: `It came from: ${s.roots.join(', ')}. Folder permissions cannot be carried between browsers, so you will be asked to point at them again.` })
        : null,
      el('div', { class: 'settings-row' },
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: 'Also bring the settings and the Look' }),
          el('div', { class: 'settings-note', text: 'Off by default: what you usually want back is the work, not another machine\u2019s crossfade.' })),
        el('div', { class: 'settings-actions' }, settingsSwitch)),
      el('p', { class: 'muted', text: 'Nothing is replaced — this merges, and the whole merge is one undo.' }));

    dialog({
      title: 'Read this backup in?',
      body,
      width: 520,
      actions: [
        { label: 'Cancel' },
        { label: 'Merge it in', primary: true, onSelect: async () => {
          const res = await backup.merge(read, { settings: bringSettings });
          if (!res.ok) { toast('That backup could not be read'); return; }
          const d = res.done;
          toast(`Restored ${fmtCount(d.overlays, 'correction')}, ${fmtCount(d.favourites, 'favourite')}, ${fmtCount(d.playlists, 'playlist')}`);
        } },
      ],
    });
  }

  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('file') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Backup' }), backupNote),
    el('div', { class: 'settings-actions' }, withArt, saveBackup, restoreBtn, restorePicker)));

  const keepNote = el('div', { class: 'settings-note', text: 'Checking…' });
  const keepBtn = el('button', { class: 'btn ghost sm', text: 'Ask to keep it', hidden: true });
  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('cube') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Kept when the browser is short of room' }), keepNote),
    el('div', { class: 'settings-actions' }, keepBtn)));

  async function paintKeep() {
    if (!navigator.storage?.persist) {
      keepNote.textContent = 'This browser does not say either way.';
      return;
    }
    const on = await db.persisted();
    keepNote.textContent = on
      ? 'Yes. Your library will not be evicted to make room.'
      : 'Not yet — this browser may clear the library if it runs short of space.';
    keepBtn.hidden = on;
  }
  keepBtn.addEventListener('click', async () => {
    const r = await db.requestPersist();
    // Chromium decides from how the site is used rather than by asking, so a
    // refusal is a "not yet" rather than a no, and saying so is the honest form.
    toast(r.granted ? 'The browser will keep your library'
                    : 'The browser has not granted it yet — it often does once the app has been used a few times');
    paintKeep();
  });
  paintKeep();

  /* Whether the application itself opens without a network.
   *
   * Worth showing rather than leaving implicit: "works offline" is the sort of
   * claim people reasonably want to verify before they get on a plane, and
   * until this row existed there was no way to tell whether the shell had
   * actually been cached or only promised. */
  const offNote = el('div', { class: 'settings-note', text: 'Checking…' });
  const offRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('plug') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Opens without a network' }), offNote),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear app cache',
        onclick: async () => {
          const ok = await offline.clearOffline();
          toast(ok ? 'App cache cleared — reload to fetch a fresh copy' : 'Nothing to clear');
          paintOffline();
        },
      })));
  storage.appendChild(offRow);

  async function paintOffline() {
    const s = offline.status();
    if (!s.supported) {
      offNote.textContent = 'Not available here — this needs to be served over http, not opened as a file.';
      return;
    }
    const c = await offline.cachedBytes();
    if (c && c.files) {
      offNote.textContent = `${fmtCount(c.files, 'file')} cached · ${fmtBytes(c.bytes)}` +
        (s.controlled ? ' · serving from cache' : ' · takes effect on next launch');
    } else {
      offNote.textContent = s.registered
        ? 'Caching the app now…'
        : 'Not cached yet — this happens a few seconds after launch.';
    }
  }
  paintOffline();

  host.appendChild(storage);

  /* What the collection is made of. Bars in the mono stack rather than a pie
     chart: these are counts to be read off, not proportions to be admired, and
     a machine that tells you what it is holding is behaving like an
     instrument. */
  const shape = el('section', { class: 'block' }, sectionHead('What is in here'));
  const paintShape = () => {
    for (const n of [...shape.children].slice(1)) n.remove();
    const c = lib.census();
    if (!c.total) {
      shape.appendChild(el('p', { class: 'muted small', text: 'Nothing indexed yet.' }));
      return;
    }

    const bars = (rows, total, label) => {
      const wrap = el('div', { class: 'census' });
      for (const [k, n] of rows.slice(0, 6)) {
        wrap.appendChild(el('div', { class: 'census-row' },
          el('span', { class: 'census-key', text: label(k) }),
          el('span', { class: 'census-bar' },
            el('i', { style: { width: Math.max(1.5, (n / total) * 100) + '%' } })),
          el('span', { class: 'census-n', text: n.toLocaleString() })));
      }
      return wrap;
    };

    const pct = Math.round((c.lossless / c.total) * 100);
    shape.appendChild(el('p', { class: 'muted small', text:
      `${c.total.toLocaleString()} tracks · ${fmtBytes(c.bytes)} on disk · ${pct}% lossless` }));

    shape.appendChild(el('p', { class: 'label census-head', text: 'Container' }));
    shape.appendChild(bars(c.formats, c.total, (k) => k.toUpperCase()));

    if (c.known.rate) {
      shape.appendChild(el('p', { class: 'label census-head', text: 'Sample rate' }));
      shape.appendChild(bars(c.rates, c.known.rate,
        (k) => (k % 1000 === 0 ? k / 1000 : (k / 1000).toFixed(1)) + ' kHz'));
    }
    if (c.known.depth) {
      shape.appendChild(el('p', { class: 'label census-head', text: 'Bit depth' }));
      shape.appendChild(bars(c.depths, c.known.depth, (k) => k + '-bit'));
    }
    // Said plainly rather than folded into the bars: a library imported before
    // the reader kept stream details is not a library of unknown files.
    if (c.known.rate < c.total) {
      shape.appendChild(el('p', { class: 'muted small', text:
        `${(c.total - c.known.rate).toLocaleString()} tracks were indexed before Sonora recorded stream details. Rescan a folder to fill them in.` }));
    }
  };
  paintShape();
  host.appendChild(shape);

  const keys = el('section', { class: 'block' },
    sectionHead('Keyboard'),
    el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico('keys') }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: 'Shortcuts' }),
        el('div', { class: 'settings-note', text: 'Sonora is meant to be played from the keyboard. Press ? anywhere for the whole list.' })),
      el('div', { class: 'settings-actions' },
        el('button', {
          class: 'btn ghost sm', text: 'Show shortcuts',
          onclick: () => document.dispatchEvent(new CustomEvent('sonora:shortcuts')),
        }))));
  host.appendChild(keys);

  const about = el('section', { class: 'block about' },
    sectionHead('About'),
    el('p', { class: 'muted', text: 'Sonora plays audio files from this computer. Files are read directly by the browser — nothing is uploaded, and the library index lives in local storage on this device.' }),
    el('p', { class: 'muted small', text: 'Every audio container is indexed and tagged — MP3, M4A/AAC, FLAC, Ogg/Opus, WAV, AIFF, WebM/Matroska and the rest. Anything this browser has no decoder for is still catalogued, and says so on its row.' }),
    // The serial: random, generated once, derived from nothing about you.
    el('p', { class: 'muted small mono', text: lib.serial }));
  host.appendChild(about);

  enter([head, folders, imports, overrides, backfill, conn, appearance, viz, online, listening, storage, shape, keys, about], { each: 34, y: 12 });
  offs.push(lib.events.on('roots', paintRoots));
  return () => { while (offs.length) offs.pop()(); };
}

/**
 * The look panel: every visual preference in the app, in one place, drawn
 * from the schema rather than written out.
 *
 * Nothing here knows what any setting *does* — it reads `looks.SCHEMA`, draws
 * the right control for each kind, and writes back. Adding a setting is one
 * line in looks.js and it appears here, correctly grouped, with its hint, its
 * units and its keyboard handling already working.
 */
function looksPanel() {
  const block = el('section', { class: 'block' }, sectionHead('Look'));

  const swatches = el('div', { class: 'look-grid' });
  const paintSwatches = () => {
    const current = looks.currentLook();
    for (const btn of swatches.children) {
      btn.classList.toggle('is-on', btn.dataset.look === current);
    }
  };

  for (const look of looks.LOOKS) {
    // Each card is painted in its own colours, so the choice is visible
    // rather than described.
    const want = { ...looks.defaults(), ...look.patch };
    const btn = el('button', {
      class: 'look-swatch', data: { look: look.id },
      onclick: () => { looks.useLook(look.id); paintAllRows(); paintSwatches(); },
    },
      el('span', { class: 'look-name', text: look.label }),
      el('span', { class: 'look-note', text: look.note }),
      el('span', { class: 'look-bar' }, el('i'), el('i'), el('i')));
    btn.style.setProperty('--sw-a', hueRGB(want.hue, want.chroma, .52));
    btn.style.setProperty('--sw-b', hueRGB(want.hue + want.spread, want.chroma, .60));
    btn.style.setProperty('--sw-c', hueRGB(want.hue + want.spread * 2, want.chroma, .68));
    swatches.appendChild(btn);
  }
  block.appendChild(swatches);

  const rows = [];
  const paintAllRows = () => { for (const r of rows) r(); };

  for (const [group, specs] of looks.groups()) {
    const panel = el('div', { class: 'rack-panel look-group' },
      el('div', { class: 'rack-head' }, el('span', { class: 'label', text: group })));

    for (const spec of specs) {
      const name = spec.label || spec.id;
      let control, sync;

      if (spec.kind === 'range') {
        const val = el('span', { class: 'rack-val' });
        const input = el('input', {
          type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step || 1),
          'aria-label': name,
          oninput: (e) => { looks.set(spec.id, +e.target.value); sync(); paintSwatches(); },
        });
        control = [input, val];
        sync = () => {
          const v = looks.state[spec.id];
          if (document.activeElement !== input) input.value = String(v);
          val.textContent = v + (spec.unit || '');
        };
      } else if (spec.kind === 'toggle') {
        const btn = el('button', {
          class: 'preset',
          onclick: () => { looks.set(spec.id, !looks.state[spec.id]); sync(); paintSwatches(); },
        });
        control = [el('span', {}), btn];
        sync = () => {
          const on = !!looks.state[spec.id];
          btn.textContent = on ? 'On' : 'Off';
          btn.classList.toggle('is-on', on);
        };
      } else {
        const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': name });
        for (const [value, label] of spec.options) {
          seg.appendChild(el('button', {
            class: 'seg', text: label, data: { value },
            onclick: () => { looks.set(spec.id, value); sync(); paintSwatches(); },
          }));
        }
        control = [el('span', {}), seg];
        sync = () => {
          for (const b of seg.children) {
            const on = b.dataset.value === looks.state[spec.id];
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', String(on));
          }
        };
      }

      const row = el('div', { class: 'rack-row look-row' },
        el('span', { class: 'rack-name', text: name, title: spec.hint || name }), ...control);
      panel.appendChild(row);
      rows.push(sync);
      sync();
    }
    block.appendChild(panel);
  }

  block.appendChild(el('div', { class: 'settings-actions look-actions' },
    el('button', {
      class: 'btn ghost sm', text: 'Back to the shipped look',
      onclick: () => { looks.reset(); paintAllRows(); paintSwatches(); toast('Look reset'); },
    })));

  paintSwatches();
  return block;
}

/** The same HSL the look engine uses, for painting the swatches. */
function hueRGB(h, chroma, l) {
  h = ((h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1.4, chroma / 100)) * 0.86 + 0.14;
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `${Math.round((r + m) * 255)} ${Math.round((g + m) * 255)} ${Math.round((b + m) * 255)}`;
}

function connectionNote() {
  if (session.isDisconnected()) return 'Disconnected — nothing reconnects until you turn it back on';
  const st = session.state;
  if (st.phase === 'resumed') return `Reconnected and resumed in ${st.ms} ms`;
  if (st.phase === 'ready') return st.ms ? `Ready in ${st.ms} ms` : 'Ready';
  if (st.phase === 'failed') return 'Last launch could not reach the files';
  return 'Connected';
}

function paintCacheCount() {
  const note = document.getElementById('band-cache');
  if (!note) return;
  db.bandCount().then((n) => {
    note.textContent = n
      ? `${fmtCount(n, 'lookup')} stored on this device, expiring after 30 days`
      : 'Nothing cached yet';
  }).catch(() => { note.textContent = 'Nothing cached yet'; });
}

/** Consent, expressed as a switch: turning it on is the consent. */
function onlineSwitch() {
  const btn = el('button', {
    class: 'switch' + (band.isEnabled() ? ' is-on' : ''),
    role: 'switch', 'aria-checked': String(band.isEnabled()),
    'aria-label': 'Allow online band lookups',
  });
  btn.appendChild(el('span', { class: 'switch-knob' }));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', String(next));
    band.setEnabled(next);
    toast(next ? 'Online lookups enabled' : 'Online lookups disabled');
  });
  return btn;
}

/** Picks the visualiser style every canvas in the app reads from. */
function vizSwitch() {
  const wrap = el('div', { class: 'segmented' });
  let current = 'bars';
  try { const v = localStorage.getItem('sonora:viz'); if (isMode(v)) current = v; } catch { /* private mode */ }
  for (const m of MODES) {
    wrap.appendChild(el('button', {
      class: 'seg' + (current === m.id ? ' is-on' : ''),
      text: m.label,
      onclick: (e) => {
        for (const b of wrap.children) b.classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        try { localStorage.setItem('sonora:viz', m.id); } catch { /* private mode */ }
        document.dispatchEvent(new CustomEvent('sonora:viz-mode', { detail: m.id }));
      },
    }));
  }
  return wrap;
}

function toggleSwitch(name, fallback) {
  const stored = localStorage.getItem('sonora:' + name);
  const on = stored === null ? fallback : stored === '1';
  const btn = el('button', { class: 'switch' + (on ? ' is-on' : ''), role: 'switch', 'aria-checked': String(on) });
  btn.appendChild(el('span', { class: 'switch-knob' }));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', String(next));
    localStorage.setItem('sonora:' + name, next ? '1' : '0');
    document.dispatchEvent(new CustomEvent('sonora:setting', { detail: { name, value: next } }));
  });
  return btn;
}

/* ------------------------------------------------------------------ router */

function notFound(host, message) {
  host.appendChild(emptyState({ icon: 'music', title: message, note: 'It may have been removed from the library.' }));
  return () => {};
}

/* ------------------------------------------------------------------ FILES */

/*
 * The library as it actually sits on the disk, which is not the same thing as
 * the library as music.
 *
 * Two questions live here because they are the same question asked twice: what
 * is actually in these folders, and how much of it is the same thing twice.
 * Both are about files rather than songs, and neither belongs on a page that
 * is trying to be about albums.
 */

/** Builds a nested folder tree out of the flat path on every track. */
function folderTree() {
  const roots = [];
  const byRoot = new Map();

  for (const root of lib.state.roots) {
    const node = { name: root.name, path: '', kind: 'root', children: new Map(), tracks: [] };
    byRoot.set(root.id, node);
    roots.push(node);
  }
  // Anything whose root has gone is still on the disk somewhere; it gets a
  // home rather than vanishing from a view whose whole job is to show files.
  const orphan = { name: 'Elsewhere', path: '', kind: 'root', children: new Map(), tracks: [] };

  for (const t of lib.allTracks()) {
    let node = byRoot.get(t.rootId) || orphan;
    const parts = String(t.path || t.name || '').split('/').filter(Boolean);
    // The last part is the file itself.
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = node.children.get(seg);
      if (!next) {
        next = { name: seg, path: node.path ? node.path + '/' + seg : seg,
                 kind: 'dir', children: new Map(), tracks: [] };
        node.children.set(seg, next);
      }
      node = next;
    }
    node.tracks.push(t);
  }

  if (orphan.tracks.length || orphan.children.size) roots.push(orphan);
  return roots;
}

/** Every track at or below a node, in folder order. */
function tracksUnder(node) {
  const out = node.tracks.slice().sort((a, b) => cmpText(a.name, b.name));
  for (const child of [...node.children.values()].sort((a, b) => cmpText(a.name, b.name))) {
    out.push(...tracksUnder(child));
  }
  return out;
}

/**
 * A short, strong fingerprint of a file's actual contents.
 *
 * The head and the tail rather than the whole thing: a hash of a 40 MB FLAC is
 * 40 MB of reading, and doing that across a library to answer a question
 * nobody asked yet is not a reasonable thing to do to somebody's disk. The
 * first and last 64 KB plus the exact byte length is enough — two audio files
 * that agree on all three and are not the same file do not occur outside a
 * deliberate attempt to make one.
 */
async function contentKey(track) {
  const file = await lib.fileFor(track.id);
  if (!file) return null;
  const CHUNK = 65536;
  const size = file.size;
  const parts = [file.slice(0, Math.min(CHUNK, size))];
  if (size > CHUNK * 2) parts.push(file.slice(size - CHUNK, size));
  const bufs = await Promise.all(parts.map((p) => p.arrayBuffer()));
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const b of bufs) { joined.set(new Uint8Array(b), at); at += b.byteLength; }
  try {
    const digest = await crypto.subtle.digest('SHA-256', joined);
    return size + ':' + [...new Uint8Array(digest).slice(0, 12)]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Copies of the same thing.
 *
 * Two passes, because "duplicate" means two different things and conflating
 * them produces a list nobody trusts.
 *
 * The first is a *file* duplicate, and it is checked rather than guessed.
 * Matching byte length and duration is only the cheap filter that decides what
 * is worth reading; the claim itself is made on a hash of the bytes. That
 * distinction is not pedantry — an uncompressed WAV of a given length is
 * *always* the same size, so on a library of WAVs the cheap filter alone
 * reports every track of the same duration as a copy of every other. It did
 * exactly that here before this was written.
 *
 * The second is the same *recording* in two files: the artist and title match
 * once punctuation and case are taken out, and the lengths agree to within two
 * seconds. That catches the FLAC and the MP3 of the same song, and the album
 * track that is also on a greatest-hits — which is a real duplicate to some
 * people and not to others, so it is labelled rather than assumed.
 *
 * A group is only reported once, under the stronger reason.
 */
async function findDuplicates() {
  const all = lib.allTracks();
  const groups = [];
  const claimed = new Set();

  const bySize = new Map();
  for (const t of all) {
    if (!t.size || !t.duration) continue;
    const key = t.size + ':' + Math.round(t.duration);
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(t);
  }
  for (const list of bySize.values()) {
    if (list.length < 2) continue;
    // Same size and length: worth reading. Now find out whether they really
    // are the same bytes.
    const byContent = new Map();
    for (const t of list) {
      const key = await contentKey(t);
      // Unreadable, or no crypto: it cannot be claimed as identical, so it
      // falls through to the tag-based pass like anything else.
      if (!key) continue;
      if (!byContent.has(key)) byContent.set(key, []);
      byContent.get(key).push(t);
    }
    for (const same of byContent.values()) {
      if (same.length < 2) continue;
      groups.push({ kind: 'file', reason: 'Identical files', tracks: same });
      for (const t of same) claimed.add(t.id);
    }
  }

  const byWork = new Map();
  for (const t of all) {
    if (claimed.has(t.id) || !t.duration) continue;
    // Bucketed to the nearest two seconds, and each track also checked against
    // the neighbouring bucket, so a pair straddling a boundary still meets.
    const stem = norm(t.artist) + '|' + norm(t.title);
    const bucket = Math.round(t.duration / 2);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const key = stem + '|' + b;
      if (!byWork.has(key)) byWork.set(key, new Set());
      byWork.get(key).add(t);
    }
  }
  const seenPair = new Set();
  for (const set of byWork.values()) {
    if (set.size < 2) continue;
    const list = [...set].sort((a, b) => cmpText(a.name, b.name));
    // The bucket overlap means the same group is built three times over.
    const sig = list.map((t) => t.id).join(' ');
    if (seenPair.has(sig)) continue;
    seenPair.add(sig);
    if (list.some((t) => claimed.has(t.id))) continue;
    groups.push({ kind: 'work', reason: 'Same recording', tracks: list });
    for (const t of list) claimed.add(t.id);
  }

  // Biggest waste first: that is the order somebody clearing space wants.
  const waste = (g) => g.tracks.slice(1).reduce((s, t) => s + (t.size || 0), 0);
  groups.sort((a, b) => waste(b) - waste(a));
  return groups;
}

function viewFiles(host) {
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Files' }),
    el('p', { class: 'page-sub', text: 'The folders on disk, and what is in them twice' }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Files');

  let mode = 'folders';
  const bar = el('div', { class: 'toolbar' });
  const seg = el('div', { class: 'segmented', role: 'tablist' });
  for (const [id, label] of [['folders', 'Folders'], ['dupes', 'Duplicates']]) {
    seg.appendChild(el('button', {
      class: 'seg' + (id === mode ? ' is-on' : ''), role: 'tab', text: label,
      onclick: () => {
        mode = id;
        for (const b of seg.children) b.classList.toggle('is-on', b.textContent === label);
        paint();
      },
    }));
  }
  bar.appendChild(seg);
  host.appendChild(bar);

  const body = el('div', { class: 'files-body' });
  host.appendChild(body);

  /* ---- folders ---- */

  const open = new Set();          // paths currently expanded

  function folderRow(node, depth) {
    const under = tracksUnder(node);
    const isOpen = open.has(node.kind + ':' + node.name + ':' + node.path);
    const key = node.kind + ':' + node.name + ':' + node.path;

    const row = el('div', { class: 'file-row' + (isOpen ? ' is-open' : ''), style: `--depth:${depth}` },
      el('button', { class: 'file-twist', 'aria-expanded': String(isOpen),
        'aria-label': isOpen ? 'Collapse' : 'Expand', html: ico('chev-right') }),
      el('span', { class: 'file-ico', html: ico('folder') }),
      el('span', { class: 'file-name', text: node.name }),
      el('span', { class: 'file-count', text: fmtCount(under.length, 'track', 'tracks') }),
      el('button', { class: 'icon-btn ghost sm', title: 'Play this folder', 'aria-label': `Play ${node.name}`,
        html: ico('play'), onclick: (e) => {
          e.stopPropagation();
          if (under.length) playAll(under, 0, { type: 'folder', label: node.name });
        } }));

    row.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn') && !e.target.closest('.file-twist')) return;
      if (open.has(key)) open.delete(key); else open.add(key);
      paint();
    });
    return row;
  }

  function paintFolders() {
    const tree = folderTree();
    if (!tree.length) {
      body.appendChild(emptyState({ icon: 'folder', title: 'No folders yet',
        note: 'Add music and the folders it came from will appear here.' }));
      return;
    }

    const walk = (node, depth) => {
      body.appendChild(folderRow(node, depth));
      const key = node.kind + ':' + node.name + ':' + node.path;
      if (!open.has(key)) return;
      for (const child of [...node.children.values()].sort((a, b) => cmpText(a.name, b.name))) {
        walk(child, depth + 1);
      }
      for (const t of node.tracks.slice().sort((a, b) => cmpText(a.name, b.name))) {
        body.appendChild(el('div', { class: 'file-row is-track', style: `--depth:${depth + 1}` },
          el('span', { class: 'file-twist' }),
          el('span', { class: 'file-ico', html: ico('music') }),
          el('span', { class: 'file-name', text: t.name }),
          el('span', { class: 'file-count', text: t.duration ? fmtTime(t.duration) : '--:--' }),
          el('button', { class: 'icon-btn ghost sm', title: 'Play', 'aria-label': `Play ${t.title}`,
            html: ico('play'), onclick: () => player.playTracks([t], 0, { type: 'folder', label: node.name }) })));
      }
    };

    // One root opens itself: a tree that starts entirely shut is a page of
    // nothing, and most people have one folder anyway.
    if (!open.size && tree.length) open.add(tree[0].kind + ':' + tree[0].name + ':' + tree[0].path);
    for (const root of tree) walk(root, 0);
  }

  /* ---- duplicates ---- */

  /* One token for the whole page, bumped by *any* repaint.
   *
   * It used to be bumped only by the duplicate scan itself, which meant
   * switching to Folders mid-scan invalidated nothing: the body was still
   * connected and the token still matched, so a scan finishing afterwards
   * appended its groups underneath the folder tree. A guard has to be owned by
   * whatever can invalidate it, and that is `paint`. */
  let paintToken = 0;

  async function paintDupes() {
    const token = paintToken;
    // Reading the head and tail of every candidate takes a moment on a real
    // library, and a page that sits blank while it happens looks broken.
    const busy = el('p', { class: 'muted dupe-summary', text: 'Comparing files…' });
    body.appendChild(busy);
    const groups = await findDuplicates();
    if (token !== paintToken || !body.isConnected) return;
    busy.remove();
    if (!groups.length) {
      body.appendChild(emptyState({ icon: 'database', title: 'Nothing duplicated',
        note: 'No two files in the library look like the same recording.' }));
      return;
    }

    const wasted = groups.reduce((s, g) => s + g.tracks.slice(1).reduce((n, t) => n + (t.size || 0), 0), 0);
    body.appendChild(el('p', { class: 'muted dupe-summary',
      text: `${fmtCount(groups.length, 'group', 'groups')} · about ${fmtBytes(wasted)} held twice` }));

    for (const g of groups) {
      const box = el('section', { class: 'dupe-group' });
      box.appendChild(el('div', { class: 'dupe-head' },
        el('span', { class: 'dupe-reason' + (g.kind === 'file' ? ' is-hard' : ''), text: g.reason }),
        el('span', { class: 'dupe-title', text: `${g.tracks[0].artist} — ${g.tracks[0].title}` }),
        el('span', { class: 'dupe-size', text: fmtBytes(g.tracks.slice(1).reduce((n, t) => n + (t.size || 0), 0)) })));

      for (const t of g.tracks) {
        box.appendChild(el('div', { class: 'dupe-row' },
          el('span', { class: 'dupe-path', text: (lib.state.roots.find((r) => r.id === t.rootId)?.name || '?') + ' / ' + (t.path || t.name) }),
          el('span', { class: 'dupe-spec', text: [formatName(t.name || ''), t.bitrate ? t.bitrate + ' kbps' : null,
            t.duration ? fmtTime(t.duration) : null, fmtBytes(t.size || 0)].filter(Boolean).join(' · ') }),
          el('button', { class: 'icon-btn ghost sm', title: 'Play', 'aria-label': `Play ${t.title}`,
            html: ico('play'), onclick: () => player.playTracks([t], 0, { type: 'dupes', label: 'Duplicates' }) }),
          el('button', { class: 'icon-btn ghost sm', title: 'Show in library', 'aria-label': 'Show in library',
            html: ico('album'), onclick: () => { location.hash = '#/album/' + t.albumKey; } })));
      }
      body.appendChild(box);
    }

    /* Deliberately no delete button.
     *
     * Sonora reads the disk and does not write to it — nothing in this app has
     * ever removed one of the listener's files and this page is not where that
     * should start. Finding the copies is the hard part and is the part worth
     * doing; deciding which to keep, and doing it, belongs to whoever owns the
     * files. */
    body.appendChild(el('p', { class: 'muted dupe-note',
      text: 'Sonora only reads your files — nothing here deletes anything. Use these paths in your file manager.' }));
  }

  function paint() {
    body.textContent = '';
    paintToken++;
    if (mode === 'folders') paintFolders(); else paintDupes();
  }

  paint();
  enter([head, bar], { y: 10 });
  const off = lib.events.on('change', paint);
  return () => off();
}

/* ------------------------------------------------------------------ L4
 *
 * Genres, as a place. A grid weighted by how much of the library each one
 * holds, because a genre with four tracks and a genre with four hundred are
 * not the same kind of thing and a uniform grid says they are.
 */
function viewGenres(host) {
  const all = lib.genres();
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Genres' }),
    el('p', { class: 'page-sub', text: fmtCount(all.length, 'genre') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Genres');

  if (!all.length) {
    host.appendChild(emptyState({
      icon: 'circles', title: 'No genres yet',
      note: 'Genre is read from the files. Nothing in this library carries one.',
    }));
    return () => {};
  }

  const top = all[0].tracks.length || 1;
  const wall = el('div', { class: 'genre-wall' });
  for (const g of all) {
    /* Weight by the fourth root of the share, not by the share: a library
       where one genre is nine tenths of everything would otherwise be one
       enormous tile and forty slivers. This keeps the biggest about three
       times the smallest, which reads as a ranking without becoming a
       treemap. */
    const w = Math.pow(g.tracks.length / top, 0.25);
    const tile = el('a', {
      class: 'genre-tile', href: '#/genre/' + encodeURIComponent(g.key),
      style: `--w:${w.toFixed(3)}`,
    },
      el('b', { class: 'genre-name', text: g.label }),
      el('span', { class: 'genre-count', text: `${fmtCount(g.tracks.length, 'track')} · ${fmtCount(g.albums.size, 'album')}` }));
    wall.appendChild(tile);
  }
  host.appendChild(wall);
  enter(wall.children, { each: 14, y: 10 });
  return () => {};
}

/** One genre: everything filed under it. */
function viewGenre(host, key) {
  const g = lib.genreOf(decodeURIComponent(key || ''));
  if (!g) return notFound(host, 'No such genre');

  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow' }, el('a', { class: 'hero-link', href: '#/genres', text: 'Genres' })),
    el('h1', { class: 'page-title', text: g.label }),
    el('p', { class: 'page-sub', text: `${fmtCount(g.tracks.length, 'track')} · ${fmtCount(g.albums.size, 'album')} · ${fmtTotal(g.duration)}` }));
  host.appendChild(head);

  host.appendChild(el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn primary', html: ico('play') + '<span>Play</span>',
      onclick: () => playAll(g.tracks, 0, { type: 'genre', key: g.key, label: g.label }),
    }),
    el('button', {
      class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>',
      onclick: () => playAll(g.tracks, Math.floor(Math.random() * g.tracks.length),
        { type: 'genre', key: g.key, label: g.label }),
    })));

  return trackTable(host, () => g.tracks, { origin: { type: 'genre', key: g.key, label: g.label } });
}

/* ------------------------------------------------------------------ L9
 *
 * Everything that needs a human.
 *
 * Six findings the application already had and kept in six places. Each one is
 * a count, the list behind it and one thing to do about it — which is the only
 * shape that makes a page like this worth opening twice.
 */
function viewAttention(host) {
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Needs attention' }),
    el('p', { class: 'page-sub', id: 'attn-sub', text: 'Looking…' }));
  host.appendChild(head);

  const body = el('div', { class: 'attn' });
  host.appendChild(body);

  const paint = () => {
    const a = lib.attention();
    body.textContent = '';

    const items = [
      {
        key: 'untagged', icon: 'info',
        title: 'Nothing in the file',
        note: 'Artist and album came from the folder name. These are the ones that make a library look wrong.',
        rows: a.untagged,
        act: (rows) => openEdit(rows),
        actLabel: 'Correct them',
      },
      {
        key: 'noart', icon: 'image',
        title: 'No cover',
        note: 'No artwork in the files and none chosen. Drop a picture on the record to set one.',
        rows: a.noArt,
        albums: true,
      },
      {
        key: 'dupes', icon: 'grip',
        title: 'Possible duplicates',
        note: 'Same artist, same title, same length — usually one file at two bitrates.',
        groups: a.duplicates,
      },
      {
        key: 'undecodable', icon: 'plug',
        title: 'This browser cannot play them',
        note: 'Catalogued and searchable, but no decoder here. Another browser may manage them.',
        rows: a.undecodable,
      },
      {
        key: 'suspect', icon: 'wave',
        title: 'Look like transcodes',
        note: 'A lossless container with a lossy encoder\u2019s shelf in the spectrum. Measured, not guessed — only tracks you have played are tested.',
        rows: a.suspect,
      },
      {
        key: 'guessed', icon: 'edit',
        title: 'Partly guessed',
        note: 'Some fields came from the folder tree rather than from the file.',
        rows: a.guessed,
        act: (rows) => openEdit(rows),
        actLabel: 'Correct them',
      },
    ];

    let total = 0;
    for (const item of items) {
      const n = item.groups ? item.groups.length : item.rows.length;
      total += n;
      if (!n) continue;

      const list = el('div', { class: 'attn-body', hidden: true });
      const card = el('section', { class: 'attn-card' },
        el('button', {
          class: 'attn-head', 'aria-expanded': 'false',
          onclick: (e) => {
            const open = list.hidden;
            list.hidden = !open;
            e.currentTarget.setAttribute('aria-expanded', String(open));
            if (open && !list.firstChild) fill(list, item);
          },
        },
          el('span', { class: 'attn-ico', html: ico(item.icon) }),
          el('span', { class: 'attn-text' },
            el('b', { text: item.title }),
            el('span', { class: 'attn-note', text: item.note })),
          el('span', { class: 'attn-count', text: String(n) })),
        list);

      if (item.act) {
        card.querySelector('.attn-head').after(el('div', { class: 'attn-actions' },
          el('button', {
            class: 'btn ghost sm', text: item.actLabel,
            onclick: () => item.act(item.rows),
          })));
      }
      body.appendChild(card);
    }

    host.querySelector('#attn-sub').textContent = total
      ? `${fmtCount(total, 'thing')} worth a look`
      : 'Nothing needs you. The library is as tidy as the files allow.';
    if (!total) {
      body.appendChild(emptyState({
        icon: 'star', title: 'All clear',
        note: 'Untagged files, missing covers, duplicates and anything this browser cannot play would be listed here.',
      }));
    }
  };

  /** Fills a card's list the first time it is opened, not before. */
  const fill = (list, item) => {
    if (item.albums) {
      const grid = el('div', { class: 'attn-albums' });
      for (const al of item.rows.slice(0, 60)) {
        grid.appendChild(el('a', { class: 'attn-album', href: '#/album/' + al.key },
          el('b', { text: al.title }), el('span', { text: al.artist })));
      }
      list.appendChild(grid);
      if (item.rows.length > 60) list.appendChild(el('p', { class: 'muted', text: `and ${item.rows.length - 60} more` }));
      return;
    }
    if (item.groups) {
      for (const group of item.groups.slice(0, 40)) {
        const g = el('div', { class: 'attn-group' },
          el('b', { text: `${group[0].title} — ${group[0].artist}` }));
        for (const t of group) {
          g.appendChild(el('div', { class: 'attn-file' },
            el('span', { class: 'attn-path', text: t.path || t.name }),
            el('span', { class: 'attn-meta', text: [formatName(t.name || ''), t.bitrate ? t.bitrate + ' kbps' : '', fmtBytes(t.size || 0)].filter(Boolean).join(' · ') })));
        }
        list.appendChild(g);
      }
      if (item.groups.length > 40) list.appendChild(el('p', { class: 'muted', text: `and ${item.groups.length - 40} more` }));
      return;
    }
    const rows = item.rows.slice(0, 200);
    const table = el('div', { class: 'plain-list' });
    const factory = trackRowFactory({
      columns: ['index', 'title', 'album', 'duration'],
      onPlay: (i) => playAll(rows, i, { type: 'attention', label: item.title }),
      onMenu: (i, anchor, event) => menu(trackMenu([rows[i]]), { anchor, event }),
    });
    rows.forEach((t, i) => {
      const row = factory.create();
      row.dataset.index = i;
      row.classList.add('static-row');
      factory.render(row, t, i);
      table.appendChild(row);
    });
    list.appendChild(table);
    if (item.rows.length > rows.length) {
      list.appendChild(el('p', { class: 'muted', text: `and ${item.rows.length - rows.length} more` }));
    }
  };

  /** The existing edit dialog, against the whole finding. */
  const openEdit = (rows) => {
    if (!rows.length) return;
    editDialog(rows.slice(0, 500));
  };

  /* L11: the one systematic mistake.
   *
   * Every library has one — "feat." against "ft.", a name misspelled the same
   * way across three albums — and one-at-a-time correction cannot reach it.
   * It lives here because this is the page somebody opens when their library
   * is wrong, and because it belongs beside the findings rather than behind a
   * menu on one track. */
  host.appendChild(el('div', { class: 'toolbar attn-tools' },
    el('button', {
      class: 'btn ghost', html: ico('edit') + '<span>Find and replace…</span>',
      onclick: () => replaceDialog(),
    })));

  paint();
  const off = lib.events.on('change', paint);
  return () => off();
}

/** Find and replace across one field, previewed before anything is written. */
function replaceDialog() {
  const fields = lib.replaceableFields();
  const pick = el('select', { class: 'settings-select', 'aria-label': 'Field' });
  for (const [id, label] of fields) pick.appendChild(el('option', { value: id, text: label }));
  const findIn = el('input', { class: 'input', placeholder: 'feat.', 'aria-label': 'Find' });
  const withIn = el('input', { class: 'input', placeholder: 'ft.', 'aria-label': 'Replace with' });

  let matchCase = false;
  let wholeOnly = false;
  const flag = (label, hint, get, set) => {
    const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': 'false' },
      el('span', { class: 'switch-knob' }));
    b.addEventListener('click', () => {
      set(!get());
      b.classList.toggle('is-on', get());
      b.setAttribute('aria-checked', String(get()));
      preview();
    });
    return el('div', { class: 'settings-row' },
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: label }),
        el('div', { class: 'settings-note', text: hint })),
      el('div', { class: 'settings-actions' }, b));
  };

  const out = el('div', { class: 'replace-out' });
  let changes = [];

  const preview = () => {
    const find = findIn.value;
    changes = find
      ? lib.findReplace(pick.value, find, withIn.value, { caseSensitive: matchCase, whole: wholeOnly })
      : [];
    out.textContent = '';
    if (!find) {
      out.appendChild(el('p', { class: 'muted', text: 'Type something to find.' }));
      return;
    }
    if (!changes.length) {
      out.appendChild(el('p', { class: 'muted', text: 'Nothing matches.' }));
      return;
    }
    out.appendChild(el('p', { class: 'replace-count',
      text: `${fmtCount(changes.length, 'track')} would change` }));
    const list = el('ul', { class: 'replace-list' });
    for (const c of changes.slice(0, 40)) {
      list.appendChild(el('li', {},
        el('span', { class: 'replace-from', text: c.from }),
        el('span', { class: 'replace-arrow', text: '→' }),
        el('span', { class: 'replace-to', text: c.to })));
    }
    out.appendChild(list);
    if (changes.length > 40) out.appendChild(el('p', { class: 'muted', text: `and ${changes.length - 40} more` }));
  };

  findIn.addEventListener('input', preview);
  withIn.addEventListener('input', preview);
  pick.addEventListener('change', preview);

  const body = el('div', { class: 'replace-form' },
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'In' }), pick),
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'Find' }), findIn),
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'Replace with' }), withIn),
    flag('Match case', 'Off, “ft.” also finds “FT.”', () => matchCase, (v) => { matchCase = v; }),
    flag('The whole field only', 'On, “Various” changes a field that says exactly that and leaves “Various Artists” alone', () => wholeOnly, (v) => { wholeOnly = v; }),
    out,
    el('p', { class: 'edit-note', text: 'Saved in Sonora only — your files are never modified. The whole run is one undo.' }));

  preview();

  dialog({
    title: 'Find and replace',
    body,
    width: 560,
    actions: [
      { label: 'Cancel' },
      { label: 'Replace', primary: true, onSelect: async () => {
        if (!changes.length) { toast('Nothing to replace'); return; }
        const n = await lib.applyReplace(pick.value, changes);
        toast(n ? `Changed ${fmtCount(n, 'track')}` : 'Nothing changed');
      } },
    ],
  });
}

const ROUTES = {
  home: viewHome,
  attention: viewAttention,
  genres: viewGenres,
  genre: viewGenre,
  files: viewFiles,
  songs: viewSongs,
  albums: viewAlbums,
  album: viewAlbum,
  artists: viewArtists,
  artist: viewArtist,
  favourites: viewFavourites,
  recent: viewRecent,
  playlists: viewPlaylists,
  playlist: viewPlaylist,
  search: viewSearch,
  circles: viewCircles,
  sound: viewSound,
  settings: viewSettings,
};

export function renderView(host, route) {
  const key = route.name + '/' + route.arg;
  freshRoute = key !== lastRouteKey;
  lastRouteKey = key;

  const fn = ROUTES[route.name] || viewHome;
  return fn(host, route.arg) || (() => {});
}
