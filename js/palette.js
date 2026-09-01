/* palette.js — everything the app can do, reachable by typing its name.
 *
 * Sonora has a numbered sidebar, a search, a shortcut sheet and about forty
 * distinct actions, and until now the only way to reach most of them was to
 * know where they lived. A palette is the one interface that scales with an
 * app's surface area instead of against it: the more it can do, the more
 * useful typing becomes.
 *
 * Two lists ranked into one. The commands below are actions — things the app
 * does — and the library search supplies the nouns, so `⌘K` finds "shuffle"
 * and "Shuffle it Off" in the same box and lets the ranking sort out which you
 * meant. Anything the search box already understands works here too, filters
 * included: `unplayed`, `dr>14`, `before:1985`.
 *
 * The commands are declared here rather than derived from the key handler,
 * and that is worth being straight about: `SHORTCUTS` in app.js is a table for
 * the help sheet and `bindKeys` is a switch statement, and they were never one
 * source. Making them one would mean rewriting the key handling to be
 * data-driven, which is a bigger change than this and not obviously an
 * improvement — a switch on a keystroke is perfectly clear. So there are two
 * lists, and the shortcut label on a palette row is written next to the action
 * it belongs to, where a mismatch is visible.
 */

import { el, ico, fmtTime } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { toast } from './ui.js';

/* ------------------------------------------------------------------ commands */

const go = (hash) => () => { location.hash = hash; };

/**
 * `when` hides a command that cannot do anything right now — favouriting with
 * nothing playing, say. A palette that lists actions which quietly fail is
 * worse than one that lists fewer.
 */
function commands() {
  const playing = !!player.state.current;
  return [
    { label: 'Play or pause', icon: 'play', keys: 'Space', when: playing, run: () => player.toggle() },
    { label: 'Next track', icon: 'next', keys: 'N', when: playing, run: () => player.next(false) },
    { label: 'Previous track', icon: 'prev', keys: 'P', when: playing, run: () => player.prev() },
    { label: 'Shuffle', icon: 'shuffle', keys: 'S',
      run: () => { player.setShuffle(); toast(player.state.shuffle ? 'Shuffle on' : 'Shuffle off'); } },
    { label: 'Repeat', icon: 'repeat', keys: 'R',
      run: () => { player.cycleRepeat(); toast('Repeat: ' + player.state.repeat); } },
    { label: 'Mute', icon: 'volume', keys: 'M', run: () => player.toggleMute() },
    { label: 'Favourite what is playing', icon: 'star', keys: 'F', when: playing,
      run: () => { const t = player.state.current; toast(lib.toggleFavourite(t.id) ? 'Favourited' : 'Removed from favourites'); } },
    { label: 'Play the good bit', icon: 'play', when: playing && !!player.hookOf(player.state.current),
      hint: 'jump to the part that repeats',
      run: () => { if (!player.playHook()) toast('No repeated section found'); } },

    { label: 'Sleep in 30 minutes', icon: 'clock', run: () => { player.setSleep(30); toast('Sleeping in 30 minutes'); } },
    { label: 'Stop after this track', icon: 'clock', when: playing,
      run: () => { player.setSleep('track'); toast('Stopping after this track'); } },
    { label: 'Cancel the sleep timer', icon: 'clock', when: player.sleepRemaining() !== null,
      run: () => { player.setSleep(null); toast('Sleep timer off'); } },

    { label: 'Gapless', icon: 'sliders', hint: 'no overlap between tracks',
      run: () => { player.setCrossfade(0); toast('Gapless'); } },
    { label: 'Crossfade for 6 seconds', icon: 'sliders',
      run: () => { player.setCrossfade(6); toast('Crossfading 6s'); } },
    { label: 'Bypass the rack', icon: 'refresh', keys: 'B',
      run: () => document.dispatchEvent(new CustomEvent('sonora:bypass')) },

    { label: 'Home', icon: 'home', run: go('#/home') },
    { label: 'Songs', icon: 'music', run: go('#/songs') },
    { label: 'Albums', icon: 'album', run: go('#/albums') },
    { label: 'Artists', icon: 'artist', run: go('#/artists') },
    { label: 'Favourites', icon: 'star', run: go('#/favourites') },
    { label: 'Playlists', icon: 'playlist', run: go('#/playlists') },
    { label: 'Files', icon: 'folder', hint: 'folders and duplicates', run: go('#/files') },
    { label: 'Analysis', icon: 'circles', run: go('#/circles') },
    { label: 'Sound', icon: 'sliders', keys: 'E', run: go('#/sound') },
    { label: 'Settings', icon: 'settings', run: go('#/settings') },

    { label: 'Visualiser', icon: 'expand', keys: 'V', run: () => document.dispatchEvent(new CustomEvent('sonora:stage')) },
    { label: 'Queue', icon: 'queue', keys: 'Q', run: () => document.dispatchEvent(new CustomEvent('sonora:toggle-queue')) },
    { label: 'Keyboard shortcuts', icon: 'keys', keys: '?', run: () => document.dispatchEvent(new CustomEvent('sonora:shortcuts')) },
    { label: 'Add music', icon: 'plus', run: () => document.dispatchEvent(new CustomEvent('sonora:add-music')) },
  ].filter((c) => c.when === undefined || c.when);
}

