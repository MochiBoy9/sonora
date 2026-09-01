/* ui.js — shared widgets: artwork, track rows, menus, dialogs, toasts. */

import { el, ico, fmtTime, fmtAgo, clamp, canDecode } from './util.js';
import * as lib from './library.js';
import * as player from './player.js';
import { animate, ease, enter, spring, settled } from './motion.js';
import * as rules from './rules.js';

/* ------------------------------------------------------------------ artwork */

/**
 * Albums without embedded art still need to look intentional, so each one gets
 * a stable two-tone gradient derived from its key.
 */
export function placeholderStyle(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  // Hues are folded into the cool half of the wheel — cyan through blue to
  // indigo — so a wall of coverless albums still reads as one instrument
  // rather than as a bag of sweets. Each album keeps its own place in that
  // band, so they remain distinguishable from one another.
  const hue = 168 + (h % 108);
  return `linear-gradient(150deg,
    hsl(${hue} 46% 26%) 0%,
    hsl(${hue + 16} 38% 17%) 58%,
    hsl(${hue + 30} 30% 11%) 100%)`;
}

/**
 * How hard this cover wants its edge lit, 0…1.
 *
 * A near-black sleeve needs a strong arris or it dissolves into the ground; a
 * bright one needs almost none or the rim blows out into a halo. The number is
 * the inverse of the artwork's own luminance, and the artwork's colour was
 * already extracted at import for the accent — so this costs one multiply and
 * no new work at all.
 *
 * Rec. 709 coefficients: green carries most of what the eye reads as
 * brightness, and a flat average would call a saturated blue cover as bright
 * as a pale yellow one.
 */
function rimFor(key) {
  const rgb = key && lib.accentFor(key);
  if (!rgb) return null;
  const L = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return Math.max(0.15, Math.min(1, 1 - L));
}

