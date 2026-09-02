/* app.js — shell: routing, navigation, search, shortcuts, theming, ingestion. */

import { $, el, ico, debounce, clamp, acceptAttr, formatName, idle, fmtTime } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { renderView, hasLiveSelection } from './views.js';
import { mountPlayerBar } from './playerbar.js';
import { mountQueue } from './queue.js';
import { toast, closeMenu, promptDialog, menu, dialog, rulesDialog } from './ui.js';
import * as session from './session.js';
import * as stats from './stats.js';
import * as looks from './looks.js';
import * as rack from './audio.js';
import { animate, ease, reduceMotion, startDeviceTilt, deviceTiltNeedsPermission } from './motion.js';
import { startIntro } from './intro.js';
import { mountBackdrop } from './backdrop.js';
import { toggleStage, isOpen as stageOpen } from './stage.js';
import { startRelief } from './relief.js';
import { startOffline } from './offline.js';
import { togglePalette, closePalette, isOpen as paletteOpen } from './palette.js';
import * as db from './db.js';
import * as keys from './keys.js';
import * as peakmap from './peaks.js';
import * as undoStack from './undo.js';

/* Destinations are numbered, like channels on a desk — the number is part of
   how you learn where things are, not decoration. */
const NAV = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'songs', label: 'Songs', icon: 'music' },
  { route: 'albums', label: 'Albums', icon: 'album' },
  { route: 'artists', label: 'Artists', icon: 'artist' },
  { route: 'favourites', label: 'Favourites', icon: 'star' },
  { route: 'recent', label: 'Recently played', icon: 'clock' },
  { route: 'playlists', label: 'Playlists', icon: 'playlist' },
  { route: 'files', label: 'Files', icon: 'folder' },
  { route: 'circles', label: 'Analysis', icon: 'circles' },
  { route: 'sound', label: 'Sound', icon: 'sliders' },
];

/** What the top-bar readout says for a given route. */
function routeLabel(route) {
  if (route.name === 'album') return 'Album';
  if (route.name === 'artist') return 'Artist';
  if (route.name === 'playlist') return 'Playlist';
  if (route.name === 'search') return 'Search';
  if (route.name === 'settings') return 'Settings';
  if (route.name === 'circles') return 'Analysis';
  const nav = NAV.find((n) => n.route === route.name);
  return nav ? nav.label : 'Home';
}

const scrollMemory = new Map();
let teardown = () => {};
let currentHash = '';

/* ------------------------------------------------------------------ routing */

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [name, ...rest] = raw.split('/');
  const arg = rest.join('/');
  if (!name) return { name: 'home', arg: '' };
  return { name, arg };
}

function swapView() {
  const host = $('#view');
  const route = parseHash();

  if (currentHash) scrollMemory.set(currentHash, host.scrollTop);
  currentHash = location.hash;

  try { teardown(); } catch (err) { console.warn(err); }
  closeMenu();
  host.textContent = '';
  /* And its classes. A view that puts one on the container — the album Floor
     mode does, to clip its own horizontal overflow — had no way to take it off
     again: its teardown unwinds what it built, and clearing `textContent`
     leaves the element itself untouched. So the class outlived the view and
     every page afterwards inherited it. Resetting here fixes it for every
     view at once rather than asking each one to remember. */
  host.className = 'view';
  /* `#view` carries `scroll-behavior: smooth`, which is right for the anchors
     inside a page and wrong for both of these: a route change is a new page,
     not a journey across the old one. Assigning `scrollTop` obeys the CSS and
     animates, so both of these have to say what they mean. */
  host.scrollTo({ top: 0, behavior: 'instant' });

  teardown = renderView(host, route);
  paintNav(route);
  paintRouteTag(route);
  syncSearchInput(route);

  /* Coming back to a page you have already read should put you where you left
     it, at once. Animated, it instead scrolls the whole way down in front of
     you every time you press Back — eight hundred milliseconds of content
     sliding under the transport before it settles, which reads as the page
     running away rather than as a page being restored. */
  const remembered = scrollMemory.get(currentHash);
  if (remembered) {
    requestAnimationFrame(() => { host.scrollTo({ top: remembered, behavior: 'instant' }); });
  }

  document.title = titleFor(route);
}

/**
 * Routes used to blank and rebuild. Wrapped in a view transition they cross-
 * fade instead — and where a cover has been marked on the way out (see
 * `markTransition` in views.js), the browser matches it to the record on the
 * page being arrived at and flies one into the other.
 *
 * The swap itself is unchanged and still synchronous; `startViewTransition`
 * only takes a snapshot either side of it. On an engine without it, or for
 * someone who has asked for less motion, the callback runs directly and the
 * app behaves exactly as it did before.
 */
let transitioning = false;

