/* views.js — every route in the app.
 *
 * A view is a function that fills the scroll host and returns a teardown.
 * Long lists go through the virtualiser; short ones (an album's tracks) are
 * rendered directly, because 12 nodes are cheaper than the machinery.
 */

import { el, ico, fmtTime, fmtTotal, fmtCount, fmtBytes, cmpText, formatName, norm } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import * as db from './db.js';
import { VirtualList, VirtualGrid } from './virtual.js';
import {
  artBox, sleeve, paintArt, trackRowFactory, trackMenu, menu, toast, dialog, promptDialog, rulesDialog, Selection,
  sectionHead, emptyState, playFab, placeholderStyle,
} from './ui.js';
import { enter, reveal, scramble, countTo, tilt3d, canDeviceTilt, deviceTiltRunning, requestDeviceTilt, stopDeviceTilt, startDeviceTilt } from './motion.js';
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

function trackTable(host, getTracks, { origin, columns, onRemove, removeLabel } = {}) {
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
    }
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
  const columns = ['index', 'art', 'title', 'album', 'dr', 'duration'];
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

  const header = columnHeader(columns, songSort, () => table.update());
  host.appendChild(header);

  const table = trackTable(host, get, { origin: { type: 'all', label: 'All songs' }, columns });
  enter([head, bar], { y: 10 });

  const off = lib.events.on('change', () => table.update());
  return () => { off(); table.destroy(); };
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
  host.appendChild(bar);

  const slot = el('div', { class: 'album-slot' });
  host.appendChild(slot);

  let teardown = () => {};
  function setMode(next) {
    if (next === mode && slot.firstChild) return;
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
    teardown = mode === 'crate' ? mountCrate(slot)
             : mode === 'shelf' ? mountShelf(slot)
             : mode === 'floor' ? mountFloor(slot, host)
             : mountGrid(slot);
  }

  function mountGrid(into) {
    const grid = new VirtualGrid({
      viewport: host, minCell: 168, gap: 22, aspect: 1, footer: 64,
      create: () => albumCard(null),
      render: (node, album) => renderAlbumCard(node, album),
    });
    grid.setItems(lib.state.albums);
    const off = lib.events.on('change', () => grid.setItems(lib.state.albums));
    const offArt = lib.events.on('art', () => grid.refresh());
    void into;
    return () => { off(); offArt(); grid.destroy(); };
  }

  setMode(mode);
  enter([head, bar], { y: 10 });
  return () => { try { teardown(); } catch (err) { console.warn(err); } };
}

