/* views/albums.js — the wall, and the four ways of looking at it.
 *
 * Grid, Crate, Shelf and Floor are one route with four mounts. They share the
 * sort control and the album ordering; they share nothing else, which is why
 * each is a `mount` of its own rather than a branch inside one renderer.
 */

import * as rack from '../audio.js';
import * as lib from '../library.js';
import * as looks from '../looks.js';
import { enter, reduceMotion } from '../motion.js';
import * as player from '../player.js';
import { emptyState, paintArt, placeholderStyle, sleeve, toast } from '../ui.js';
import { el, fmtCount } from '../util.js';
import { VirtualGrid } from '../virtual.js';
import * as drag from '../drag.js';
import { MODES } from '../visualizer.js';
import { backCover } from './album.js';
import { albumCard, decode, letterOf, markTransition, renderAlbumCard, shelf, sortControl, thicknessOf } from './shared.js';

/* ------------------------------------------------------------------ ALBUMS */

export function viewAlbums(host) {
  const albums = lib.state.albums;
  const head = el('header', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Albums' }),
    el('p', { class: 'page-sub', text: fmtCount(albums.length, 'album') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Albums');

  if (!albums.length) {
    host.appendChild(emptyState({ icon: 'album', title: 'No albums yet',
      note: 'Albums are built from the tags in your files. Point Sonora at a folder and they appear here.',
      action: { label: 'Add music folder', onSelect: () => document.dispatchEvent(new CustomEvent('sonora:add')) } }));
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
    keys: [['artist', 'Artist'], ['title', 'Title'], ['year', 'Year'], ['released', 'Original year'],
           ['added', 'Recently added'], ['length', 'Length'], ['tracks', 'Track count'],
           ['plays', 'Times played'], ['played', 'Last played'],
           // F3 and F1: the two orders that are not rules — one computed from
           // the covers, one put there by hand.
           ['colour', 'Colour'], ['arranged', 'However you left it']],
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
      /* 168 gave six columns of a 148px cover on a 1440 window — smaller than the
         thumbnail most people picture when they think "album art", on the one
         page whose whole subject is the covers. The 40px of dead space that used
         to sit under each one is gone, so the room it was holding can go to the
         artwork instead of to a sixth column of small ones. */
      viewport: host, minCell: () => (innerWidth <= 560 ? 150 : 196), gap: 22, aspect: 1, footer: 64,
      create: () => {
        const card = albumCard(null);
        /* F1: in "However you left it", a record can be dragged to a place on
           the wall. In every other order it cannot, because dropping a record
           somewhere in an alphabetical wall is a request the wall has no way
           to honour — it would be re-sorted away on the next repaint. The card
           keeps its ordinary track-drag everywhere else, so this only takes
           over the gesture where it means something. */
        card.addEventListener('dragover', (e) => {
          if (sorter.state.key !== 'arranged' || !drag.draggingAlbum()) return;
          e.preventDefault();
          e.stopPropagation();
          card.classList.add('is-drop-before');
        });
        card.addEventListener('dragleave', () => card.classList.remove('is-drop-before'));
        card.addEventListener('drop', (e) => {
          card.classList.remove('is-drop-before');
          const moving = drag.draggingAlbum();
          if (sorter.state.key !== 'arranged' || !moving) return;
          e.preventDefault();
          e.stopPropagation();
          lib.arrangeAlbum(moving, card.dataset.key);
          drag.endDrag();
        });
        return card;
      },
      render: (node, album) => renderAlbumCard(node, album),
    });
    grid.setItems(ordered());
    host.classList.toggle('is-arranging', sorter.state.key === 'arranged');
    const off = lib.events.on('change', () => grid.setItems(ordered()));
    const offArt = lib.events.on('art', () => grid.refresh());
    void into;
    return () => { host.classList.remove('is-arranging'); off(); offArt(); grid.destroy(); };
  }

  setMode(mode);
  enter([head, bar], { y: 10 });
  return () => { try { teardown(); } catch (err) { console.warn(err); } };
}

const ALBUM_VIEW = 'sonora:albumview';
const FLOOR_AXIS = 'sonora:flooraxis';
const ALBUM_SORT = 'sonora:albumsort';
export const ARTIST_SORT = 'sonora:artistsort';

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
export function mountShelf(host, ordered) {
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

  /* Width of one spine, in px — read from the stylesheet rather than repeated
     here.
     This used to be two hardcoded numbers with a comment asking whoever
     changed the CSS to change these too, and the first rule that widened
     spines for a coarse pointer walked straight past it: the shelf kept
     spacing them 21px apart while they were drawn 44 wide, so every record
     overlapped its neighbour. `--spine-base` and `--spine-thick` are declared
     on `.shelf-run` and read here, so there is one definition and the media
     query that changes it changes both. */
  const GAP = 2;
  const spineMetrics = () => {
    const cs = getComputedStyle(shelf);
    const base = parseFloat(cs.getPropertyValue('--spine-base')) || 13;
    const thick = parseFloat(cs.getPropertyValue('--spine-thick')) || 11;
    return { base, thick };
  };
  let metrics = { base: 13, thick: 11 };
  const widthOf = (album) => metrics.base + metrics.thick * thicknessOf(album) + GAP;

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
    // Re-read every time: the width changes with the media query, and a shelf
    // measured once at mount is a shelf that is wrong after a rotation.
    metrics = spineMetrics();
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
export function mountFloor(host, viewport) {
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
  const rail = el('nav', { class: 'floor-rail', 'aria-label': 'Where you are' });
  hud.appendChild(rail);
  let railBtns = [];

  /* F4: which axis the room is walked along. On the HUD rather than in the
     page toolbar, because it is a property of this room and the toolbar's sort
     control is hidden here for exactly that reason. */
  let axis = 'year';
  try { const v = localStorage.getItem(FLOOR_AXIS); if (v) axis = v; } catch { /* private */ }

  const axisBar = el('div', { class: 'segmented quiet floor-axis', role: 'tablist', 'aria-label': 'Walk the room by' });
  hud.appendChild(axisBar);

  function buildRail() {
    const spec = FLOOR_AXES[axis] || FLOOR_AXES.year;
    rail.textContent = '';
    railBtns = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const lane = rows[i];
      const key = lane.undated ? 'undated' : spec.group(lane.year);
      if (seen.has(key)) continue;
      seen.add(key);
      const btn = el('button', {
        class: 'floor-rail-btn',
        text: lane.undated ? spec.none : spec.groupName(key),
        title: lane.undated ? spec.none : spec.groupTitle(key),
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
  /* F4: the room, walked along something other than the year.
   *
   * The depth axis was the release year and that was the whole of what the
   * Floor was. The room itself — the perspective, the lanes, the walk, the
   * markings on the ground — has nothing to do with which number is on the
   * axis, so the same room walked by when you first heard something, or by how
   * much you have played it, is three rooms for the cost of one function.
   *
   * Each axis says how to get a lane number out of an album, what to call a
   * lane, how to group lanes on the rail, and whether the distance between two
   * lanes means anything. The year's gaps are the point of the year — a
   * collection with nothing between 1979 and 1994 should feel like it — and
   * genre has no such thing, so `spaced` decides whether a drought costs you a
   * walk or not.
   */
  const FLOOR_AXES = {
    year: {
      label: 'Release year',
      spaced: true,
      of: (a) => a.originalYear || a.year || 0,
      name: (v) => String(v),
      none: 'No year',
      group: (v) => Math.floor(v / 10) * 10,
      groupName: (g) => String(g).slice(2) + 's',
      groupTitle: (g) => g + 's',
      mark: (v, prev) => (Math.floor(v / 10) * 10 !== prev ? `${Math.floor(v / 10) * 10}s` : ''),
    },
    added: {
      /* When it arrived, by month. Not by day: a library imported in one
         afternoon would be a single lane, and a walk of one step is not a
         walk. */
      label: 'When you added it',
      spaced: true,
      of: (a) => {
        if (!a.addedAt) return 0;
        const d = new Date(a.addedAt);
        return d.getFullYear() * 12 + d.getMonth();
      },
      name: (v) => new Date(Math.floor(v / 12), v % 12, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' }),
      none: 'Unknown',
      group: (v) => Math.floor(v / 12),
      groupName: (g) => String(g),
      groupTitle: (g) => String(g),
      mark: (v, prev) => (Math.floor(v / 12) !== prev ? String(Math.floor(v / 12)) : ''),
    },
    heard: {
      // When you last put it on, by month — the room as a memory of an
      // evening rather than as a catalogue.
      label: 'When you last played it',
      spaced: true,
      of: (a) => {
        if (!a.lastPlayed) return 0;
        const d = new Date(a.lastPlayed);
        return d.getFullYear() * 12 + d.getMonth();
      },
      name: (v) => new Date(Math.floor(v / 12), v % 12, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' }),
      none: 'Never played',
      group: (v) => Math.floor(v / 12),
      groupName: (g) => String(g),
      groupTitle: (g) => String(g),
      mark: (v, prev) => (Math.floor(v / 12) !== prev ? String(Math.floor(v / 12)) : ''),
    },
    plays: {
      /* Bands rather than exact counts, because the difference between 41 and
         42 plays is not a room you want to walk through. Logarithmic, for the
         same reason the wear on a sleeve is. */
      label: 'How much you have played it',
      spaced: false,
      of: (a) => Math.round(Math.log1p(a.plays || 0) * 2),
      name: (v) => {
        const lo = Math.round(Math.expm1(v / 2));
        const hi = Math.round(Math.expm1((v + 1) / 2)) - 1;
        return lo === 0 ? 'Never' : hi <= lo ? `${lo} plays` : `${lo}–${hi} plays`;
      },
      none: 'Never',
      group: (v) => v,
      // On the rail these are the only labels somebody reads while walking, so
      // they say what they mean rather than printing a bare number that could
      // be a year, a count or a band.
      groupName: (g) => (g === 0 ? 'None' : Math.round(Math.expm1(g / 2)) + '+'),
      groupTitle: (g) => (g === 0 ? 'Never played' : Math.round(Math.expm1(g / 2)) + '+ plays'),
      mark: (v) => (v === 0 ? 'Never played' : ''),
    },
  };

  function lanesFor(albums) {
    const spec = FLOOR_AXES[axis] || FLOOR_AXES.year;
    const byKey = new Map();
    const none = [];
    for (const a of albums) {
      const v = spec.of(a);
      if (!v && v !== 0) { none.push(a); continue; }
      if (spec === FLOOR_AXES.year && !v) { none.push(a); continue; }
      if ((axis === 'added' || axis === 'heard') && !v) { none.push(a); continue; }
      if (!byKey.has(v)) byKey.set(v, []);
      byKey.get(v).push(a);
    }

    const keys = [...byKey.keys()].sort((x, y) => x - y);
    const out = [];
    let prev = null;
    let lastGroup = null;
    for (const v of keys) {
      // Distance to walk before this lane, from however long the drought was —
      // but only on an axis where a drought means something.
      const gap = prev === null || !spec.spaced
        ? 0 : Math.min(GAP_MAX, (v - prev - 1) * GAP_DEPTH);
      out.push({
        year: v,
        albums: byKey.get(v),
        gap,
        mark: spec.mark(v, lastGroup),
        name: spec.name(v),
      });
      lastGroup = spec.group(v);
      prev = v;
    }
    if (none.length) {
      out.push({ year: 0, albums: none, gap: keys.length ? 1.4 : 0, mark: spec.none, name: spec.none, undated: true });
    }
    return out;
  }

  function buildAxisBar() {
    axisBar.textContent = '';
    for (const [id, spec] of Object.entries(FLOOR_AXES)) {
      axisBar.appendChild(el('button', {
        class: 'seg' + (id === axis ? ' is-on' : ''),
        role: 'tab', 'aria-selected': String(id === axis),
        text: spec.label, title: 'Walk the room by ' + spec.label.toLowerCase(),
        onclick: () => setAxis(id),
      }));
    }
  }

  function setAxis(next) {
    if (next === axis || !FLOOR_AXES[next]) return;
    axis = next;
    try { localStorage.setItem(FLOOR_AXIS, axis); } catch { /* private */ }
    buildAxisBar();
    stage.setAttribute('aria-label',
      `Albums by ${FLOOR_AXES[axis].label.toLowerCase()}. Scroll to walk, left and right arrows to walk sideways, ` +
      'Enter to step into the room, P to walk to what is playing.');
    // Back to the front of the room: a camera left at row forty of the old
    // axis lands somewhere arbitrary in the new one.
    camX = 0;
    build();
    buildRail();
    resize();
    viewport.scrollTo({ top: 0, behavior: 'instant' });
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

  buildAxisBar();
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
export function mountCrate(host, ordered) {
  const WINDOW = 5;                       // how many either side of the middle
  const box = el('div', {
    class: 'crate', tabindex: '0', role: 'listbox', 'aria-label': 'Albums',
    /* The records behind the front one recede past the right-hand edge and
       are meant to: a crate that fits inside its own box is a shelf. Said
       out loud so `tools/looks.mjs` does not report it every run. */
    'data-clips': '',
  });
  const rail = el('div', { class: 'crate-rail' });
  const count = el('p', { class: 'crate-count label' });
  const meta = el('div', { class: 'crate-meta' },
    el('h2', { class: 'crate-title' }),
    el('p', { class: 'crate-sub' }),
    /* Inside the block rather than positioned under it. Absolutely placed at
       its own `bottom`, it sat in the space the two lines above it need — and
       at 620px, where the subtitle wraps, it printed straight through them. */
    count);
  const hint = el('p', { class: 'crate-hint label', text: 'Arrow keys to flip · F to turn it over · Enter to open' });
  /* R4: where you are in the crate.
   *
   * Eleven records exist at once and every one of them stood behind the front
   * one, so a crate of fifty thousand looked exactly like a crate of eleven
   * and flipping gave no sense of travel at all. Real crate-digging is mostly
   * about what you have already pushed past, so the near half now leans the
   * other way — the same eleven nodes, redistributed, which costs nothing —
   * and the count says the rest. */
  box.append(rail, meta, hint);

  /* F2: the ones left out.
   *
   * Records you have played this week do not go back in the crate — they end
   * up in a pile beside the turntable, and that pile is a real index: it is
   * the answer to "what have I actually been listening to" without asking
   * anybody to count anything. Both numbers are already rolled up per album,
   * so this is one more reading of what the library holds rather than anything
   * new to compute.
   *
   * Drawn lying flat and overlapping, because that is what a pile looks like.
   * Absent entirely in a week where nothing was played — an empty pile is a
   * shelf with a label on it. */
  const pile = el('div', { class: 'crate-pile', 'aria-label': 'Played this week' });
  host.append(pile, box);

  const WEEK = 7 * 24 * 3600 * 1000;
  function paintPile() {
    const recent = lib.state.albums
      .filter((al) => al.lastPlayed && Date.now() - al.lastPlayed < WEEK)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, 8);
    pile.hidden = !recent.length;
    if (pile.hidden) { pile.textContent = ''; return; }
    pile.textContent = '';
    pile.appendChild(el('span', { class: 'crate-pile-label label', text: 'Left out this week' }));
    const stack = el('div', { class: 'crate-pile-stack' });
    recent.forEach((al, i) => {
      const card = el('button', {
        class: 'crate-pile-card', title: `${al.title} — ${al.artist}`,
        'aria-label': `${al.title} by ${al.artist}`,
        onclick: () => (location.hash = '#/album/' + al.key),
      }, el('img', { class: 'art-img', alt: '', decoding: 'async' }));
      // Each one sits a little further along and at its own slight angle, the
      // way a pile of sleeves actually settles. Derived from the key so a
      // record keeps its angle between visits rather than twitching.
      const tilt = ((al.key.charCodeAt(0) + i * 7) % 9) - 4;
      card.style.setProperty('--i', String(i));
      card.style.setProperty('--tilt', tilt + 'deg');
      paintArt(card.querySelector('.art-img'), al.key);
      stack.appendChild(card);
    });
    pile.appendChild(stack);
  }
  paintPile();

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
  const repaint = () => { paint(); paintPile(); };
  const off = lib.events.on('change', repaint);
  const offArt = lib.events.on('art', repaint);
  // F2: the pile is a fact about what has been played, so it moves when the
  // history does rather than only when the library changes.
  const offHistory = lib.events.on('history', paintPile);
  return () => { off(); offArt(); offHistory(); box.remove(); pile.remove(); cards.clear(); };
}
