/* views/artists.js — the artist wall, and one artist. */

import * as lib from '../library.js';
import { enter } from '../motion.js';
import * as player from '../player.js';
import { artBox, emptyState, menu, playFab, sectionHead, trackMenu, trackRowFactory } from '../ui.js';
import { cmpText, el, fmtCount, fmtTotal, ico, norm } from '../util.js';
import { VirtualGrid } from '../virtual.js';
import { applyHeroTint } from './album.js';
import { ARTIST_SORT } from './albums.js';
import { bandOverview } from './band.js';
import { albumCard, artistCard, artistOf, decode, notFound, pageFilter, playAll, renderArtistCard, shuffleAll, sortControl } from './shared.js';

/* ------------------------------------------------------------------ ARTISTS */

export function viewArtists(host) {
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

export function viewArtist(host, key) {
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

  /* D6: an artist with forty records is a page you scroll rather than read.
     The field narrows the wall as well as being the way to find one track. */
  const albumsBlock = el('section', { class: 'block' }, sectionHead('Albums'));
  const grid = el('div', { class: 'grid' });
  let finder = null;
  if (artist.albumList.length > 12) {
    finder = pageFilter({
      placeholder: `Filter ${artist.name}`,
      onChange: () => {
        const v = finder.value;
        let shown = 0;
        for (const card of grid.children) {
          const hit = !v || norm(card.dataset.search || '').includes(v);
          card.hidden = !hit;
          if (hit) shown++;
        }
        finder.report(shown, grid.children.length);
      },
    });
    albumsBlock.appendChild(el('div', { class: 'toolbar toolbar-thin' }, finder.node));
  }
  for (const a of artist.albumList) {
    const card = albumCard(a);
    // Matched against what is printed on the card plus the tracks inside it,
    // so "ocean" finds the record with the song on it, not only the record
    // called Ocean.
    card.dataset.search = `${a.title} ${a.artist} ${a.year || ''} ` +
      a.tracks.map((t) => t.title).join(' ');
    grid.appendChild(card);
  }
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
  return () => { off(); offState(); finder?.destroy(); };
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
