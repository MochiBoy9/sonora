/* views/shared.js — the pieces every route is built from.
 *
 * Track tables, sort controls, the A–Z rail, album and artist cards, the
 * shelf strip, and the two or three helpers that would otherwise be copied
 * into a dozen files. Nothing here is a route; everything here is used by
 * more than one.
 */

import * as rack from '../audio.js';
import * as lib from '../library.js';
import * as looks from '../looks.js';
import { countTo, scramble, tilt3d } from '../motion.js';
import * as player from '../player.js';
import { Selection, emptyState, menu, paintArt, sectionHead, sleeve, toast, trackMenu, trackRowFactory } from '../ui.js';
import { el, fmtCount, ico, norm } from '../util.js';
import { VirtualList } from '../virtual.js';
import * as drag from '../drag.js';
import { viewHome } from './home.js';

const ROW_H = 56;

/* ------------------------------------------------------------------ helpers */

/**
 * Views are rebuilt whenever the library changes underneath them, which during
 * an import is several times a second. Entrance effects must not restart on
 * those repaints — a title that keeps dissolving back into noise reads as a
 * fault — so they are gated on the route having actually changed.
 */
let freshRoute = true;

/** Told by the router, which is the only thing that knows a route changed. */
export const setFresh = (on) => { freshRoute = !!on; };

/** Resolves a heading out of noise, once per arrival. */
export function decode(node, text, opts) {
  if (!node) return;
  if (!freshRoute) { node.textContent = text; return; }
  scramble(node, text, opts);
}

/** Rolls a number up, once per arrival. */
export function readout(node, value, opts) {
  if (!node) return;
  if (!freshRoute) { node.textContent = value.toLocaleString(); return; }
  countTo(node, value, opts);
}

export const albumOf = (key) => lib.state.albumBy.get(key);
export const artistOf = (key) => lib.state.artistBy.get(key);

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

export function playAll(tracks, index = 0, origin) {
  if (!tracks.length) return;
  player.playTracks(tracks, index, origin);
}

export function shuffleAll(tracks, origin) {
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

export function trackTable(host, getTracks, { origin, columns, onRemove, removeLabel, sortKey } = {}) {
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

export function columnHeader(columns, sortState, onSort) {
  const head = el('div', { class: 'trow thead' });
  let html = '';
  if (columns.includes('index')) html += '<div class="trow-index">#</div>';
  html += '<div class="trow-main"><button class="sortable" data-sort="title">Title</button></div>';
  if (columns.includes('album')) html += '<div class="trow-album"><button class="sortable" data-sort="album">Album</button></div>';
  if (columns.includes('dr')) html += '<div class="trow-dr"><button class="sortable" data-sort="dr" title="Dynamic range">DR</button></div>';
  if (columns.includes('plays')) html += '<div class="trow-plays"><button class="sortable" data-sort="plays" title="How many times you have played it">Plays</button></div>';
  if (columns.includes('played')) html += '<div class="trow-played"><button class="sortable" data-sort="played" title="When you last played it">Last</button></div>';
  if (columns.includes('rating')) html += '<div class="trow-rating"><button class="sortable" data-sort="rating" title="What you made of it">Rating</button></div>';
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
export function sortControl({ store, keys, fallback, onChange }) {
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
export function letterOf(v) {
  const c = norm(v).trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

export function letterRail({ getItems, keyOf, onJump }) {
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
  const card = el('article', { class: 'card', tabindex: '0', role: 'button', draggable: 'true' });
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

  /* C3: a record can be picked up off the wall. It carries its tracks in the
     order the album is in, which is the order somebody dragging a record
     plainly means. */
  card.addEventListener('dragstart', (e) => {
    const al = albumOf(card.dataset.key);
    if (!al || !drag.startAlbumDrag(e, [al.key], `“${al.title}”`)) { e.preventDefault(); return; }
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => { card.classList.remove('is-dragging'); drag.endDrag(); });

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
export const thicknessOf = (album) =>
  Math.max(0.45, Math.min(1.9, Math.sqrt((album.tracks.length || 1) / 12)));

export function renderAlbumCard(card, album) {
  card.dataset.key = album.key;
  /* R9: how played this record is, 0..1, for the stylesheet to wear it in.
   *
   * A logarithm, not a ratio: the difference between never and twice is the
   * interesting one, and between three hundred and four hundred there is
   * nothing to see. `log(1 + plays) / log(1 + 120)` reaches full wear at about
   * a hundred and twenty plays, which is a record somebody has genuinely
   * lived with, and is already halfway there at eleven. */
  const plays = album.plays || 0;
  card.style.setProperty('--played', plays ? Math.min(1, Math.log1p(plays) / Math.log1p(120)).toFixed(3) : '0');
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

export function artistCard(artist) {
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

export function renderArtistCard(card, artist) {
  card.dataset.key = artist.key;
  const first = artist.albumList?.[0];
  paintArt(card.querySelector('.art-img'), first ? first.key : artist.key);
  card.querySelector('.card-title').textContent = artist.name;
  card.querySelector('.card-sub').textContent =
    `${fmtCount(artist.albumList?.length || 0, 'album')} · ${fmtCount(artist.tracks.length, 'track')}`;
}

/** Horizontal, non-virtualised strip used on Home. */
export function shelf(title, items, makeCard, { seeAll } = {}) {
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
export function soundBloom() {
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

export function notFound(host, message) {
  host.appendChild(emptyState({ icon: 'music', title: message, note: 'It may have been removed from the library.' }));
  return () => {};
}
