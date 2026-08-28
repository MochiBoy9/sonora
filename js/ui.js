/* ui.js — shared widgets: artwork, track rows, menus, dialogs, toasts. */

import { el, ico, fmtTime, clamp } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { animate, ease, enter, spring } from './motion.js';

/* ------------------------------------------------------------------ artwork */

/**
 * Albums without embedded art still need to look intentional, so each one gets
 * a stable two-tone gradient derived from its key.
 */
export function placeholderStyle(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(140deg,
    hsl(${hue} 42% 34%) 0%,
    hsl(${(hue + 38) % 360} 36% 22%) 60%,
    hsl(${(hue + 70) % 360} 30% 16%) 100%)`;
}

/** Fills an <img> from the art cache — synchronously when it is already warm. */
export function paintArt(img, key) {
  img.dataset.key = key || '';
  const holder = img.parentNode;
  if (holder) holder.style.background = key ? placeholderStyle(key) : '';
  if (!key) { img.removeAttribute('src'); img.classList.remove('is-loaded'); return; }

  const cached = lib.artURL(key);
  if (cached) {
    if (img.getAttribute('src') !== cached) img.setAttribute('src', cached);
    img.classList.add('is-loaded');
    return;
  }
  img.removeAttribute('src');
  img.classList.remove('is-loaded');
  lib.loadArt(key).then((url) => {
    if (!url || img.dataset.key !== key) return;
    img.setAttribute('src', url);
    img.classList.add('is-loaded');
  });
}

export function artBox(key, size, cls = '') {
  const img = el('img', { class: 'art-img', alt: '', loading: 'lazy', decoding: 'async' });
  const box = el('div', {
    class: 'art ' + cls,
    style: size ? { width: size + 'px', height: size + 'px' } : null,
  }, img);
  paintArt(img, key);
  return box;
}

/* ------------------------------------------------------------------ eq bars */

export const eqMarkup = '<span class="eq"><i></i><i></i><i></i><i></i></span>';

/* ------------------------------------------------------------------ rows */

/**
 * One factory for every track list in the app. Rows are recycled by the
 * virtualiser, so render() only ever writes fields that changed.
 */
export function trackRowFactory({ columns = ['index', 'title', 'album', 'duration'], onPlay, onMenu }) {
  const create = () => {
    const row = el('div', { class: 'trow', role: 'row', tabindex: '-1' });
    let html = '';
    if (columns.includes('index')) html += '<div class="trow-index"><span class="n"></span>' + eqMarkup +
      `<button class="trow-play" title="Play" aria-label="Play">${ico('play')}</button></div>`;
    html += '<div class="trow-main">' +
      (columns.includes('art') ? '<div class="art art-sm"><img class="art-img" alt="" decoding="async"></div>' : '') +
      '<div class="trow-text"><div class="trow-title"></div><div class="trow-sub"></div></div></div>';
    if (columns.includes('album')) html += '<div class="trow-album"></div>';
    if (columns.includes('duration')) html += '<div class="trow-time"></div>';
    html += `<div class="trow-actions"><button class="icon-btn ghost trow-more" aria-label="More">${ico('more')}</button></div>`;
    row.innerHTML = html;

    row.addEventListener('dblclick', () => onPlay?.(parseInt(row.dataset.index, 10)));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.trow-play')) onPlay?.(parseInt(row.dataset.index, 10));
      else if (e.target.closest('.trow-more')) onMenu?.(parseInt(row.dataset.index, 10), e.target.closest('.trow-more'));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onMenu?.(parseInt(row.dataset.index, 10), null, e);
    });
    return row;
  };

  const render = (row, track, index) => {
    if (!track) return;
    const playing = player.state.current && player.state.current.id === track.id;
    row.classList.toggle('is-playing', !!playing);
    row.classList.toggle('is-missing', !lib.isAvailable(track.id));

    const idx = row.querySelector('.trow-index .n');
    if (idx) idx.textContent = index + 1;

    const art = row.querySelector('.art-img');
    if (art) paintArt(art, track.albumKey);

    const title = row.querySelector('.trow-title');
    if (title.textContent !== track.title) title.textContent = track.title;
    const sub = row.querySelector('.trow-sub');
    if (sub.textContent !== track.artist) sub.textContent = track.artist;

    const album = row.querySelector('.trow-album');
    if (album && album.textContent !== track.album) album.textContent = track.album;

    const time = row.querySelector('.trow-time');
    if (time) {
      const text = track.duration ? fmtTime(track.duration) : '--:--';
      if (time.textContent !== text) time.textContent = text;
    }
  };

  return { create, render };
}

/* ------------------------------------------------------------------ menus */

let openMenu = null;

export function closeMenu() {
  if (!openMenu) return;
  const node = openMenu;
  openMenu = null;
  animate(node, { opacity: [1, 0], transform: ['scale(1)', 'scale(.96)'] },
          { duration: 110, easing: 'ease-in', commit: false })
    .finished.then(() => node.remove()).catch(() => node.remove());
}

/**
 * Context menu anchored either to an element or to a pointer position, flipped
 * to stay on screen.
 */
export function menu(items, { anchor, event } = {}) {
  closeMenu();
  const node = el('div', { class: 'menu', role: 'menu' });

  for (const item of items) {
    if (!item) continue;
    if (item.separator) { node.appendChild(el('div', { class: 'menu-sep' })); continue; }
    const btn = el('button', {
      class: 'menu-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : ''),
      role: 'menuitem',
      onclick: (e) => { e.stopPropagation(); closeMenu(); item.onSelect?.(); },
    });
    btn.innerHTML = (item.icon ? ico(item.icon) : '<span class="ico"></span>') +
      `<span class="menu-label"></span>` + (item.hint ? `<span class="menu-hint">${item.hint}</span>` : '');
    btn.querySelector('.menu-label').textContent = item.label;
    node.appendChild(btn);
  }

  document.body.appendChild(node);
  const rect = node.getBoundingClientRect();
  const pad = 10;
  let x, y;
  if (event) { x = event.clientX; y = event.clientY; }
  else {
    const a = anchor.getBoundingClientRect();
    x = a.right - rect.width;
    y = a.bottom + 6;
    if (y + rect.height > innerHeight - pad) y = a.top - rect.height - 6;
  }
  x = clamp(x, pad, innerWidth - rect.width - pad);
  y = clamp(y, pad, innerHeight - rect.height - pad);
  node.style.left = x + 'px';
  node.style.top = y + 'px';
  node.style.transformOrigin = event || y > 200 ? 'top left' : 'bottom left';

  animate(node, { opacity: [0, 1], transform: ['scale(.94) translateY(-4px)', 'scale(1) translateY(0)'] },
          { duration: 180, easing: ease.out });

  openMenu = node;
  requestAnimationFrame(() => {
    const off = (e) => {
      if (node.contains(e.target)) return;
      document.removeEventListener('pointerdown', off, true);
      closeMenu();
    };
    document.addEventListener('pointerdown', off, true);
  });
  return node;
}

addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('resize', closeMenu);

/** Standard menu for a set of tracks. */
export function trackMenu(tracks, opts = {}) {
  const first = tracks[0];
  return [
    { label: 'Play', icon: 'play', onSelect: () => player.playTracks(tracks, 0, opts.origin) },
    { label: 'Play next', icon: 'next', onSelect: () => { player.playNext(tracks); toast('Playing next'); } },
    { label: 'Add to queue', icon: 'queue', onSelect: () => { player.enqueue(tracks); toast(`Added ${tracks.length} to queue`); } },
    { separator: true },
    { label: 'Add to playlist…', icon: 'plus', onSelect: () => addToPlaylistDialog(tracks) },
    first && { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = '#/album/' + first.albumKey) },
    first && { label: 'Go to artist', icon: 'artist', onSelect: () => (location.hash = '#/artist/' + first.artistKey) },
    opts.onRemove && { separator: true },
    opts.onRemove && { label: opts.removeLabel || 'Remove', icon: 'trash', danger: true, onSelect: opts.onRemove },
    { separator: true },
    first && { label: 'Track info', icon: 'info', onSelect: () => infoDialog(first) },
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ dialogs */

export function dialog({ title, body, actions = [], width = 420 }) {
  const panel = el('div', { class: 'dialog', style: { maxWidth: width + 'px' } });
  panel.appendChild(el('h2', { class: 'dialog-title', text: title }));
  if (body) panel.appendChild(el('div', { class: 'dialog-body' }, body));

  const bar = el('div', { class: 'dialog-actions' });
  const scrim = el('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } }, panel);

  function close() {
    animate(panel, { opacity: [1, 0], transform: ['scale(1)', 'scale(.97)'] }, { duration: 130, commit: false });
    animate(scrim, { opacity: [1, 0] }, { duration: 150, commit: false })
      .finished.then(() => scrim.remove()).catch(() => scrim.remove());
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  for (const a of actions) {
    bar.appendChild(el('button', {
      class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : 'ghost'),
      text: a.label,
      onclick: () => { if (a.onSelect?.(close) !== false) close(); },
    }));
  }
  panel.appendChild(bar);
  document.body.appendChild(scrim);
  document.addEventListener('keydown', onKey, true);

  animate(scrim, { opacity: [0, 1] }, { duration: 160 });
  animate(panel, { opacity: [0, 1], transform: ['scale(.96) translateY(8px)', 'scale(1) translateY(0)'] },
          { duration: 300, easing: ease.out });

  panel.querySelector('input, button.primary')?.focus();
  return { close, panel };
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', onConfirm }) {
  const input = el('input', { class: 'input', type: 'text', value, placeholder, spellcheck: 'false' });
  const d = dialog({
    title,
    body: el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input),
    actions: [
      { label: 'Cancel' },
      { label: confirm, primary: true, onSelect: () => { onConfirm?.(input.value.trim()); } },
    ],
  });
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { onConfirm?.(input.value.trim()); d.close(); }
  });
  return d;
}

export function addToPlaylistDialog(tracks) {
  const list = el('div', { class: 'pick-list' });
  const build = () => {
    list.textContent = '';
    if (!lib.state.playlists.length) {
      list.appendChild(el('p', { class: 'muted', text: 'No playlists yet — create one below.' }));
    }
    for (const p of lib.state.playlists) {
      list.appendChild(el('button', {
        class: 'pick-item',
        onclick: () => { lib.addToPlaylist(p.id, tracks.map((t) => t.id)); d.close(); toast(`Added to ${p.name}`); },
      },
        el('span', { class: 'pick-name', text: p.name }),
        el('span', { class: 'pick-count', text: `${p.tracks.length}` })));
    }
    enter(list.children, { each: 18, y: 6 });
  };
  build();

  const d = dialog({
    title: `Add ${tracks.length === 1 ? 'track' : tracks.length + ' tracks'} to playlist`,
    body: list,
    actions: [
      { label: 'Cancel' },
      {
        label: 'New playlist', primary: true,
        onSelect: () => {
          promptDialog({
            title: 'New playlist', label: 'Name', value: 'My playlist', confirm: 'Create',
            onConfirm: async (name) => {
              if (!name) return;
              await lib.createPlaylist(name, tracks.map((t) => t.id));
              toast(`Created ${name}`);
            },
          });
        },
      },
    ],
  });
  return d;
}

export function infoDialog(track) {
  const rows = [
    ['Title', track.title], ['Artist', track.artist], ['Album', track.album],
    ['Album artist', track.albumArtist], ['Track', track.track || '—'],
    ['Year', track.year || '—'], ['Genre', track.genre || '—'],
    ['Duration', track.duration ? fmtTime(track.duration) : '—'],
    ['File', track.name], ['Path', track.path],
  ];
  const body = el('dl', { class: 'info-grid' });
  for (const [k, v] of rows) {
    body.appendChild(el('dt', { text: k }));
    body.appendChild(el('dd', { text: String(v || '—') }));
  }
  return dialog({ title: 'Track info', body, actions: [{ label: 'Close', primary: true }], width: 520 });
}

/* ------------------------------------------------------------------ toasts */

let toastHost = null;

export function toast(message, { action, duration = 2600 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const node = el('div', { class: 'toast' }, el('span', { text: message }));
  if (action) {
    node.appendChild(el('button', { class: 'toast-action', text: action.label, onclick: () => { action.onSelect(); dismiss(); } }));
  }
  toastHost.appendChild(node);
  animate(node, { opacity: [0, 1], transform: ['translateY(12px) scale(.97)', 'translateY(0) scale(1)'] },
          { duration: 320, easing: ease.overshoot });

  let timer = setTimeout(dismiss, duration);
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', () => { timer = setTimeout(dismiss, 900); });

  function dismiss() {
    clearTimeout(timer);
    animate(node, { opacity: [1, 0], transform: ['translateY(0)', 'translateY(8px)'] },
            { duration: 180, commit: false }).finished.then(() => node.remove()).catch(() => node.remove());
  }
  return dismiss;
}

/* ------------------------------------------------------------------ misc */

/** Section heading with an optional action on the right. */
export function sectionHead(title, actionLabel, onAction) {
  return el('div', { class: 'section-head' },
    el('h2', { class: 'section-title', text: title }),
    actionLabel ? el('button', { class: 'link-btn', text: actionLabel, onclick: onAction }) : null);
}

export function emptyState({ icon = 'music', title, note, action }) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-ico', html: ico(icon) }),
    el('h3', { text: title }),
    note ? el('p', { text: note }) : null,
    action ? el('button', { class: 'btn primary', text: action.label, onclick: action.onSelect }) : null);
}

/** Big circular play button used on album/artist/playlist headers. */
export function playFab(onClick, label = 'Play') {
  const btn = el('button', { class: 'fab', 'aria-label': label, onclick: onClick, html: ico('play') });
  btn.addEventListener('pointerdown', () => {
    spring({ from: 1, to: 0.9, stiffness: 700, damping: 26, onUpdate: (v) => (btn.style.transform = `scale(${v})`) });
  });
  const up = () => spring({ from: 0.9, to: 1, stiffness: 500, damping: 18, onUpdate: (v) => (btn.style.transform = `scale(${v})`) });
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointerleave', up);
  return btn;
}