/** Fills an <img> from the art cache — synchronously when it is already warm. */
export function paintArt(img, key) {
  img.dataset.key = key || '';
  const holder = img.parentNode;
  if (holder) holder.style.background = key ? placeholderStyle(key) : '';
  if (holder) {
    const rim = rimFor(key);
    if (rim === null) holder.style.removeProperty('--rim');
    else holder.style.setProperty('--rim', rim.toFixed(3));
  }
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

/**
 * Artwork as an object: a stage that holds the vanishing point, and inside it
 * the sleeve — the face, and the edge plane behind it that gives the thing
 * thickness when it turns.
 *
 * Returns the **stage**. Tilt the `.sleeve` inside it, never the stage itself:
 * an element cannot supply the perspective for its own rotation, and a sleeve
 * that turns without one is a picture being sheared.
 *
 * The edge is `<i aria-hidden>` because it is a side of a box rather than a
 * picture; there is nothing there to describe.
 */
export function sleeve(key, cls = '', { reflect = false, back = null, record = false } = {}) {
  const art = artBox(key, null, 'art-3d ' + cls);

  // Two nested turning elements, because two different things turn it. The
  // pointer tilt is written inline on `.sleeve` by tilt3d; the flip is a class
  // on `.sleeve-flip` inside it. One element cannot carry both without one
  // overwriting the other, and the pointer would win — which is to say the
  // record would never turn over.
  let face = [el('i', { class: 'art-edge', 'aria-hidden': 'true' }), art];
  if (back) face = [el('div', { class: 'sleeve-flip' }, ...face, back)];

  // The record lives behind the face and in front of the edge, and it is a
  // sibling of the flip wrapper rather than inside it: a disc that turned over
  // with the sleeve would be a disc printed on the back cover.
  const inner = el('div', { class: 'sleeve' + (back ? ' has-back' : '') },
    record ? el('i', { class: 'record', 'aria-hidden': 'true' }) : null, ...face);
  const stage = el('div', { class: 'sleeve-stage' }, inner);
  if (reflect) {
    // The floor. A second <img> pointed at the object URL the cache already
    // holds — the browser decodes it once and draws it twice, which is cheaper
    // than any filter that could fake it — dropped away under a mask rather
    // than a fade, so nothing composites a gradient over live pixels.
    //
    // It carries the placeholder gradient as well as the image, because an
    // album with no embedded cover is still an object standing on a floor, and
    // a record that casts no reflection while its neighbours do looks broken
    // rather than untagged.
    //
    // It hangs off the stage, not the sleeve: a reflection that tilts with the
    // record is a record standing on a mirror that tilts with it.
    const img = el('img', { class: 'art-echo-img', alt: '', decoding: 'async' });
    const echo = el('div', {
      class: 'art-echo',
      style: key ? { background: placeholderStyle(key) } : null,
    }, img);
    const sync = () => {
      const src = art.querySelector('.art-img').getAttribute('src');
      if (src) img.setAttribute('src', src); else img.removeAttribute('src');
    };
    sync();
    lib.loadArt(key).then(sync);
    stage.appendChild(el('div', { class: 'art-floor', 'aria-hidden': 'true' }, echo));
  }
  return stage;
}

/* ------------------------------------------------------------------ eq bars */

export const eqMarkup = '<span class="eq"><i></i><i></i><i></i><i></i></span>';

/* ------------------------------------------------------------------ favourites */

/** Paints one row's star from the library, without touching anything else. */
function paintFavourite(row, id) {
  const btn = row.querySelector('.trow-fav');
  if (!btn) return;
  const on = lib.isFavourite(id);
  row.classList.toggle('is-fav', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? 'Remove from favourites' : 'Add to favourites');
  btn.title = on ? 'Favourited (F)' : 'Favourite (F)';
}

/**
 * The star is its own edit, so it repaints its own row immediately rather than
 * waiting for the list to be rebuilt — the mark has to land under the pointer
 * that asked for it, not one frame later.
 */
function toggleRowFavourite(row) {
  const id = row.dataset.id;
  if (!id) return;
  const on = lib.toggleFavourite(id);
  paintFavourite(row, id);
  if (on) {
    const btn = row.querySelector('.trow-fav');
    spring({ from: 0.7, to: 1, stiffness: 620, damping: 16,
             onUpdate: (v) => (btn.style.transform = `scale(${v})`) });
  }
}

/* ------------------------------------------------------------------ rows */

/**
 * One factory for every track list in the app. Rows are recycled by the
 * virtualiser, so render() only ever writes fields that changed.
 */
/**
 * Which rows are picked, and the arithmetic of picking them.
 *
 * Held as ids rather than indices, deliberately. A virtualised list re-sorts
 * and re-filters under the selection all the time; indices would silently come
 * to mean different tracks, which is the kind of bug that only shows up as
 * "it deleted the wrong thing".
 *
 * The anchor is the other half of it: shift-click means "from the last thing I
 * picked to here", and that is a range in the list's *current* order, so it is
 * resolved against the list at the moment of the click rather than stored.
 */
export class Selection {
  constructor(onChange) {
    this.ids = new Set();
    this.anchorId = null;
    this.onChange = onChange;
  }

  get size() { return this.ids.size; }
  has(id) { return this.ids.has(id); }
  clear() { if (!this.ids.size) return; this.ids.clear(); this.anchorId = null; this.onChange?.(); }

  /** The picked tracks, in the order the list currently shows them. */
  tracksIn(list) { return list.filter((t) => this.ids.has(t.id)); }

  toggle(id) {
    if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id);
    this.anchorId = id;
    this.onChange?.();
  }

  only(id) {
    this.ids.clear();
    this.ids.add(id);
    this.anchorId = id;
    this.onChange?.();
  }

  all(list) {
    for (const t of list) this.ids.add(t.id);
    this.onChange?.();
  }

  /** From the anchor to `id` in the list's current order, inclusive. */
  range(list, id) {
    const to = list.findIndex((t) => t.id === id);
    if (to < 0) return;
    let from = this.anchorId ? list.findIndex((t) => t.id === this.anchorId) : -1;
    if (from < 0) from = to;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    for (let i = lo; i <= hi; i++) this.ids.add(list[i].id);
    this.onChange?.();
  }

  /** Drops ids that are no longer in the list, after a filter or a delete. */
  prune(list) {
    if (!this.ids.size) return;
    const live = new Set(list.map((t) => t.id));
    let changed = false;
    for (const id of [...this.ids]) if (!live.has(id)) { this.ids.delete(id); changed = true; }
    if (changed) this.onChange?.();
  }
}

