/* views/search.js — results for a query, filters and all. */

import * as lib from '../library.js';
import { enter } from '../motion.js';
import { emptyState, menu, sectionHead, trackMenu, trackRowFactory } from '../ui.js';
import { el } from '../util.js';
import { albumCard, artistCard, playAll } from './shared.js';

/* ------------------------------------------------------------------ SEARCH */

export function viewSearch(host, query) {
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