function navigate() {
  const paired = document.querySelector('[style*="view-transition-name"]');

  /* Four reasons to do the plain swap, and every one of them is a case where a
     transition is either impossible or unwanted:
     — the engine has no view transitions;
     — someone asked for less motion;
     — the document is hidden, where the API aborts by design (a background
       tab has nothing to take a snapshot of);
     — one is already running, and starting a second skips the first. */
  if (!document.startViewTransition || reduceMotion.matches ||
      document.visibilityState === 'hidden' || transitioning) {
    clearTransitionMarks();
    return swapView();
  }

  document.documentElement.classList.toggle('vt-paired', !!paired);
  transitioning = true;
  const done = () => {
    transitioning = false;
    // Marks are per-navigation. Left in place they collide with the next one,
    // and two elements sharing a view-transition-name is a transition the
    // browser refuses to run at all.
    clearTransitionMarks();
    document.documentElement.classList.remove('vt-paired');
  };

  const vt = document.startViewTransition(() => swapView());

  /* A ViewTransition hands back *three* promises, and a skipped or aborted
     transition rejects more than one of them. `finished` is the obvious one;
     `ready` rejects the moment the transition is abandoned — before any
     animation exists — and `updateCallbackDone` rejects if the DOM swap itself
     throws. Any one left unattached surfaces as an unhandled rejection, which
     is what "Transition was aborted because of invalid state" was doing in the
     console five times a minute while the route changed perfectly happily.

     Being skipped is a normal outcome here: navigating again mid-transition,
     a tab going to the background, an engine deciding it cannot snapshot. The
     route still changed either way, so all three are swallowed and only
     `finished` does the cleaning up. */
  vt.ready.catch(() => {});
  vt.updateCallbackDone.catch(() => {});
  vt.finished.then(done, done);
}

/** Removes every view-transition-name this app put on the page. */
function clearTransitionMarks() {
  for (const n of document.querySelectorAll('[data-vt]')) {
    n.style.removeProperty('view-transition-name');
    n.removeAttribute('data-vt');
  }
}

function titleFor(route) {
  const base = 'Sonora';
  if (route.name === 'album') return (lib.state.albumBy.get(route.arg)?.title || 'Album') + ' · ' + base;
  if (route.name === 'artist') return (lib.state.artistBy.get(route.arg)?.name || 'Artist') + ' · ' + base;
  if (route.name === 'playlist') return (lib.state.playlists.find((p) => p.id === route.arg)?.name || 'Playlist') + ' · ' + base;
  if (route.name === 'search') return route.arg ? `“${route.arg}” · ${base}` : base;
  if (route.name === 'home') return base;
  // Everything else the top-bar readout can already name — Settings included,
  // which is not in NAV and used to fall through to a bare "Sonora".
  return `${routeLabel(route)} · ${base}`;
}

/* ------------------------------------------------------------------ sidebar */

let pill = null;

function buildSidebar() {
  const side = $('#sidebar');

  const brand = el('a', { class: 'brand', href: '#/home', 'aria-label': 'Sonora — home' },
    el('span', { class: 'brand-mark', html: ico('logo') }),
    el('span', { class: 'brand-name', html: 'SON<b>ORA</b>' }));

  const nav = el('nav', { class: 'nav', 'aria-label': 'Library' });
  pill = el('div', { class: 'nav-pill' });
  nav.appendChild(pill);
  NAV.forEach((item, i) => {
    nav.appendChild(el('a', {
      class: 'nav-item', href: '#/' + item.route, data: { route: item.route },
    },
      el('span', { class: 'nav-num', text: String(i + 1).padStart(2, '0') }),
      el('span', { class: 'nav-ico', html: ico(item.icon) }),
      el('span', { class: 'nav-label', text: item.label })));
  });

  const playlistHead = el('div', { class: 'side-head' },
    el('span', { class: 'label', text: 'Playlists' }),
    el('button', {
      class: 'icon-btn ghost sm', title: 'New playlist', 'aria-label': 'New playlist', html: ico('plus'),
      onclick: (e) => menu([
        {
          label: 'Empty playlist', icon: 'playlist',
          hint: 'add tracks yourself',
          onSelect: () => promptDialog({
            title: 'New playlist', label: 'Name', value: 'My playlist', confirm: 'Create',
            onConfirm: async (name) => { if (name) { const p = await lib.createPlaylist(name); location.hash = '#/playlist/' + p.id; } },
          }),
        },
        {
          label: 'Smart shelf…', icon: 'sparkle',
          hint: 'describe it once',
          onSelect: () => rulesDialog(null, async (set) => {
            const p = await lib.createSmartPlaylist(set.name || 'Smart shelf', set);
            location.hash = '#/playlist/' + p.id;
          }),
        },
      ], { anchor: e.currentTarget }),
    }));

  const playlists = el('div', { class: 'side-playlists' });

  const footer = el('div', { class: 'side-foot' },
    el('button', {
      class: 'btn add-btn', html: ico('plus') + '<span>Add music</span>',
      onclick: (e) => addMusicMenu(e.currentTarget),
    }),
    el('a', { class: 'nav-item slim', href: '#/settings', data: { route: 'settings' } },
      el('span', { class: 'nav-ico', html: ico('settings') }), el('span', { class: 'nav-label', text: 'Settings' })));

  side.append(brand, nav, playlistHead, playlists, footer);

  const paintPlaylists = () => {
    playlists.textContent = '';
    if (!lib.state.playlists.length) {
      playlists.appendChild(el('p', { class: 'side-empty', text: 'No playlists yet' }));
      return;
    }
    for (const p of lib.state.playlists) {
      /* A smart shelf counts what it currently describes rather than what it
         was storing, and says which kind it is — finding out that a list
         rewrites itself by watching it change is worse than a small mark. */
      const count = p.smart ? lib.playlistTracks(p).length : p.tracks.length;
      playlists.appendChild(el('a', {
        class: 'side-playlist' + (p.smart ? ' is-smart' : ''),
        href: '#/playlist/' + p.id, data: { route: 'playlist:' + p.id },
        title: p.smart ? `${p.name} — describes itself` : p.name,
      },
        el('span', { class: 'side-playlist-name', text: p.name }),
        el('span', { class: 'side-playlist-count', text: String(count) })));
    }
    paintNav(parseHash());
  };
  paintPlaylists();
  lib.events.on('playlists', paintPlaylists);

  buildResizer(side);
}

