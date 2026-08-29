/* app.js — shell: routing, navigation, search, shortcuts, theming, ingestion. */

import { $, el, ico, debounce, clamp, acceptAttr, formatName } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { renderView } from './views.js';
import { mountPlayerBar } from './playerbar.js';
import { mountQueue } from './queue.js';
import { toast, closeMenu, promptDialog } from './ui.js';
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
  { route: 'playlists', label: 'Playlists', icon: 'playlist' },
];

/** What the top-bar readout says for a given route. */
function routeLabel(route) {
  if (route.name === 'album') return 'Album';
  if (route.name === 'artist') return 'Artist';
  if (route.name === 'playlist') return 'Playlist';
  if (route.name === 'search') return 'Search';
  if (route.name === 'settings') return 'Settings';
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

function navigate() {
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

function titleFor(route) {
  const base = 'Sonora';
  if (route.name === 'album') return (lib.state.albumBy.get(route.arg)?.title || 'Album') + ' · ' + base;
  if (route.name === 'artist') return (lib.state.artistBy.get(route.arg)?.name || 'Artist') + ' · ' + base;
  if (route.name === 'search') return route.arg ? `“${route.arg}” · ${base}` : base;
  const nav = NAV.find((n) => n.route === route.name);
  return nav ? `${nav.label} · ${base}` : base;
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
    el('button', { class: 'btn add-btn', html: ico('plus') + '<span>Add music</span>', onclick: addMusic }),
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

  const addBtn = el('button', { class: 'btn ghost sm topbar-add', html: ico('plus') + '<span>Add music</span>', onclick: addMusic });

  const tag = el('div', { class: 'route-tag', id: 'route-tag' });
  bar.append(el('div', { class: 'topbar-nav' }, back, fwd), tag, search, progress, addBtn);

  lib.events.on('progress', ({ done, total }) => {
    progress.hidden = false;
    progress.querySelector('.scan-text').textContent =
      total ? `Reading ${done.toLocaleString()} of ${total.toLocaleString()}` : 'Scanning…';
  });
  lib.events.on('scan', (on) => {
    if (on) { progress.hidden = false; progress.querySelector('.scan-text').textContent = 'Scanning…'; }
    else {
      progress.querySelector('.scan-text').textContent = 'Done';
      setTimeout(() => { progress.hidden = true; }, 1400);
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

function syncSearchInput(route) {
  const input = $('#search');
  if (!input) return;
  if (route.name === 'search' && input.value !== route.arg) input.value = route.arg;
  if (route.name !== 'search' && document.activeElement !== input) input.value = '';
}

/* ------------------------------------------------------------------ ingestion */

let fileInput = null;

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

function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
  localStorage.setItem('sonora:theme', value);
}

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

function bindKeys() {
  addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

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
      case 'q': case 'Q': toggleQueuePane(); break;
      case 'v': case 'V': toggleStage(backdrop); break;
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
  applyTheme(localStorage.getItem('sonora:theme') || 'system');

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
  document.addEventListener('sonora:toggle-queue', () => toggleQueuePane());
  document.addEventListener('sonora:theme', (e) => applyTheme(e.detail));
  document.addEventListener('sonora:stage', () => toggleStage(backdrop));
  document.addEventListener('sonora:setting', (e) => {
    if (e.detail.name === 'accent') applyAccent();
    if (e.detail.name === 'backdrop') backdrop?.setEnabled(e.detail.value);
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

  navigate();
  syncNotice();

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
  const on = localStorage.getItem('sonora:backdrop') !== '0';
  backdrop = mountBackdrop(document.body, { enabled: on });
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
