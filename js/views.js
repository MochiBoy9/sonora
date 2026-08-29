/* views.js — every route in the app.
 *
 * A view is a function that fills the scroll host and returns a teardown.
 * Long lists go through the virtualiser; short ones (an album's tracks) are
 * rendered directly, because 12 nodes are cheaper than the machinery.
 */

import { el, ico, fmtTime, fmtTotal, fmtCount, fmtBytes, cmpText } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import * as db from './db.js';
import { VirtualList, VirtualGrid } from './virtual.js';
import {
  artBox, paintArt, trackRowFactory, trackMenu, menu, toast, dialog, promptDialog,
  sectionHead, emptyState, playFab, placeholderStyle,
} from './ui.js';
import { enter, scramble, countTo, tilt3d } from './motion.js';
import { MODES, isMode } from './visualizer.js';
import { mountCircles } from './circles.js';
import * as stats from './stats.js';
import * as band from './band.js';
import * as session from './session.js';

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
function trackTable(host, getTracks, { origin, columns, onRemove, removeLabel } = {}) {
  let tracks = getTracks();
  const factory = trackRowFactory({
    columns: columns || ['index', 'title', 'album', 'duration'],
    onPlay: (i) => playAll(tracks, i, origin),
    onMenu: (i, anchor, event) => {
      const t = tracks[i];
      if (!t) return;
      menu(trackMenu([t], {
        origin,
        onRemove: onRemove && (() => onRemove(t, i)),
        removeLabel,
      }), { anchor, event });
    },
  });

  const list = new VirtualList({ viewport: host, rowHeight: ROW_H, ...factory });
  list.setItems(tracks);

  return {
    list,
    update() { tracks = getTracks(); list.setItems(tracks); },
    refresh() { list.refresh(); },
    get tracks() { return tracks; },
  };
}