/** The active-item pill glides between rows instead of jumping. */
function paintNav(route) {
  const key = route.name === 'playlist' ? 'playlist:' + route.arg : route.name;
  let active = null;
  for (const item of document.querySelectorAll('.nav-item, .side-playlist')) {
    const on = item.dataset.route === key;
    item.classList.toggle('is-active', on);
    item.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) active = item;
  }
  if (!pill) return;
  if (!active || active.closest('.side-foot')) { pill.style.opacity = '0'; return; }

  const nav = pill.parentNode;
  const navBox = nav.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  if (!box.height) return;

  const first = pill.getBoundingClientRect();
  const wasHidden = pill.style.opacity === '0' || !first.height;

  pill.style.opacity = '1';
  pill.style.height = box.height + 'px';
  pill.style.transform = `translateY(${box.top - navBox.top}px)`;

  if (!wasHidden && !reduceMotion.matches) {
    // FLIP from where it was drawn a moment ago.
    const dy = first.top - box.top;
    if (Math.abs(dy) > 0.5) {
      pill.animate(
        [{ transform: `translateY(${box.top - navBox.top + dy}px)`, height: first.height + 'px' },
         { transform: `translateY(${box.top - navBox.top}px)`, height: box.height + 'px' }],
        { duration: 420, easing: ease.out });
    }
  }
}

function buildResizer(side) {
  const grip = el('div', { class: 'side-resize', title: 'Drag to resize' });
  side.appendChild(grip);
  const stored = parseInt(localStorage.getItem('sonora:sidebar') || '0', 10);
  if (stored) document.documentElement.style.setProperty('--sidebar-w', clamp(stored, 190, 380) + 'px');

  let startX = 0, startW = 0;
  grip.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = side.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!startX) return;
    const w = clamp(startW + (e.clientX - startX), 190, 380);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  });
  const stop = () => {
    if (!startX) return;
    startX = 0;
    document.body.classList.remove('resizing');
    localStorage.setItem('sonora:sidebar',
      String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)));
    paintNav(parseHash());
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

/* ------------------------------------------------------------------ topbar */

function buildTopbar() {
  const bar = $('#topbar');

  const back = el('button', { class: 'icon-btn nav-back', title: 'Back', 'aria-label': 'Back', html: ico('chev-left'), onclick: () => history.back() });
  const fwd = el('button', { class: 'icon-btn nav-fwd', title: 'Forward', 'aria-label': 'Forward', html: ico('chev-right'), onclick: () => history.forward() });

  const input = el('input', {
    class: 'search-input', type: 'search', id: 'search',
    placeholder: 'Search songs, albums, artists', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Search library',
  });
  const search = el('div', { class: 'search' }, el('span', { class: 'search-ico', html: ico('search') }), input);

  const run = debounce(() => {
    const q = input.value.trim();
    if (!q) { if (parseHash().name === 'search') location.hash = '#/home'; return; }
    const next = '#/search/' + encodeURIComponent(q);
    if (location.hash !== next) {
      if (parseHash().name === 'search') history.replaceState(null, '', next), navigate();
      else location.hash = next;
    }
  }, 160);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; input.blur(); if (parseHash().name === 'search') location.hash = '#/home'; }
  });

  const progress = el('div', { class: 'scan', hidden: true },
    el('span', { class: 'scan-spinner' }),
    el('span', { class: 'scan-text' }));

  const addBtn = el('button', {
    class: 'btn ghost sm topbar-add', html: ico('plus') + '<span>Add music</span>',
    onclick: (e) => addMusicMenu(e.currentTarget),
  });

  // Announced rather than shown only: a reconnect that failed is the kind of
  // thing a screen reader has to be told about, and politely is the right
  // volume for it — it interrupts nothing.
  const link = el('div', {
    class: 'link-state', id: 'link-state', hidden: true,
    role: 'status', 'aria-live': 'polite',
  }, el('span', { class: 'link-dot' }), el('span', { class: 'link-text' }));

  const tag = el('div', { class: 'route-tag', id: 'route-tag' });
  bar.append(el('div', { class: 'topbar-nav' }, back, fwd), tag, search, link, progress, addBtn);

  // The connection readout: visible while reconnecting, and afterwards only if
  // something needs saying.
  session.events.on('phase', (st) => {
    const label = {
      connecting: 'Reconnecting', resumed: 'Resumed', ready: st.message || 'Ready',
      failed: st.message || 'Not connected', off: 'Disconnected', idle: '',
    }[st.phase] || '';
    link.dataset.phase = st.phase;
    link.querySelector('.link-text').textContent = label;
    link.hidden = !label || st.phase === 'idle';
    if (st.phase === 'resumed' || st.phase === 'ready') {
      setTimeout(() => { if (link.dataset.phase === st.phase) link.hidden = true; }, 4000);
    }
  });

  lib.events.on('progress', ({ done, total }) => {
    progress.hidden = false;
    progress.querySelector('.scan-text').textContent =
      total ? `Reading ${done.toLocaleString()} of ${total.toLocaleString()}` : 'Scanning…';
  });
  lib.events.on('scan', (on, report) => {
    if (on) { progress.hidden = false; progress.querySelector('.scan-text').textContent = 'Scanning…'; }
    else {
      progress.querySelector('.scan-text').textContent = 'Done';
      setTimeout(() => { progress.hidden = true; }, 1400);
      announceImport(report);
    }
  });
}