const ALBUM_VIEW = 'sonora:albumview';

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
function mountShelf(host) {
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
  let total = 0;
  const live = new Map();    // album key -> element, for what is on screen now

  function measure() {
    albums = lib.state.albums;
    offsets = new Array(albums.length);
    let x = 0;
    for (let i = 0; i < albums.length; i++) { offsets[i] = x; x += widthOf(albums[i]); }
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
    before.style.width = total + 'px';
  }

  function rebuild() {
    for (const node of live.values()) node.remove();
    live.clear();
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
  const PER_ROW = 4;                  // albums across
  const ROW_DEPTH = 210;              // px of Z between rows
  const FAR = 6;                      // rows past which nothing recedes further
  const NEAR_ROWS = 3;                // rows that still get a readable title

  const stage = el('div', { class: 'floor', 'aria-label': 'Albums on the floor' });
  const camera = el('div', { class: 'floor-camera' });
  stage.appendChild(camera);

  let rowCount = 0;
  let items = [];

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
    const row = el('div', { class: 'floor-row' });
    for (const album of items.slice(r * PER_ROW, r * PER_ROW + PER_ROW)) {
      const card = el('a', {
        class: 'floor-card', href: '#/album/' + album.key,
        'aria-label': `${album.title} by ${album.artist}`,
      },
        el('span', { class: 'floor-art', style: { background: placeholderStyle(album.key) } },
          el('img', { class: 'art-img', alt: '', decoding: 'async', loading: 'lazy' })),
        el('span', { class: 'floor-text' },
          el('b', { text: album.title }),
          el('span', { text: album.artist })));
      paintArt(card.querySelector('.art-img'), album.key);
      row.appendChild(card);
    }
    camera.appendChild(row);
    liveRows.set(r, row);
    return row;
  }

  function build() {
    items = lib.state.albums;
    camera.textContent = '';
    liveRows.clear();
    rowCount = Math.ceil(items.length / PER_ROW);
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

    // Which rows the camera can see: one behind, and as far ahead as the far
    // plane plus a little. Everything outside this does not exist.
    const first = Math.max(0, Math.ceil(advance - 1.2));
    const last = Math.min(rowCount - 1, Math.floor(advance + FAR + 3));

    for (const [i, row] of liveRows) {
      if (i < first || i > last) { row.remove(); liveRows.delete(i); }
    }

    for (let i = first; i <= last; i++) {
      const row = liveRows.get(i) || buildRow(i);
      const d = i - advance;                       // rows ahead of the camera
      // Bounded: past the far plane rows stop receding, so a long library is a
      // long list rather than an infinitely compressed corridor.
      const z = -Math.min(d, FAR) * ROW_DEPTH;
      row.style.transform = `translate3d(-50%, 0, ${z.toFixed(1)}px)`;
      // Depth fade, so the far end goes into the room rather than stopping.
      row.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, d) / (FAR + 2.5))).toFixed(3));
      row.classList.toggle('is-near', d < NEAR_ROWS);
    }
  }

  const onScroll = () => { if (!raf) raf = requestAnimationFrame(place); };
  viewport.addEventListener('scroll', onScroll, { passive: true });

  // The stage has to be tall enough to scroll through every row.
  function resize() {
    stage.style.height = `${Math.max(1, Math.ceil(items.length / PER_ROW)) * ROW_DEPTH + viewport.clientHeight * 0.4}px`;
  }
  const ro = new ResizeObserver(() => { resize(); place(); });
  ro.observe(viewport);

  build();
  resize();
  host.appendChild(stage);
  place();

  const off = lib.events.on('change', () => { build(); resize(); });
  // Only the rows that exist, which is only the ones you can see.
  const offArt = lib.events.on('art', () => {
    for (const row of liveRows.values()) {
      for (const img of row.querySelectorAll('.art-img')) {
        if (img.dataset.key) paintArt(img, img.dataset.key);
      }
    }
  });

  return () => {
    off(); offArt(); ro.disconnect();
    viewport.removeEventListener('scroll', onScroll);
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
function mountCrate(host) {
  const WINDOW = 5;                       // how many either side of the middle
  const box = el('div', {
    class: 'crate', tabindex: '0', role: 'listbox', 'aria-label': 'Albums',
  });
  const rail = el('div', { class: 'crate-rail' });
  const meta = el('div', { class: 'crate-meta' },
    el('h2', { class: 'crate-title' }),
    el('p', { class: 'crate-sub' }));
  const hint = el('p', { class: 'crate-hint label', text: 'Arrow keys to flip · Enter to open' });
  box.append(rail, meta, hint);
  host.appendChild(box);

  let albums = lib.state.albums;
  let at = 0;
  const cards = new Map();                // offset -> node, recycled in place

  function paint() {
    albums = lib.state.albums;
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
      const s = o < 0 ? -1 : 1;
      const d = Math.abs(o);
      const x = d === 0 ? 0 : s * (58 + (d - 1) * 30);
      const z = d === 0 ? 70 : -d * 120;
      const ry = d === 0 ? 0 : -s * 44;
      // The -50% pair is the centring the stylesheet asked for and cannot
      // apply itself, because this line replaces the whole transform.
      node.style.transform =
        `translate(-50%, -50%) translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(0)}px)` +
        ` rotateY(${ry.toFixed(0)}deg)`;
      node.style.opacity = d === 0 ? '1' : String(Math.max(0.15, 1 - d * 0.22));
      node.style.zIndex = String(20 - d);
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
    box.setAttribute('aria-activedescendant', '');
  }

  const move = (by) => { at += by; paint(); };

  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }
    else if (e.key === 'Home') { at = 0; paint(); e.preventDefault(); }
    else if (e.key === 'End') { at = albums.length - 1; paint(); e.preventDefault(); }
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
      el('span', { class: 'dot' }),
      album.year ? el('span', { text: String(album.year) }) : null,
      album.year ? el('span', { class: 'dot' }) : null,
      el('span', { text: fmtCount(album.tracks.length, 'track') }),
      el('span', { class: 'dot' }),
      el('span', { text: fmtTotal(album.duration) })));

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
    el('span', { class: 'back-artist', text: album.artist }),
    el('span', { class: 'back-title', text: album.title })));

  const list = el('ol', { class: 'back-list' });
  for (const t of album.tracks) {
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

  const grid = new VirtualGrid({
    viewport: host, minCell: 156, gap: 22, aspect: 1, footer: 64,
    create: () => artistCard(null),
    render: (node, artist) => renderArtistCard(node, artist),
  });
  grid.setItems(artists);
  enter([head], { y: 10 });

  const off = lib.events.on('change', () => grid.setItems(lib.state.artists));
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

function viewPlaylists(host) {
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Playlists' }),
    el('p', { class: 'page-sub', text: fmtCount(lib.state.playlists.length, 'playlist') }));
  host.appendChild(head);

  const bar = el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn primary', html: ico('plus') + '<span>New playlist</span>',
      onclick: () => promptDialog({
        title: 'New playlist', label: 'Name', value: 'My playlist', confirm: 'Create',
        onConfirm: async (name) => { if (name) { const p = await lib.createPlaylist(name); location.hash = '#/playlist/' + p.id; } },
      }),
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

  playback.appendChild(pbRows);
  host.appendChild(playback);

  /* --- folders --- */
  const folders = el('section', { class: 'block' }, sectionHead('Music folders'));
  const list = el('div', { class: 'rows' });

  const paintRoots = () => {
    list.textContent = '';
    if (!lib.state.roots.length) {
      list.appendChild(el('p', { class: 'muted', text: 'No folders added yet.' }));
    }
    for (const root of lib.state.roots) {
      const row = el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('folder') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: root.name }),
          el('div', { class: 'settings-note', text:
            root.needsPermission ? 'Permission needed — click Reconnect'
            : root.needsReconnect ? 'Re-add this folder to play its files this session'
            : `${fmtCount(root.count || 0, 'file')} · ${root.kind === 'handle' ? 'linked folder' : 'session only'}` })),
        el('div', { class: 'settings-actions' },
          (root.needsPermission || root.needsReconnect)
            ? el('button', { class: 'btn ghost sm', text: 'Reconnect', onclick: () => document.dispatchEvent(new CustomEvent('sonora:add')) })
            : el('button', { class: 'btn ghost sm', text: 'Rescan', onclick: () => lib.scanRoot(root) }),
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
  });

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

  enter([head, folders, conn, appearance, viz, online, listening, storage, shape, keys, about], { each: 34, y: 12 });
  const off = lib.events.on('roots', paintRoots);
  return () => off();
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

const ROUTES = {
  home: viewHome,
  files: viewFiles,
  songs: viewSongs,
  albums: viewAlbums,
  album: viewAlbum,
  artists: viewArtists,
  artist: viewArtist,
  favourites: viewFavourites,
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