/* ------------------------------------------------------------------ ranking */

/**
 * A word-prefix score, not a fuzzy one.
 *
 * Subsequence matching is what most palettes use and it is wrong for a list
 * this small: it makes "sos" match "Settings" and puts noise above the thing
 * somebody typed three letters of. Matching whole words, and rewarding a match
 * at the start of one, gets the right answer for every query anybody actually
 * types here.
 */
function score(label, query) {
  const hay = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (hay === q) return 100;
  if (hay.startsWith(q)) return 60;
  let total = 0;
  for (const term of q.split(/\s+/)) {
    const i = hay.indexOf(term);
    if (i < 0) return 0;
    total += i === 0 ? 20 : hay[i - 1] === ' ' ? 14 : 5;
  }
  return total;
}

/* ------------------------------------------------------------------ view */

let open = null;

export const isOpen = () => !!open;

export function closePalette() {
  if (!open) return;
  const teardown = open;
  open = null;
  teardown();
}

export function openPalette() {
  if (open) return;

  const input = el('input', {
    class: 'pal-input', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Type a command, or search your library…',
    'aria-label': 'Command palette', 'aria-controls': 'pal-list', 'aria-expanded': 'true',
  });
  const list = el('div', { class: 'pal-list', id: 'pal-list', role: 'listbox' });
  const hintRow = el('div', { class: 'pal-hint' },
    el('span', { text: 'Try ' }),
    el('code', { text: 'unplayed' }), el('span', { text: ' · ' }),
    el('code', { text: 'dr>14' }), el('span', { text: ' · ' }),
    el('code', { text: 'before:1985' }), el('span', { text: ' · ' }),
    el('code', { text: '>6min' }));

  const panel = el('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    el('div', { class: 'pal-bar' }, el('span', { class: 'pal-ico', html: ico('search') }), input),
    list, hintRow);
  const scrim = el('div', { class: 'scrim pal-scrim', onclick: (e) => { if (e.target === scrim) closePalette(); } }, panel);

  let rows = [];
  let active = 0;

  function paint() {
    const q = input.value.trim();
    rows = [];

    for (const c of commands()) {
      const s = score(c.label, q);
      if (s) rows.push({ s: s + 4, kind: 'command', label: c.label, hint: c.hint, keys: c.keys, icon: c.icon, run: c.run });
    }

    if (q) {
      const found = lib.search(q, 8);
      for (const t of found.tracks) {
        rows.push({ s: 30, kind: 'track', label: t.title, hint: t.artist, icon: 'music',
          meta: t.duration ? fmtTime(t.duration) : '',
          run: () => player.playTracks([t], 0, { type: 'search', label: q }) });
      }
      for (const a of (found.albums || []).slice(0, 4)) {
        rows.push({ s: 26, kind: 'album', label: a.title, hint: a.artist, icon: 'album',
          run: go('#/album/' + a.key) });
      }
      for (const a of (found.artists || []).slice(0, 3)) {
        rows.push({ s: 24, kind: 'artist', label: a.name, icon: 'artist',
          run: go('#/artist/' + a.key) });
      }
      // A query that is only filters names no words, so nothing above scored on
      // text — say what it did instead of showing an empty box.
      if (found.filtered && found.filtered.length && !found.tracks.length) {
        rows.push({ s: 1, kind: 'note', label: `Nothing matches ${found.filtered.join(' ')}`, icon: 'info', run: () => {} });
      }
    }

    rows.sort((a, b) => b.s - a.s);
    rows = rows.slice(0, 40);
    active = 0;
    render();
  }

  function render() {
    list.textContent = '';
    if (!rows.length) {
      list.appendChild(el('p', { class: 'pal-empty', text: 'Nothing matches that.' }));
      return;
    }
    rows.forEach((r, i) => {
      const row = el('button', {
        class: 'pal-row' + (i === active ? ' is-active' : ''),
        role: 'option', 'aria-selected': String(i === active),
        onclick: () => { closePalette(); r.run(); },
      },
        el('span', { class: 'pal-row-ico', html: ico(r.icon || 'music') }),
        el('span', { class: 'pal-row-text' },
          el('b', { text: r.label }),
          r.hint ? el('span', { text: r.hint }) : null),
        r.keys ? el('kbd', { class: 'pal-keys', text: r.keys }) : null,
        r.meta ? el('span', { class: 'pal-meta', text: r.meta }) : null,
        el('span', { class: 'pal-kind', text: r.kind === 'command' ? '' : r.kind }));
      list.appendChild(row);
    });
    // Keep the active row in view without scrolling the page behind it.
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!rows.length) return;
    active = (active + delta + rows.length) % rows.length;
    render();
  }

  input.addEventListener('input', paint);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r) { closePalette(); r.run(); }
    }
  };
  panel.addEventListener('keydown', onKey);

  document.body.appendChild(scrim);
  paint();
  input.focus();

  open = () => {
    panel.removeEventListener('keydown', onKey);
    scrim.remove();
  };
}

export function togglePalette() {
  if (open) closePalette(); else openPalette();
}