/** The readout in the corner of the instrument: SONORA / ALBUMS. */
function paintRouteTag(route) {
  const tag = $('#route-tag');
  if (!tag) return;
  tag.innerHTML = '';
  tag.append('SONORA \u2009/\u2009 ');
  tag.appendChild(el('b', { text: routeLabel(route).toUpperCase() }));
}

/**
 * What the import did, said once. Album merging is invisible by design — the
 * point is that tracks from four folders end up as one record — so the one
 * moment it is worth mentioning is right after it happens.
 */
function announceImport(report) {
  if (!report || !report.added) return;
  /* Now there is something worth keeping, ask the browser to keep it. Not at
     boot: an empty index is nothing to protect and Firefox would be prompting
     before the app had shown what it is for. Once only — `requestPersist`
     short-circuits when the grant already exists — and silently, because the
     answer belongs in Settings rather than in the way. */
  db.requestPersist().catch(() => {});
  const merged = report.merged || [];
  if (merged.length) {
    const names = merged.slice(0, 2).map((a) => `“${a.title}”`).join(', ');
    const more = merged.length > 2 ? ` and ${merged.length - 2} more` : '';
    toast(`Added ${report.added.toLocaleString()} tracks · merged ${names}${more}`, {
      duration: 5200,
      action: merged.length === 1
        ? { label: 'Open', onSelect: () => (location.hash = '#/album/' + merged[0].key) }
        : null,
    });
  } else {
    toast(`Added ${report.added.toLocaleString()} ${report.added === 1 ? 'track' : 'tracks'}`);
  }
}

function syncSearchInput(route) {
  const input = $('#search');
  if (!input) return;
  if (route.name === 'search' && input.value !== route.arg) input.value = route.arg;
  if (route.name !== 'search' && document.activeElement !== input) input.value = '';
}

/* ------------------------------------------------------------------ ingestion */

let fileInput = null;
let looseInput = null;

/**
 * "Add music" is two things — a folder, or a handful of files — and which one
 * someone wants is not knowable in advance, so ask.
 *
 * Both routes exist in every browser, whichever pickers it has: a folder goes
 * through showDirectoryPicker or an input with `webkitdirectory`, and files go
 * through showOpenFilePicker or a plain multiple input. So the choice is always
 * offered; only the machinery underneath differs.
 */
function addMusicMenu(anchor) {
  menu([
    { label: 'Add a folder…', icon: 'folder', onSelect: addMusic },
    { label: 'Add files…', icon: 'file', hint: 'Merged by album', onSelect: addLooseFiles },
  ], { anchor });
}

/** Individual files, from anywhere; albums are reassembled on the way in. */
async function addLooseFiles() {
  if (lib.canPickFiles()) {
    const root = await lib.addFiles();
    if (!root) return;
    return;
  }
  if (!looseInput) {
    looseInput = el('input', { type: 'file', multiple: true, accept: acceptAttr(), style: { display: 'none' } });
    looseInput.addEventListener('change', async () => {
      if (!looseInput.files.length) return;
      const root = await lib.addFileList(looseInput.files, 'Selected files');
      if (!root) toast('No audio files in that selection');
      looseInput.value = '';
    });
    document.body.appendChild(looseInput);
  }
  looseInput.click();
}

async function addMusic() {
  if (lib.canPickDirectory()) {
    const root = await lib.addDirectory();
    if (root) toast(`Added ${root.name}`);
    return;
  }
  if (!fileInput) {
    fileInput = el('input', { type: 'file', multiple: true, accept: acceptAttr(), style: { display: 'none' } });
    fileInput.setAttribute('webkitdirectory', '');
    fileInput.setAttribute('directory', '');
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files.length) return;
      const root = await lib.addFileList(fileInput.files);
      if (root) toast(`Added ${root.name}`);
      else toast('No audio files found in that folder');
      fileInput.value = '';
    });
    document.body.appendChild(fileInput);
  }
  fileInput.click();
}

/**
 * Without the File System Access API a browser cannot hand the same folder back
 * on the next visit, so the library survives but the files are out of reach
 * until the user re-picks the folder. Say so plainly instead of showing a page
 * of tracks that silently refuse to play.
 */
