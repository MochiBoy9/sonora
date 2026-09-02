/* views/genres.js — the genre wall, and one genre. */

import * as lib from '../library.js';
import { enter } from '../motion.js';
import { emptyState } from '../ui.js';
import { el, fmtCount, fmtTotal, ico } from '../util.js';
import { decode, notFound, playAll, trackTable } from './shared.js';

/* ------------------------------------------------------------------ L4
 *
 * Genres, as a place. A grid weighted by how much of the library each one
 * holds, because a genre with four tracks and a genre with four hundred are
 * not the same kind of thing and a uniform grid says they are.
 */
export function viewGenres(host) {
  const all = lib.genres();
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Library' }),
    el('h1', { class: 'page-title', text: 'Genres' }),
    el('p', { class: 'page-sub', text: fmtCount(all.length, 'genre') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Genres');

  if (!all.length) {
    host.appendChild(emptyState({
      icon: 'circles', title: 'No genres yet',
      note: 'Genre is read from the files. Nothing in this library carries one.',
    }));
    return () => {};
  }

  const top = all[0].tracks.length || 1;
  const wall = el('div', { class: 'genre-wall' });
  for (const g of all) {
    /* Weight by the fourth root of the share, not by the share: a library
       where one genre is nine tenths of everything would otherwise be one
       enormous tile and forty slivers. This keeps the biggest about three
       times the smallest, which reads as a ranking without becoming a
       treemap. */
    const w = Math.pow(g.tracks.length / top, 0.25);
    const tile = el('a', {
      class: 'genre-tile', href: '#/genre/' + encodeURIComponent(g.key),
      style: `--w:${w.toFixed(3)}`,
    },
      el('b', { class: 'genre-name', text: g.label }),
      el('span', { class: 'genre-count', text: `${fmtCount(g.tracks.length, 'track')} · ${fmtCount(g.albums.size, 'album')}` }));
    wall.appendChild(tile);
  }
  host.appendChild(wall);
  enter(wall.children, { each: 14, y: 10 });
  return () => {};
}

/** One genre: everything filed under it. */
export function viewGenre(host, key) {
  const g = lib.genreOf(decodeURIComponent(key || ''));
  if (!g) return notFound(host, 'No such genre');

  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow' }, el('a', { class: 'hero-link', href: '#/genres', text: 'Genres' })),
    el('h1', { class: 'page-title', text: g.label }),
    el('p', { class: 'page-sub', text: `${fmtCount(g.tracks.length, 'track')} · ${fmtCount(g.albums.size, 'album')} · ${fmtTotal(g.duration)}` }));
  host.appendChild(head);

  const bar = el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn primary', html: ico('play') + '<span>Play</span>',
      onclick: () => playAll(g.tracks, 0, { type: 'genre', key: g.key, label: g.label }),
    }),
    el('button', {
      class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>',
      onclick: () => playAll(g.tracks, Math.floor(Math.random() * g.tracks.length),
        { type: 'genre', key: g.key, label: g.label }),
    }));
  host.appendChild(bar);

  const table = trackTable(host, () => g.tracks, {
    origin: { type: 'genre', key: g.key, label: g.label },
    // D6: a genre can be four hundred tracks, which is exactly the page where
    // "which of these" is the only question anybody has.
    filter: g.tracks.length > 24 ? `Filter ${g.label}` : false,
  });
  if (table.filter) bar.appendChild(table.filter.node);
  return () => table.destroy();
}

/* ------------------------------------------------------------------ L9
 *
 * Everything that needs a human.
 *
 * Six findings the application already had and kept in six places. Each one is
 * a count, the list behind it and one thing to do about it — which is the only
 * shape that makes a page like this worth opening twice.
 */
