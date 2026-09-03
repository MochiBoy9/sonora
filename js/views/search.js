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
  host.appendChild(filterChips(query));

  if (!query) {
    host.appendChild(emptyState({ icon: 'search', title: 'Search your library', note: 'Titles, artists, albums and genres — or one of the filters above, which combine with each other and with words.' }));
    return () => {};
  }

  const res = lib.search(query);

  /* Which of the typed words were understood as filters, said back. A query
     that silently ignores half of what you typed is the worst kind of search
     box, and `parseQuery` already knows the answer. */
  if (res.filtered && res.filtered.length) {
    host.appendChild(el('p', { class: 'search-reading' },
      el('span', { class: 'label', text: 'Reading' }),
      ...res.filtered.map((tok) => el('code', { class: 'search-token', text: tok }))));
  }

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

/**
 * D3: the filter language, as things you can press.
 *
 * There are seventeen filters and the only way to find out was to read
 * `library.js`. Typing still works exactly as it did — these put the token in
 * the box for you and run the search, which is both the discovery mechanism
 * and a way to learn the syntax by watching it appear.
 *
 * A chip already in the query reads as on and takes itself back out again,
 * so the row behaves like a set of toggles even though the underlying thing is
 * a string somebody could equally have typed.
 */
function filterChips(query) {
  const wrap = el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Filters' });
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());

  for (const f of lib.FILTER_HINTS) {
    /* An argument-taking chip counts as on when its *shape* is present:
       `after:1990` and `after:2004` are the same filter with different
       arguments, and pressing the chip should replace rather than repeat. */
    const stem = f.arg ? f.token.replace(/[\d.]+$/, '').replace(/:.*$/, ':') : f.token;
    const at = f.arg
      ? lower.findIndex((w) => (stem.endsWith(':') ? w.startsWith(stem) : w.startsWith(stem)))
      : lower.indexOf(f.token);
    const on = at >= 0;

    wrap.appendChild(el('button', {
      class: 'chip filter-chip' + (on ? ' is-on' : ''),
      type: 'button',
      'aria-pressed': String(on),
      title: f.note ? `${f.note} — types “${f.token}”` : `Types “${f.token}”`,
      text: f.label,
      onclick: () => {
        const next = words.slice();
        if (on) next.splice(at, 1);
        else next.push(f.token);
        const q = next.join(' ').trim();
        location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/home';
        // The box in the topbar is the same query and has to agree with it.
        const box = document.getElementById('search');
        if (box) box.value = q;
      },
    }));
  }
  return wrap;
}

/* ------------------------------------------------------------------ ANALYSIS */