function buildReconnectNotice() {
  const notice = el('div', { class: 'notice', hidden: true },
    el('span', { class: 'notice-ico', html: ico('folder') }),
    el('div', { class: 'notice-text' },
      el('strong', { class: 'notice-title' }),
      el('span', { class: 'notice-sub' })),
    el('button', { class: 'btn primary sm', text: 'Reconnect', onclick: addMusic }),
    el('button', {
      class: 'icon-btn', 'aria-label': 'Dismiss', html: ico('close'),
      onclick: () => { dismissed = true; notice.hidden = true; },
    }));

  let dismissed = false;
  const main = document.querySelector('.main');
  main.insertBefore(notice, $('#view'));

  const sync = () => {
    const stale = lib.state.roots.filter((r) => r.needsReconnect || r.needsPermission);
    const show = !dismissed && stale.length > 0 && lib.trackCount() > 0;
    if (show === !notice.hidden) return;
    notice.hidden = !show;
    if (!show) return;
    const names = stale.map((r) => r.name).join(', ');
    notice.querySelector('.notice-title').textContent =
      stale.length === 1 ? `Reconnect “${names}”` : `Reconnect ${stale.length} folders`;
    notice.querySelector('.notice-sub').textContent = stale[0].needsPermission
      ? 'Your browser needs permission again before it can read these files.'
      : 'Your library is remembered, but this browser has to be pointed at the folder again to play from it.';
    animate(notice, { opacity: [0, 1], transform: ['translateY(-6px)', 'none'] },
            { duration: 320, easing: ease.out });
  };

  lib.events.on('roots', sync);
  lib.events.on('ready', sync);
  return sync;
}

function buildDropZone() {
  const overlay = el('div', { class: 'dropzone', hidden: true },
    el('div', { class: 'dropzone-card' },
      el('div', { class: 'dropzone-ico', html: ico('folder') }),
      el('h3', { text: 'Drop to add' }),
      el('p', { text: 'Folders and audio files are read straight from disk' })));
  document.body.appendChild(overlay);

  let depth = 0;
  const show = () => { if (overlay.hidden) { overlay.hidden = false; animate(overlay, { opacity: [0, 1] }, { duration: 160 }); } };
  const hide = () => { depth = 0; overlay.hidden = true; };

  addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    depth++; show();
  });
  addEventListener('dragover', (e) => { if (!overlay.hidden) e.preventDefault(); });
  addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  addEventListener('drop', async (e) => {
    if (overlay.hidden) return;
    e.preventDefault();
    hide();
    const root = await lib.addDataTransfer(e.dataTransfer);
    if (root) toast(`Added ${root.name}`);
    else toast('No audio files in that drop');
  });
}

/* ------------------------------------------------------------------ theme */

/* The theme is one setting inside the look, so it goes through the same door
   as the hue and the corner style rather than having its own. */
const applyTheme = (value) => looks.set('theme', value);

/**
 * Two colours, deliberately separate.
 *
 * `--accent-rgb` is the instrument's own cyan and never moves: it is what
 * points at things, and an interface whose pointing colour changes every three
 * minutes is an interface you cannot learn. `--art-rgb` is the colour of the
 * album that is playing, and it is only ever used next to that album's
 * artwork — the hero wash, the sleeve glow, the far end of a gradient.
 *
 * The transition is eased in CSS by whatever reads it; here we only set it.
 */
function applyAccent() {
  const on = localStorage.getItem('sonora:accent') !== '0';
  const track = player.state.current;
  const rgb = on && track ? lib.accentFor(track.albumKey) : null;
  const brand = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-rgb').trim() || '0 209 255';
  document.documentElement.style.setProperty('--art-rgb', rgb ? rgb.join(' ') : brand);
}

/* ------------------------------------------------------------------ shortcuts */

/**
 * Every key the app answers to, written down once.
 *
 * `bindKeys` and the sheet that `?` opens read the same table, so a shortcut
 * cannot exist without being documented and cannot be documented without
 * existing — which is the failure mode of every keyboard list ever written in
 * a settings page by hand.
 */
/*
 * Every shortcut in the application, registered once.
 *
 * This used to be two lists — a `switch` that did the work and a separate array
 * that drew the overlay — and the README said outright that they were not the
 * same list and could not be kept in step by hand. They had already drifted:
 * ⌘Y ran redo and appeared in neither the overlay nor the documentation.
 *
 * Order is priority, and two pairs here depend on it. "?" is registered before
 * "/" because Shift is held to type it on most layouts and arrives as Shift+"/"
 * on the rest, which is the same physical key as search. And Redo is registered
 * before Undo so that ⌘⇧Z is not swallowed by the ⌘Z that would otherwise
 * match it first.
 */