function columnHeader(columns, sortState, onSort) {
  const head = el('div', { class: 'trow thead' });
  let html = '';
  if (columns.includes('index')) html += '<div class="trow-index">#</div>';
  html += '<div class="trow-main"><button class="sortable" data-sort="title">Title</button></div>';
  if (columns.includes('album')) html += '<div class="trow-album"><button class="sortable" data-sort="album">Album</button></div>';
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
    '<div class="card-art">' +
      '<div class="art"><img class="art-img" alt="" decoding="async"></div>' +
      '<i class="card-tick tl"></i><i class="card-tick br"></i>' +
      '<button class="fab card-fab" tabindex="-1" aria-label="Play">' + ico('play') + '</button>' +
    '</div>' +
    '<div class="card-title"></div><div class="card-sub"></div>';

  // The artwork turns toward the pointer on a spring. The card supplies the
  // perspective; only the plate inside it moves.
  tilt3d(card.querySelector('.card-art'), { max: 8, lift: 16, scale: 1.015 });

  card.querySelector('.card-fab').addEventListener('click', (e) => {
    e.stopPropagation();
    const key = card.dataset.key;
    const al = albumOf(key);
    if (al) playAll(al.tracks, 0, { type: 'album', key, label: al.title });
  });
  const open = () => onOpen ? onOpen(card.dataset.key) : (location.hash = '#/album/' + card.dataset.key);
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

export function renderAlbumCard(card, album) {
  card.dataset.key = album.key;
  paintArt(card.querySelector('.art-img'), album.key);
  const t = card.querySelector('.card-title');
  if (t.textContent !== album.title) t.textContent = album.title;
  const s = card.querySelector('.card-sub');
  const sub = album.year ? `${album.artist} · ${album.year}` : album.artist;
  if (s.textContent !== sub) s.textContent = sub;
}

function artistCard(artist) {
  const card = el('article', { class: 'card card-artist', tabindex: '0', role: 'button' });
  card.innerHTML =
    '<div class="card-art round"><div class="art"><img class="art-img" alt="" decoding="async"></div>' +
    '<button class="fab card-fab" tabindex="-1" aria-label="Play">' + ico('play') + '</button></div>' +
    '<div class="card-title"></div><div class="card-sub"></div>';
  tilt3d(card.querySelector('.card-art'), { max: 7, lift: 12, scale: 1.02 });
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
  };
  rail.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(rail);

  wrap.appendChild(el('div', { class: 'rail-wrap' }, rail, prev, next));
  enter(rail.children, { each: 32, y: 14 });
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
  const stats = el('p', { class: 'page-sub' });
  const head = el('header', { class: 'home-hero' },
    el('div', { class: 'home-hero-text' },
      el('p', { class: 'eyebrow', text: greeting }),
      title,
      stats,
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
  stats.append(counted, ' tracks \u00b7 ',
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

  // A compact "surprise me" strip: random albums, reshuffled on every visit.
  const pool = lib.state.albums.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const shelfRandom = shelf('From the shelf', pool.slice(0, 10), (a) => albumCard(a));
  if (shelfRandom) frag.appendChild(shelfRandom);

  host.appendChild(frag);
  enter([head], { y: 12 });
  return () => {};
}

/* ------------------------------------------------------------------ SONGS */

const songSort = { key: 'title', dir: 1 };

function viewSongs(host) {
  const columns = ['index', 'art', 'title', 'album', 'duration'];
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
  return () => { off(); table.list.destroy(); };
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

  const grid = new VirtualGrid({
    viewport: host, minCell: 168, gap: 22, aspect: 1, footer: 64,
    create: () => albumCard(null),
    render: (node, album) => renderAlbumCard(node, album),
  });
  grid.setItems(albums);
  enter([head], { y: 10 });

  const off = lib.events.on('change', () => grid.setItems(lib.state.albums));
  const offArt = lib.events.on('art', () => grid.refresh());
  return () => { off(); offArt(); grid.destroy(); };
}

/* ------------------------------------------------------------------ ALBUM */

function viewAlbum(host, key) {
  const album = albumOf(key);
  if (!album) return notFound(host, 'Album not found');

  const origin = { type: 'album', key, label: album.title };
  const hero = el('header', { class: 'hero' });
  const art = artBox(key, null, 'hero-art');
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
    el('button', { class: 'icon-btn', html: ico('more'), title: 'More', onclick: (e) => menu(trackMenu(album.tracks, { origin }), { anchor: e.currentTarget }) }));
  meta.appendChild(actions);

  hero.append(art, meta);
  host.appendChild(hero);
  applyHeroTint(hero, key);
  decode(hero.querySelector('.hero-title'), album.title, { duration: 620 });

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
  enter([hero], { y: 16, wipe: true });
  enter(list.children, { each: 13, y: 8, delay: 80 });

  const refresh = () => {
    for (const row of list.children) {
      const i = parseInt(row.dataset.index, 10);
      if (!isNaN(i)) factory.render(row, album.tracks[i], i);
    }
  };
  const off = player.events.on('track', refresh);
  const offState = player.events.on('state', refresh);
  return () => { off(); offState(); };
}

/** Paints a soft wash of the album's own colour behind its header. */
function applyHeroTint(hero, key) {
  const rgb = lib.accentFor(key);
  if (rgb) hero.style.setProperty('--hero-rgb', rgb.join(' '));
  else lib.loadArt(key).then(() => {
    const late = lib.accentFor(key);
    if (late) hero.style.setProperty('--hero-rgb', late.join(' '));
  });
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
      card.querySelector('.card-sub').textContent = fmtCount(p.tracks.length, 'track');
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

function viewPlaylist(host, id) {
  const p = lib.state.playlists.find((x) => x.id === id);
  if (!p) return notFound(host, 'Playlist not found');
  const origin = { type: 'playlist', key: id, label: p.name };

  const hero = el('header', { class: 'hero' });
  const tracks0 = lib.playlistTracks(p);
  const art = artBox(tracks0[0]?.albumKey || p.id, null, 'hero-art');
  const meta = el('div', { class: 'hero-meta' },
    el('p', { class: 'eyebrow', text: 'Playlist' }),
    el('h1', { class: 'hero-title', text: p.name }),
    el('p', { class: 'hero-sub' },
      el('span', { text: fmtCount(p.tracks.length, 'track') }),
      el('span', { class: 'dot' }),
      el('span', { text: fmtTotal(tracks0.reduce((s, t) => s + (t.duration || 0), 0)) })));
  meta.appendChild(el('div', { class: 'hero-actions' },
    playFab(() => playAll(lib.playlistTracks(p), 0, origin)),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(lib.playlistTracks(p), origin) }),
    el('button', {
      class: 'icon-btn', html: ico('more'), onclick: (e) => menu([
        { label: 'Rename', icon: 'edit', onSelect: () => promptDialog({ title: 'Rename playlist', label: 'Name', value: p.name, onConfirm: (n) => n && lib.updatePlaylist(p.id, { name: n }) }) },
        { label: 'Add to queue', icon: 'queue', onSelect: () => { player.enqueue(lib.playlistTracks(p)); toast('Added to queue'); } },
        { separator: true },
        { label: 'Delete playlist', icon: 'trash', danger: true, onSelect: () => { lib.removePlaylist(p.id); location.hash = '#/playlists'; } },
      ], { anchor: e.currentTarget }),
    })));
  hero.append(art, meta);
  host.appendChild(hero);
  if (tracks0[0]) applyHeroTint(hero, tracks0[0].albumKey);

  if (!p.tracks.length) {
    host.appendChild(emptyState({ icon: 'playlist', title: 'This playlist is empty', note: 'Right-click a track anywhere and choose “Add to playlist”.' }));
    enter([hero], { y: 14 });
    const off = lib.events.on('playlists', () =>
      document.dispatchEvent(new CustomEvent('sonora:refresh')));
    return () => off();
  }

  const columns = ['index', 'art', 'title', 'album', 'duration'];
  const table = trackTable(host, () => lib.playlistTracks(p), {
    origin, columns, removeLabel: 'Remove from playlist',
    onRemove: (t) => {
      const i = p.tracks.indexOf(t.id);
      if (i >= 0) { p.tracks.splice(i, 1); lib.updatePlaylist(p.id, { tracks: p.tracks }); }
    },
  });
  enter([hero], { y: 14 });

  const rerender = () => table.update();
  const off = lib.events.on('playlists', rerender);
  return () => { off(); table.list.destroy(); };
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
    el('p', { class: 'page-sub', text: 'Folders · appearance · visualiser · storage' }));
  host.appendChild(head);

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

  /* --- appearance --- */
  const appearance = el('section', { class: 'block' }, sectionHead('Appearance'));
  const themeRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('sun') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Theme' }),
      el('div', { class: 'settings-note', text: 'Dark, light, or follow the system' })),
    el('div', { class: 'settings-actions' }, themeSwitch()));
  appearance.appendChild(themeRow);

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
  host.appendChild(storage);

  const about = el('section', { class: 'block about' },
    sectionHead('About'),
    el('p', { class: 'muted', text: 'Sonora plays audio files from this computer. Files are read directly by the browser — nothing is uploaded, and the library index lives in local storage on this device.' }),
    el('p', { class: 'muted small', text: 'Every audio container is indexed and tagged — MP3, M4A/AAC, FLAC, Ogg/Opus, WAV, AIFF, WebM/Matroska and the rest. Anything this browser has no decoder for is still catalogued, and says so on its row.' }),
    el('p', { class: 'muted small', text: 'Shortcuts: Space play/pause · ←/→ seek · ↑/↓ volume · N next · P previous · S shuffle · R repeat · V visualiser · / search · Q queue' }));
  host.appendChild(about);

  enter([head, folders, conn, appearance, viz, online, listening, storage, about], { each: 34, y: 12 });
  const off = lib.events.on('roots', paintRoots);
  return () => off();
}

function themeSwitch() {
  const wrap = el('div', { class: 'segmented' });
  const current = localStorage.getItem('sonora:theme') || 'system';
  for (const [value, label] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']]) {
    wrap.appendChild(el('button', {
      class: 'seg' + (current === value ? ' is-on' : ''),
      text: label,
      onclick: (e) => {
        for (const b of wrap.children) b.classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        document.dispatchEvent(new CustomEvent('sonora:theme', { detail: value }));
      },
    }));
  }
  return wrap;
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

const ROUTES = {
  home: viewHome,
  songs: viewSongs,
  albums: viewAlbums,
  album: viewAlbum,
  artists: viewArtists,
  artist: viewArtist,
  playlists: viewPlaylists,
  playlist: viewPlaylist,
  search: viewSearch,
  circles: viewCircles,
  settings: viewSettings,
};

export function renderView(host, route) {
  const key = route.name + '/' + route.arg;
  freshRoute = key !== lastRouteKey;
  lastRouteKey = key;

  const fn = ROUTES[route.name] || viewHome;
  return fn(host, route.arg) || (() => {});
}
