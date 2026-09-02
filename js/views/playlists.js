/* views/playlists.js — playlists, favourites, recently played, and the
 * M3U import and export that let a playlist leave the building. */

import * as lib from '../library.js';
import * as m3u from '../m3u.js';
import { enter, tilt3d } from '../motion.js';
import * as player from '../player.js';
import * as rules from '../rules.js';
import { artBox, dialog, emptyState, menu, paintArt, placeholderStyle, playFab, promptDialog, rulesDialog, toast } from '../ui.js';
import { el, fmtAgo, fmtCount, fmtTotal, ico } from '../util.js';
import { applyHeroTint } from './album.js';
import { decode, notFound, playAll, shelf, shuffleAll, trackTable } from './shared.js';

export function viewRecent(host) {
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

export function viewPlaylists(host) {
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
export function viewFavourites(host) {
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

export function viewPlaylist(host, id) {
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