function registerKeys() {
  const K = keys.bind;

  K({ id: 'play', group: 'Playback', combo: 'Space', label: 'Play or pause',
      run: () => { player.toggle(); } });
  K({ id: 'seek-fwd', group: 'Playback', combo: 'ArrowRight', label: 'Seek 5 seconds',
      display: ['←', '→'], note: ['⇧', '←/→', 'Seek 30 seconds'],
      run: (e) => { player.seek(player.state.time + (e.shiftKey ? 30 : 5)); } });
  K({ id: 'seek-back', group: 'Playback', combo: 'ArrowLeft', label: 'Seek back 5 seconds', hidden: true,
      run: (e) => { player.seek(player.state.time - (e.shiftKey ? 30 : 5)); } });
  K({ id: 'volume-up', group: 'Playback', combo: 'ArrowUp', label: 'Volume', display: ['↑', '↓'],
      run: () => { player.setVolume(player.state.volume + 0.05); } });
  K({ id: 'volume-down', group: 'Playback', combo: 'ArrowDown', label: 'Volume down', hidden: true,
      run: () => { player.setVolume(player.state.volume - 0.05); } });
  K({ id: 'next', group: 'Playback', combo: 'N', label: 'Next track',
      run: () => { player.next(false); } });
  K({ id: 'prev', group: 'Playback', combo: 'P', label: 'Previous, or restart the track',
      run: () => { player.prev(); } });
  K({ id: 'mute', group: 'Playback', combo: 'M', label: 'Mute',
      run: () => { player.toggleMute(); } });
  K({ id: 'shuffle', group: 'Playback', combo: 'S', label: 'Shuffle',
      run: () => { player.setShuffle(); toast(player.state.shuffle ? 'Shuffle on' : 'Shuffle off'); } });
  K({ id: 'repeat', group: 'Playback', combo: 'R', label: 'Repeat: off, all, one',
      run: () => { player.cycleRepeat(); toast('Repeat: ' + player.state.repeat); } });
  K({ id: 'favourite', group: 'Playback', combo: 'F', label: 'Favourite what is playing',
      run: () => {
        const track = player.state.current;
        if (!track) { toast('Nothing playing to favourite'); return; }
        toast(lib.toggleFavourite(track.id)
          ? `Favourited “${track.title}”`
          : `Removed “${track.title}” from favourites`);
      } });

  // Before search: the same physical key produces both on a lot of layouts.
  K({ id: 'shortcuts', group: 'Getting around', combo: ['?', 'Shift+/'], label: 'This list',
      run: () => { showShortcuts(); } });
  K({ id: 'search', group: 'Getting around', combo: '/', label: 'Search the library',
      run: () => { $('#search')?.focus(); } });
  /* The palette, not the search field. Cmd-K means "let me type what I want"
     everywhere else, and Sonora has forty actions that were previously only
     reachable by knowing where they lived. */
  K({ id: 'palette', group: 'Getting around', combo: 'Mod+K', label: 'Everything, by name',
      run: () => { togglePalette(); } });
  K({ id: 'queue', group: 'Getting around', combo: 'Q', label: 'Queue panel',
      run: () => { toggleQueuePane(); } });
  K({ id: 'stage', group: 'Getting around', combo: 'V', label: 'Immersive visualiser',
      run: () => { toggleStage(backdrop); } });
  K({ id: 'sound', group: 'Getting around', combo: 'E', label: 'The Sound page',
      run: () => { location.hash = '#/sound'; } });
  K({ id: 'escape', group: 'Getting around', combo: 'Escape', label: 'Close whatever is open',
      passive: true });

  /* Redo first, so ⌘⇧Z is not taken by the ⌘Z below it. Neither fires while a
     text field has the caret — inside the edit dialog ⌘Z has to mean "undo what
     I just typed", which is the browser's job and not ours. */
  /* `alt` prints the second spelling in the overlay. ⌘Y is here because Windows
     users reach for it, and it is *shown* because a working shortcut nobody has
     written down is exactly the drift this table exists to stop — it was in the
     handler and in neither list for two releases. "?" carries no `alt`, because
     its second form is Shift and the same physical key, which is how you type a
     question mark rather than a different shortcut. */
  K({ id: 'redo', group: 'The library', combo: ['Mod+Shift+Z', 'Mod+Y'], label: 'Redo it',
      alt: 'Mod+Y', run: () => { runUndo(true); } });
  K({ id: 'undo', group: 'The library', combo: 'Mod+Z', label: 'Undo the last change',
      run: () => { runUndo(false); } });

  // A/B the whole rack from anywhere: the only way to hear what an equaliser is
  // actually doing is to take it out and put it back.
  K({ id: 'bypass', group: 'Sound', combo: 'B', label: 'Bypass the rack — A/B it',
      run: () => {
        rack.set({ on: !rack.state.on });
        toast(rack.state.on ? 'Rack in' : 'Rack bypassed');
      } });
}

let shortcutSheet = null;

function showShortcuts() {
  if (shortcutSheet) { shortcutSheet.close(); shortcutSheet = null; return; }
  const body = el('div', { class: 'keys' });
  /* Rendered from the same table the handler dispatches from, so a shortcut
     cannot exist without appearing here and cannot appear here without
     existing. */
  for (const [group, rows] of keys.groups()) {
    const table = el('dl', { class: 'keys-list' });
    for (const b of rows) {
      table.appendChild(el('dt', {}, (b.display || keys.caps(b.combo)).map((k) => el('kbd', { text: k }))));
      table.appendChild(el('dd', { text: b.label }));
      if (b.alt) {
        table.appendChild(el('dt', {}, keys.caps(b.alt).map((k) => el('kbd', { text: k }))));
        table.appendChild(el('dd', { class: 'keys-alt', text: b.label }));
      }
      if (b.note) {
        table.appendChild(el('dt', {}, b.note.slice(0, -1).map((k) => el('kbd', { text: k }))));
        table.appendChild(el('dd', { text: b.note[b.note.length - 1] }));
      }
    }
    body.appendChild(el('section', { class: 'keys-col' },
      el('h3', { class: 'keys-group', text: group }), table));
  }
  shortcutSheet = dialog({
    title: 'Keyboard',
    body,
    width: 640,
    actions: [{ label: 'Close', primary: true }],
    onClose: () => { shortcutSheet = null; },
  });
}