export function trackRowFactory({ columns = ['index', 'title', 'album', 'duration'], onPlay, onMenu, onPick, selection }) {
  const create = () => {
    const row = el('div', { class: 'trow', role: 'row', tabindex: '-1' });
    let html = '';
    if (columns.includes('index')) html += '<div class="trow-index"><span class="n"></span>' + eqMarkup +
      `<button class="trow-play" title="Play" aria-label="Play">${ico('play')}</button></div>`;
    html += '<div class="trow-main">' +
      (columns.includes('art') ? '<div class="art art-sm"><img class="art-img" alt="" decoding="async"></div>' : '') +
      '<div class="trow-text"><div class="trow-title"></div><div class="trow-sub"></div></div></div>';
    if (columns.includes('album')) html += '<div class="trow-album"></div>';
    /* The dynamic range, where the listener asked for it. Measured on the audio
       thread the first time a track is played and otherwise shown in a panel
       almost nobody opens — it is the most useful number about a file that is
       not its title, and a library sorted by it is a different library. */
    if (columns.includes('dr')) html += '<div class="trow-dr"></div>';
    /* Both counted since the first release and shown nowhere until now. A play
       count is the only thing in the index that is a record of *you* rather
       than of the file, which is a reason to be able to see it. */
    if (columns.includes('plays')) html += '<div class="trow-plays"></div>';
    if (columns.includes('played')) html += '<div class="trow-played"></div>';
    if (columns.includes('duration')) html += '<div class="trow-time"></div>';
    html += '<div class="trow-actions">' +
      `<button class="icon-btn ghost trow-fav" aria-label="Favourite" aria-pressed="false">${ico('star')}${ico('star-fill')}</button>` +
      `<button class="icon-btn ghost trow-more" aria-label="More">${ico('more')}</button></div>`;
    row.innerHTML = html;

    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.trow-actions')) return;
      onPlay?.(parseInt(row.dataset.index, 10));
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.trow-play')) return onPlay?.(parseInt(row.dataset.index, 10));
      if (e.target.closest('.trow-fav')) return toggleRowFavourite(row);
      if (e.target.closest('.trow-more')) return onMenu?.(parseInt(row.dataset.index, 10), e.target.closest('.trow-more'));
      // A plain click on the row body picks it. Nothing used to happen here,
      // so this takes no gesture away from anybody.
      onPick?.(parseInt(row.dataset.index, 10), {
        toggle: e.ctrlKey || e.metaKey,
        range: e.shiftKey,
      });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onMenu?.(parseInt(row.dataset.index, 10), null, e);
    });
    return row;
  };

  const render = (row, track, index) => {
    if (!track) return;
    // The id, not just the index: a recycled row can be asked to toggle a
    // favourite after the list underneath it has been re-sorted.
    row.dataset.id = track.id;
    paintFavourite(row, track.id);
    if (selection) {
      const picked = selection.has(track.id);
      row.classList.toggle('is-selected', picked);
      row.setAttribute('aria-selected', picked ? 'true' : 'false');
    }
    const playing = player.state.current && player.state.current.id === track.id;
    row.classList.toggle('is-playing', !!playing);
    row.classList.toggle('is-missing', !lib.isAvailable(track.id));
    // Either a format nothing decodes, or one this browser proved it couldn't.
    row.classList.toggle('is-unsupported', !!track.undecodable || !canDecode(track.name || ''));

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

    const dr = row.querySelector('.trow-dr');
    if (dr) {
      const v = track.dr;
      const text = v > 0 ? 'DR' + Math.round(v) : '—';
      if (dr.textContent !== text) dr.textContent = text;
      dr.title = v > 0
        ? v.toFixed(1) + ' dB crest factor'
        : 'Not measured yet — play the track once';
      /* Under 8 dB is a loudness-war master and 14 or over is a well-cut one.
         Marked at the two ends rather than shaded on a gradient: this is a
         verdict somebody wants to read at a glance, not a heat map. */
      dr.classList.toggle('is-squashed', v > 0 && v < 8);
      dr.classList.toggle('is-open', v >= 14);
    }

    const plays = row.querySelector('.trow-plays');
    if (plays) {
      const n = track.playCount || 0;
      const text = n ? String(n) : '—';
      if (plays.textContent !== text) plays.textContent = text;
      plays.title = n ? `Played ${n} ${n === 1 ? 'time' : 'times'}` : 'Never played';
      plays.classList.toggle('is-none', !n);
    }

    const played = row.querySelector('.trow-played');
    if (played) {
      const text = track.lastPlayed ? fmtAgo(track.lastPlayed) : '—';
      if (played.textContent !== text) played.textContent = text;
      played.title = track.lastPlayed ? new Date(track.lastPlayed).toLocaleString() : 'Never played';
      played.classList.toggle('is-none', !track.lastPlayed);
    }

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
  settled(animate(node, { opacity: [1, 0], transform: ['scale(1)', 'scale(.96)'] },
                  { duration: 110, easing: 'ease-in', commit: false }), 110)
    .then(() => node.remove());
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
  // A menu over several tracks offers the edit that changes something: if any
  // of them is unmarked, the useful action is to mark the lot.
  const anyUnmarked = tracks.some((t) => !lib.isFavourite(t.id));
  return [
    { label: 'Play', icon: 'play', onSelect: () => player.playTracks(tracks, 0, opts.origin) },
    { label: 'Play next', icon: 'next', onSelect: () => { player.playNext(tracks); toast('Playing next'); } },
    { label: 'Add to queue', icon: 'queue', onSelect: () => { player.enqueue(tracks); toast(`Added ${tracks.length} to queue`); } },
    { separator: true },
    {
      label: anyUnmarked
        ? (tracks.length > 1 ? `Favourite ${tracks.length} tracks` : 'Add to favourites')
        : 'Remove from favourites',
      icon: anyUnmarked ? 'star' : 'star-fill',
      onSelect: () => {
        for (const t of tracks) lib.toggleFavourite(t.id, anyUnmarked);
        if (tracks.length === 1) toast(anyUnmarked ? 'Added to favourites' : 'Removed from favourites');
        else toast(`${anyUnmarked ? 'Favourited' : 'Unfavourited'} ${tracks.length} tracks`);
      },
    },
    { label: 'Add to playlist…', icon: 'plus', onSelect: () => addToPlaylistDialog(tracks) },
    first && { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = '#/album/' + first.albumKey) },
    first && { label: 'Go to artist', icon: 'artist', onSelect: () => (location.hash = '#/artist/' + first.artistKey) },
    opts.onRemove && { separator: true },
    opts.onRemove && { label: opts.removeLabel || 'Remove', icon: 'trash', danger: true, onSelect: opts.onRemove },
    /* Only offered where the analysis actually found a repeat. On anything
       through-composed it declines, and a menu item that does nothing on half
       a library is worse than one that is sometimes absent. */
    first && player.hookOf(first) && {
      label: 'Play the good bit', icon: 'play',
      hint: fmtTime(player.hookOf(first).at),
      onSelect: () => { if (!player.playHook(first)) toast('No repeated section found'); },
    },
    { separator: true },
    tracks.length && {
      label: tracks.length > 1 ? `Edit details for ${tracks.length} tracks…` : 'Edit details…',
      icon: 'edit',
      onSelect: () => editDialog(tracks),
    },
    first && { label: 'Track info', icon: 'info', onSelect: () => infoDialog(first) },
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ rules */

/**
 * The builder for a playlist that describes itself.
 *
 * One row per rule, each a field, an operator and a value — and the operators
 * offered change with the field, because "contains" means nothing about a
 * year and "in the last" means nothing about a title. The count updates as you
 * type, which is most of what makes a rule builder usable: you can see whether
 * you have described forty tracks or four thousand before you commit to it.
 */
export function rulesDialog(existing, onSave) {
  const set = {
    name: existing?.name || 'New shelf',
    match: existing?.match || 'all',
    rules: (existing?.rules || []).map((r) => ({ ...r })),
    sort: existing?.sort || 'none',
    sortDir: existing?.sortDir || 1,
    limit: existing?.limit || 0,
  };
  if (!set.rules.length) set.rules.push(rules.blankRule());

  const body = el('div', { class: 'rules-form' });
  const nameInput = el('input', { class: 'input', type: 'text', value: set.name, 'aria-label': 'Name' });
  nameInput.addEventListener('input', () => { set.name = nameInput.value; });

  const matchSeg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Match' });
  for (const [id, label] of [['all', 'All of these'], ['any', 'Any of these']]) {
    const b = el('button', {
      class: 'seg' + (set.match === id ? ' is-on' : ''), role: 'radio',
      'aria-checked': String(set.match === id), text: label,
    });
    b.addEventListener('click', () => {
      set.match = id;
      for (const x of matchSeg.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
      paintCount();
    });
    matchSeg.appendChild(b);
  }

  const list = el('div', { class: 'rules-list' });
  const count = el('p', { class: 'rules-count' });

  function paintCount() {
    const n = rules.evaluate(set).length;
    count.textContent = `${n.toLocaleString()} ${n === 1 ? 'track' : 'tracks'} · ${rules.describe(set)}`;
  }

  function paintRules() {
    list.textContent = '';
    set.rules.forEach((rule, i) => {
      const row = el('div', { class: 'rule-row' });

      const fieldSel = el('select', { class: 'input rule-field', 'aria-label': 'Field' });
      for (const [id, f] of Object.entries(rules.FIELDS)) {
        fieldSel.appendChild(el('option', { value: id, text: f.label, selected: id === rule.field }));
      }
      fieldSel.addEventListener('change', () => {
        // A new field usually means the old operator no longer applies.
        Object.assign(rule, rules.blankRule(fieldSel.value));
        paintRules(); paintCount();
      });

      const opSel = el('select', { class: 'input rule-op', 'aria-label': 'Condition' });
      for (const op of rules.opsFor(rule.field)) {
        opSel.appendChild(el('option', { value: op.id, text: op.label, selected: op.id === rule.op }));
      }
      opSel.addEventListener('change', () => {
        rule.op = opSel.value;
        paintRules(); paintCount();
      });

      row.append(fieldSel, opSel);

      const op = rules.OPS[rule.op];
      if (op && !op.noValue) {
        const kind = rules.FIELDS[rule.field].kind;
        const val = el('input', {
          class: 'input rule-value', 'aria-label': 'Value',
          type: kind === 'text' ? 'text' : 'number',
          value: String(rule.value ?? ''),
        });
        val.addEventListener('input', () => { rule.value = val.value; paintCount(); });
        row.appendChild(val);
        const unit = op.unit || rules.FIELDS[rule.field].unit;
        if (unit) row.appendChild(el('span', { class: 'rule-unit', text: unit }));
      }

      row.appendChild(el('button', {
        class: 'icon-btn ghost sm rule-drop', 'aria-label': 'Remove this rule',
        html: ico('close'),
        onclick: () => { set.rules.splice(i, 1); if (!set.rules.length) set.rules.push(rules.blankRule()); paintRules(); paintCount(); },
      }));
      list.appendChild(row);
    });
  }

  body.append(
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Name' }), nameInput),
    el('div', { class: 'rules-head' }, el('span', { class: 'label', text: 'Match' }), matchSeg),
    list,
    el('button', {
      class: 'btn ghost sm rules-add', html: ico('plus') + '<span>Add a rule</span>',
      onclick: () => { set.rules.push(rules.blankRule()); paintRules(); paintCount(); },
    }),
    count,
    el('p', { class: 'rules-note',
      text: 'Worked out fresh every time it is opened, so it is never out of date.' }),
  );

  paintRules();
  paintCount();

  dialog({
    title: existing ? 'Edit shelf' : 'New smart shelf',
    body, width: 560,
    actions: [
      { label: 'Cancel' },
      { label: existing ? 'Save' : 'Create', primary: true, onSelect: () => onSave(set) },
    ],
  });
}

/* ------------------------------------------------------------------ editing */

const EDIT_FIELDS = [
  ['title', 'Title', 'text'],
  ['artist', 'Artist', 'text'],
  ['albumArtist', 'Album artist', 'text'],
  ['album', 'Album', 'text'],
  ['genre', 'Genre', 'text'],
  ['track', 'Track no.', 'number'],
  ['disc', 'Disc', 'number'],
  ['year', 'Year', 'number'],
];

/**
 * Correct what a track says about itself.
 *
 * Edits go into Sonora's index and never into the file — see the note in
 * library.js for why that is a decision rather than an omission. The dialog
 * says so, because a listener is entitled to know whether the thing they just
 * typed has been written to their disk.
 *
 * Over several tracks, a field where they already agree shows the shared value
 * and a field where they differ shows nothing and is left alone unless typed
 * into. That is the only behaviour that lets somebody fix the album name on
 * forty tracks without flattening forty different titles into one.
 */
export function editDialog(tracks) {
  if (!tracks || !tracks.length) return;
  const many = tracks.length > 1;
  const body = el('div', { class: 'edit-form' });
  const inputs = new Map();
  const mixed = new Set();

  for (const [key, label, type] of EDIT_FIELDS) {
    const values = new Set(tracks.map((t) => String(t[key] ?? '')));
    const shared = values.size === 1 ? [...values][0] : '';
    if (values.size > 1) mixed.add(key);

    const input = el('input', {
      type, class: 'input', value: shared === '0' && type === 'number' ? '' : shared,
      placeholder: values.size > 1 ? '— several —' : '',
      'aria-label': label,
    });
    inputs.set(key, input);

    const edited = tracks.some((t) => t.edits && t.edits[key] !== undefined);
    /* Which of these the tag reader had to take from a folder name rather than
       from the file. It has recorded that since 2.1 and resolved it into a
       single boolean at import, after which nobody could see it again.
     *
     * It is worth seeing: an artist inferred from a directory is a different
     * kind of fact from one read out of an ALBUMARTIST frame, and somebody
     * fixing their library wants to know which is which before they start —
     * it is also exactly the list of files worth re-tagging at the source. */
    const guessed = !edited && tracks.some((t) =>
      String(t.guessed || '').split(' ').includes(key));

    body.appendChild(el('label', { class: 'edit-field' + (edited ? ' is-edited' : '') + (guessed ? ' is-guessed' : '') },
      el('span', { class: 'edit-label', text: label },
        guessed ? el('span', { class: 'edit-guess', title: 'Taken from the folder name — the file did not say', text: 'guessed' }) : null,
        edited ? el('button', {
          class: 'edit-revert', type: 'button', title: 'Use what the file says',
          text: 'revert',
          onclick: async (e) => {
            e.preventDefault();
            await lib.editTracks(tracks, { [key]: null });
            const back = new Set(tracks.map((t) => String(t[key] ?? '')));
            input.value = back.size === 1 ? [...back][0] : '';
            e.currentTarget.closest('.edit-field').classList.remove('is-edited');
            toast('Reverted to the file');
          },
        }) : null),
      input));
  }

  body.appendChild(el('p', { class: 'edit-note',
    text: 'Saved in Sonora only. Your files are never modified — a rescan keeps these corrections.' }));

  dialog({
    title: many ? `Edit ${tracks.length} tracks` : 'Edit details',
    body,
    width: 460,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', primary: true,
        onSelect: async () => {
          const patch = {};
          for (const [key, , type] of EDIT_FIELDS) {
            const raw = inputs.get(key).value.trim();
            // A field that was blank because the tracks disagreed, and was not
            // typed into, must not overwrite forty different values with "".
            if (mixed.has(key) && raw === '') continue;
            patch[key] = type === 'number' ? (parseInt(raw, 10) || null) : raw;
          }
          const n = await lib.editTracks(tracks, patch);
          toast(n ? `Updated ${n === 1 ? 'track' : n + ' tracks'}` : 'Nothing changed');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ dialogs */

export function dialog({ title, body, actions = [], width = 420, onClose }) {
  const panel = el('div', {
    class: 'dialog', style: { maxWidth: width + 'px' },
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
  });
  panel.appendChild(el('h2', { class: 'dialog-title', text: title }));
  if (body) panel.appendChild(el('div', { class: 'dialog-body' }, body));

  const bar = el('div', { class: 'dialog-actions' });
  const scrim = el('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } }, panel);
  // Where to put the caret back. A dialog opened from a menu item has already
  // lost it to <body>, in which case there is nothing to restore and nothing
  // to be gained by pretending otherwise.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    animate(panel, { opacity: [1, 0], transform: ['scale(1)', 'scale(.97)'] }, { duration: 130, commit: false });
    settled(animate(scrim, { opacity: [1, 0] }, { duration: 150, commit: false }), 150)
      .then(() => scrim.remove());
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
    onClose?.();
  }

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // A modal that lets Tab walk out onto the page behind it is not modal.
    if (e.key !== 'Tab') return;
    const stops = [...panel.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !panel.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
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
  const rate = track.sampleRate
    ? (track.sampleRate % 1000 === 0 ? track.sampleRate / 1000 : (track.sampleRate / 1000).toFixed(1)) + ' kHz'
    : '';
  const chans = track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo'
    : track.channels ? track.channels + ' ch' : '';
  const stream = [rate, track.bitDepth ? track.bitDepth + '-bit' : '', chans,
    track.bitrate ? '~' + track.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');

  const rows = [
    ['Title', track.title], ['Artist', track.artist], ['Album', track.album],
    ['Album artist', track.albumArtist], ['Track', track.track || '—'],
    ['Year', track.year || '—'], ['Genre', track.genre || '—'],
    ['Duration', track.duration ? fmtTime(track.duration) : '—'],
    ['Stream', stream || '—'],
    // Absent until it has been listened to, and the copy says why rather than
    // showing an em dash that reads like a missing tag.
    ['Dynamic range', track.dr ? `DR${Math.round(track.dr)} · ${track.dr.toFixed(1)} dB crest`
                               : 'Not measured yet — play it through'],
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
    settled(animate(node, { opacity: [1, 0], transform: ['translateY(0)', 'translateY(8px)'] },
                    { duration: 180, commit: false }), 180).then(() => node.remove());
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
