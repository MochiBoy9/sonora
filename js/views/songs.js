/* views/songs.js — every track, sorted and virtualised. */

import * as lib from '../library.js';
import { enter } from '../motion.js';
import { el, fmtCount, fmtTotal, ico } from '../util.js';
import { emptyState } from '../ui.js';
import { columnHeader, decode, letterRail, pageFilter, playAll, shuffleAll, trackTable } from './shared.js';

/* ------------------------------------------------------------------ SONGS */

const songSort = { key: 'title', dir: 1 };

export function viewSongs(host) {
  const columns = ['index', 'art', 'title', 'album', 'dr', 'plays', 'played', 'rating', 'duration'];
  const all = lib.allTracks();
  const head = el('header', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Songs' }),
    el('p', { class: 'page-sub', text: all.length
      ? `${fmtCount(all.length, 'track')} · ${fmtTotal(all.reduce((s, t) => s + (t.duration || 0), 0))}`
      : fmtCount(0, 'track') }));
  host.appendChild(head);
  decode(head.querySelector('.page-title'), 'Songs');

  /* An empty library is not a table with no rows in it.
   *
   * Every other list in the application says why it is empty and what to
   * do about it. This one printed a title, a live Play all, a Shuffle, a
   * row of column headers and then nothing — a dead table with two
   * working buttons over it and a subtitle reading "0 tracks ·" with the
   * separator still attached. Songs is the second entry in the sidebar,
   * so on a fresh install it is one of the first places anybody looks.
   *
   * Only the library being empty is caught here. A filter that matches
   * nothing is different news — you have tracks, just not those — and the
   * toolbar already reports that itself. */
  if (!all.length) {
    host.appendChild(emptyState({
      icon: 'music', title: 'No tracks yet',
      note: 'Every track Sonora finds is listed here, whatever folder it came from. Point it at a folder of music to start.',
      action: { label: 'Add music folder', onSelect: () => document.dispatchEvent(new CustomEvent('sonora:add')) },
    }));
    return () => {};
  }
  /* D6: the list, narrowed to whatever is typed in the toolbar. Play all and
     Shuffle read the same function, so they act on what is on screen — which
     is the only reading that makes sense once a filter is showing. */
  const filter = pageFilter({ onChange: () => { table.update(); syncRail(); } });
  const get = () => lib.sortTracks(lib.allTracks().filter(filter.keep), songSort.key, songSort.dir);

  const bar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('play') + '<span>Play all</span>', onclick: () => playAll(get(), 0, { type: 'all', label: 'All songs' }) }),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(get(), { type: 'all', label: 'All songs' }) }),
    filter.node);

  host.appendChild(bar);

  const header = columnHeader(columns, songSort, () => { table.update(); syncRail(); });
  host.appendChild(header);

  const table = trackTable(host, get, {
    origin: { type: 'all', label: 'All songs' }, columns,
    sortKey: () => songSort.key,
  });

  /* Only where the order is alphabetical. A rail down a list sorted by length
     would move the scrollbar and land nowhere, which is worse than not
     offering it — so it is hidden rather than left to mislead. */
  const LETTERED = new Set(['title', 'artist', 'album']);
  const rail = letterRail({
    getItems: () => table.tracks,
    keyOf: (t) => (songSort.key === 'album' ? t.album : songSort.key === 'artist' ? t.artist : t.title),
    onJump: (i) => table.list.scrollToIndex(i, 'start'),
  });
  /* On `.main`, not inside `#view`.
     The rail must stay put while the list it steers scrolls past it, and
     anything appended to the scroller scrolls with it. `.main` is the frame
     around the scroller and is already positioned, so the rail sits against
     the right edge of whatever width the view currently has — which changes
     when the queue pane opens, and should. */
  const frame = host.parentElement || host;
  frame.appendChild(rail.node);
  const syncRail = () => {
    filter.report(table.tracks.length, lib.trackCount());
    rail.node.hidden = !LETTERED.has(songSort.key) || table.tracks.length < 40;
    if (!rail.node.hidden) rail.measure();
  };
  syncRail();

  enter([head, bar], { y: 10 });

  const off = lib.events.on('change', () => { table.update(); syncRail(); });
  return () => { off(); filter.destroy(); rail.node.remove(); table.destroy(); };
}