/**
 * Runs one step of the undo stack and says what happened.
 *
 * The interesting case is the third one. An entry can outlive what it
 * describes — correct a track, remove the folder it came from, then undo — and
 * the honest answer is that nothing was put back. Saying "Undone" there would
 * be a lie that teaches you to stop reading the confirmation, so the toast
 * reports the miss instead. The entry still moves to the redo side, because a
 * stack you cannot walk past is worse than one with a dud step in it.
 */
async function runUndo(redo) {
  const label = redo ? undoStack.nextRedo() : undoStack.nextUndo();
  if (!label) { toast(redo ? 'Nothing to redo' : 'Nothing to undo'); return; }
  const done = redo ? await undoStack.redo() : await undoStack.undo();
  if (!done) return;
  if (done.error) toast(`Could not ${redo ? 'redo' : 'undo'} ${done.label}`);
  else if (!done.touched) toast(`${done.label} is no longer here to change`);
  else toast(`${redo ? 'Redid' : 'Undid'} ${done.label}`);
}

function bindKeys() {
  registerKeys();
  addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    /* The dispatcher does not preventDefault — deciding whether the browser
       keeps a keystroke is this layer's business, not the table's. Everything
       matched here is claimed, because every one of them means something in the
       application that it should not also mean in the page. */
    if (keys.dispatch(e, { typing })) e.preventDefault();
  });
}

/* ------------------------------------------------------------------ right pane */

let queueApi = null;

