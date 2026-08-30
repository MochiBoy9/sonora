/* app.js — shell: routing, navigation, search, shortcuts, theming, ingestion. */

import { $, el, ico, debounce, clamp, acceptAttr, formatName } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { renderView } from './views.js';
import { mountPlayerBar } from './playerbar.js';
import { mountQueue } from './queue.js';
import { toast, closeMenu, promptDialog, menu, dialog } from './ui.js';
import * as session from './session.js';
import * as stats from './stats.js';
import * as looks from './looks.js';
import * as rack from './audio.js';
import { animate, ease, reduceMotion } from './motion.js';
import { startIntro } from './intro.js';
import { mountBackdrop } from './backdrop.js';
import { toggleStage, isOpen as stageOpen } from './stage.js';

/* Destinations are numbered, like channels on a desk — the number is part of
   how you learn where things are, not decoration. */
const NAV = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'songs', label: 'Songs', icon: 'music' },
  { route: 'albums', label: 'Albums', icon: 'album' },
  { route: 'artists', label: 'Artists', icon: 'artist' },
  { route: 'favourites', label: 'Favourites', icon: 'star' },
  { route: 'playlists', label: 'Playlists', icon: 'playlist' },
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
  host.scrollTop = 0;

  teardown = renderView(host, route);
  paintNav(route);
  paintRouteTag(route);
  syncSearchInput(route);

  const remembered = scrollMemory.get(currentHash);
  if (remembered) requestAnimationFrame(() => { host.scrollTop = remembered; });

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
function navigate() {
  const paired = document.querySelector('[style*="view-transition-name"]');
  if (!document.startViewTransition || reduceMotion.matches) {
    clearTransitionMarks();
    return swapView();
  }
  document.documentElement.classList.toggle('vt-paired', !!paired);
  const vt = document.startViewTransition(() => swapView());
  // Marks are per-navigation. Left in place they would collide with the next
  // one, and two elements sharing a view-transition-name is a transition the
  // browser refuses to run at all.
  vt.finished.finally(() => {
    clearTransitionMarks();
    document.documentElement.classList.remove('vt-paired');
  });
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
      class: 'icon-btn ghost sm', title: 'New playlist', html: ico('plus'),
      onclick: () => {
        promptDialog({
          title: 'New playlist', label: 'Name', value: 'My playlist', confirm: 'Create',
          onConfirm: async (name) => { if (name) { const p = await lib.createPlaylist(name); location.hash = '#/playlist/' + p.id; } },
        });
      },
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
      playlists.appendChild(el('a', {
        class: 'side-playlist', href: '#/playlist/' + p.id, data: { route: 'playlist:' + p.id },
      },
        el('span', { class: 'side-playlist-name', text: p.name }),
        el('span', { class: 'side-playlist-count', text: String(p.tracks.length) })));
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
const SHORTCUTS = [
  ['Playback', [
    [['Space'], 'Play or pause'],
    [['←', '→'], 'Seek 5 seconds'],
    [['⇧', '←/→'], 'Seek 30 seconds'],
    [['↑', '↓'], 'Volume'],
    [['N'], 'Next track'],
    [['P'], 'Previous, or restart the track'],
    [['M'], 'Mute'],
    [['S'], 'Shuffle'],
    [['R'], 'Repeat: off, all, one'],
    [['F'], 'Favourite what is playing'],
  ]],
  ['Getting around', [
    [['/'], 'Search'],
    [['⌘', 'K'], 'Search'],
    [['Q'], 'Queue panel'],
    [['V'], 'Immersive visualiser'],
    [['E'], 'The Sound page'],
    [['?'], 'This list'],
    [['Esc'], 'Close whatever is open'],
  ]],
  ['Sound', [
    [['B'], 'Bypass the rack — A/B it'],
  ]],
];

let shortcutSheet = null;

function showShortcuts() {
  if (shortcutSheet) { shortcutSheet.close(); shortcutSheet = null; return; }
  const body = el('div', { class: 'keys' });
  for (const [group, rows] of SHORTCUTS) {
    const table = el('dl', { class: 'keys-list' });
    for (const [keys, what] of rows) {
      table.appendChild(el('dt', {}, keys.map((k) => el('kbd', { text: k }))));
      table.appendChild(el('dd', { text: what }));
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

function bindKeys() {
  addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    // "?" first, and before the modifier gate below: Shift is held to type it
    // on most layouts, and on the ones that report the unshifted key instead
    // it arrives as Shift+"/" — which is the same physical key as search, so
    // this has to be settled before "/" claims it.
    if (!typing && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
      e.preventDefault(); showShortcuts(); return;
    }
    if (e.key === '/' && !typing) { e.preventDefault(); $('#search')?.focus(); return; }
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#search')?.focus(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ': e.preventDefault(); player.toggle(); break;
      case 'ArrowRight': e.preventDefault(); player.seek(player.state.time + (e.shiftKey ? 30 : 5)); break;
      case 'ArrowLeft': e.preventDefault(); player.seek(player.state.time - (e.shiftKey ? 30 : 5)); break;
      case 'ArrowUp': e.preventDefault(); player.setVolume(player.state.volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); player.setVolume(player.state.volume - 0.05); break;
      case 'n': case 'N': player.next(false); break;
      case 'p': case 'P': player.prev(); break;
      case 's': case 'S': player.setShuffle(); toast(player.state.shuffle ? 'Shuffle on' : 'Shuffle off'); break;
      case 'r': case 'R': player.cycleRepeat(); toast('Repeat: ' + player.state.repeat); break;
      case 'm': case 'M': player.toggleMute(); break;
      case 'f': case 'F': {
        const track = player.state.current;
        if (!track) { toast('Nothing playing to favourite'); break; }
        toast(lib.toggleFavourite(track.id)
          ? `Favourited “${track.title}”`
          : `Removed “${track.title}” from favourites`);
        break;
      }
      case 'q': case 'Q': toggleQueuePane(); break;
      case 'v': case 'V': toggleStage(backdrop); break;
      // A/B the whole rack from anywhere: the only way to hear what an
      // equaliser is actually doing is to take it out and put it back.
      case 'b': case 'B':
        rack.set({ on: !rack.state.on });
        toast(rack.state.on ? 'Rack in' : 'Rack bypassed');
        break;
      case 'e': case 'E': location.hash = '#/sound'; break;
      default: break;
    }
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
  document.addEventListener('sonora:toggle-queue', () => toggleQueuePane());
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
  await lib.init();
  await stats.init();

  navigate();
  syncNotice();

  // Everything below is about the previous session: remember this one as it
  // happens, then put the last one back.
  session.watch();
  session.restore(toast).then((outcome) => {
    if (outcome === 'resumed' || outcome === 'ready') applyAccent();
  });

  // Re-render list pages when the library changes underneath them. Deferred to
  // the next frame so we never rebuild the view from inside the emit that
  // triggered it, and skipped when the user has scrolled away from the top.
  let repaintQueued = false;
  lib.events.on('change', () => {
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      repaintQueued = false;
      const route = parseHash();
      if (['home', 'albums', 'artists', 'songs'].includes(route.name) && $('#view').scrollTop < 40) {
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