function toggleQueuePane(force) {
  const app = $('#app');
  const open = force === undefined ? !app.classList.contains('pane-open') : force;
  app.classList.toggle('pane-open', open);
  localStorage.setItem('sonora:pane', open ? '1' : '0');
  if (open) {
    const pane = $('#pane');
    animate(pane, { opacity: [0, 1], transform: ['translateX(16px)', 'none'] }, { duration: 300, easing: ease.out });
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  // Before anything is measured or painted by a module: the look decides the
  // hue, the corners, the density and the text size, and half of those change
  // layout.
  looks.init();


  // The intro is already on screen (it ships in the HTML); this starts its
  // timeline and hands back a promise for the earliest moment it may leave.
  const intro = startIntro();
  mountAppBackdrop();

  buildSidebar();
  buildTopbar();
  buildDropZone();
  const syncNotice = buildReconnectNotice();
  bindKeys();

  mountPlayerBar($('#playerbar'));
  queueApi = mountQueue($('#pane'));
  if (localStorage.getItem('sonora:pane') === '1') $('#app').classList.add('pane-open');

  document.addEventListener('sonora:add', addMusic);
  document.addEventListener('sonora:shortcuts', showShortcuts);
  /* The palette dispatches rather than calling: it is loaded before the shell
     is built, and holding references to functions that do not exist yet is how
     a module graph acquires a cycle. */
  document.addEventListener('sonora:add-music', () => addMusicMenu($('.add-btn')));
  document.addEventListener('sonora:bypass', () => {
    rack.set({ on: !rack.state.on });
    toast(rack.state.on ? 'Rack in circuit' : 'Rack bypassed');
  });
  document.addEventListener('sonora:toggle-queue', () => toggleQueuePane());
  document.addEventListener('sonora:undo', () => runUndo(false));
  document.addEventListener('sonora:redo', () => runUndo(true));
  document.addEventListener('sonora:theme', (e) => applyTheme(e.detail));
  document.addEventListener('sonora:stage', () => toggleStage(backdrop));
  document.addEventListener('sonora:setting', (e) => {
    if (e.detail.name === 'accent') applyAccent();
    if (e.detail.name === 'backdrop') backdrop?.setEnabled(e.detail.value);
  });
  // A look can change the accent, which the artwork tint falls back to, and
  // it can turn the world off entirely.
  looks.events.on('change', () => {
    applyAccent();
    backdrop?.setLook?.(looks.state);
    backdrop?.setEnabled(localStorage.getItem('sonora:backdrop') !== '0' && looks.state.scene !== 'off');
  });
  document.addEventListener('sonora:disconnect', () => {
    session.disconnect();
    toast('Disconnected — nothing will reconnect on launch until you turn it back on');
  });
  document.addEventListener('sonora:reconnect', () => {
    session.reconnect(toast).then((outcome) => {
      if (outcome === 'none') toast('Nothing to reconnect to yet');
    });
  });

  addEventListener('hashchange', navigate);
  document.addEventListener('sonora:refresh', () => navigate());

  // Hairline under the top bar, but only once the page has actually moved.
  const view = $('#view');
  const main = document.querySelector('.main');
  view.addEventListener('scroll', () => {
    main.classList.toggle('is-scrolled', view.scrollTop > 4);
  }, { passive: true });

  player.events.on('track', applyAccent);
  /* A record that carries its own rack gets it here, on `settled` rather than
     on `track`: both decks feed one chain, and swapping the chain while a
     crossfade is still running would put the incoming record's EQ on the tail
     of the one going out. `settled` fires when only one deck is making sound. */
  player.events.on('settled', async (t) => {
    const did = await rack.followTrack(t).catch(() => null);
    if (did?.applied) toast(`Rack for “${did.label}”`);
    else if (did?.released) toast('Back to your rack');
  });
  /* Q10: a long recording picks up where it was left, and says so. Silently
     starting an hour in would look like a bug to anybody who wanted the top,
     so the resume is announced and is undone by one press. */
  player.events.on('resumed', ({ track, at }) => toast(`Picked up at ${fmtTime(at)}`, {
    duration: 6000,
    action: {
      label: 'Start over',
      onSelect: () => { player.clearLongMark(track.id); player.seek(0); },
    },
  }));

  player.events.on('unavailable', (t) => toast(`Can't reach “${t.title}” — reconnect its folder`, {
    action: { label: 'Settings', onSelect: () => (location.hash = '#/settings') },
  }));
  player.events.on('error', (t) => toast(t.undecodable
    ? `This browser can't decode ${formatName(t.name || '')} — “${t.title}” was skipped`
    : `Couldn't play “${t.title}”`, { duration: 4200 }));
  player.events.on('unsupported', (t) => toast(
    `No browser decodes ${formatName(t.name || '')} — “${t.title}” was skipped`, { duration: 4200 }));
  lib.events.on('art', applyAccent);

  await player.init();
  intro.report('AUDIO GRAPH OK');
  await lib.init();
  // Real numbers, printed at the moment they are known. An empty library says
  // so rather than being given a figure to make the boot look busier.
  intro.report(lib.trackCount()
    ? `${lib.trackCount().toLocaleString()} TRACKS · ${lib.state.albums.length.toLocaleString()} ALBUMS`
    : 'NO LIBRARY YET');
  await stats.init();
  intro.report(lib.serial);

  navigate();
  syncNotice();

  // Everything below is about the previous session: remember this one as it
  // happens, then put the last one back.
  session.watch();
  session.restore(toast).then((outcome) => {
    if (outcome === 'resumed' || outcome === 'ready') applyAccent();
  });

  /* Hold the analysis cache to its documented size.
   *
   * `peaks.trim()` has always known what the bound was — four thousand records,
   * about a hundred megabytes — and nothing ever called it, so the store grew
   * by roughly 28 KB for every track ever played and never gave any of it back.
   * Once per launch, on idle, is the right cadence: it is a slow scan and
   * nothing depends on its result. */
  idle(() => {
    peakmap.trim().then((dropped) => {
      if (dropped) console.info(`[sonora] analysis cache: dropped ${dropped} old records`);
    }).catch(() => {});
  }, 8000);

  /* Offline, last of all.
   *
   * Deliberately after everything else has started: registering a service
   * worker sets it fetching the whole shell, and doing that during boot means
   * competing with the very files it is trying to cache. The one thing this
   * must not do is make the first launch slower. */
  setTimeout(() => { startOffline(); }, 2500);

  /* The printed cover gets somewhere to catch the light. One delegated
     controller for the whole page — see relief.js for why it is not one per
     sleeve. */
  startRelief();

  /* Device tilt, where it was left switched on.
   *
   * Only restored where the platform hands orientation over without asking.
   * iOS wants a real gesture for it, and a permission prompt fired at somebody
   * who has just opened a music player is how that permission gets denied
   * permanently — there, the switch in Settings is the gesture. */
  try {
    if (localStorage.getItem('sonora:tilt') === '1' && !deviceTiltNeedsPermission()) {
      startDeviceTilt();
    }
  } catch { /* private mode */ }

  // Re-render list pages when the library changes underneath them. Deferred to
  // the next frame so we never rebuild the view from inside the emit that
  // triggered it, and skipped when the listener is in the middle of something:
  // scrolled away from the top, or part-way through picking a set of tracks.
  // Both are work in progress, and a repaint throws both of them away.
  let repaintQueued = false;
  lib.events.on('change', () => {
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      repaintQueued = false;
      const route = parseHash();
      if (['home', 'albums', 'artists', 'songs'].includes(route.name) &&
          $('#view').scrollTop < 40 && !hasLiveSelection()) {
        navigate();
      }
    });
  });

  // The library is painted and the routes are live; now wait for the intro to
  // finish saying hello (it may already have been skipped) and hand over.
  await intro.ready;
  document.body.classList.add('is-ready');
  await intro.dismiss();
  animate($('#app'), { opacity: [0, 1], transform: ['scale(.985)', 'none'] },
          { duration: 620, easing: ease.out });
}

/* ------------------------------------------------------------------ backdrop */

let backdrop = null;

function mountAppBackdrop() {
  const on = localStorage.getItem('sonora:backdrop') !== '0' && looks.state.scene !== 'off';
  backdrop = mountBackdrop(document.body, { enabled: on });
  backdrop.setLook?.(looks.state);
  if (!backdrop.supported) {
    // No WebGL: the CSS gradients underneath are the whole design, and they
    // were always there.
    document.documentElement.classList.add('no-backdrop');
    return;
  }
  backdrop.setEnabled(on);

  // While files are being imported the main thread has better things to do
  // than draw a room, and the worker's throughput is what the person is
  // actually waiting on. The world holds still until the scan finishes.
  lib.events.on('scan', (scanning) => {
    if (localStorage.getItem('sonora:backdrop') === '0') return;
    backdrop.setEnabled(!scanning);
  });

  // Nothing to draw over while the stage is closing, and nothing to draw at
  // all in a background tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) backdrop.setIntensity(stageOpen() ? 1.9 : 1);
  });
}


if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();
