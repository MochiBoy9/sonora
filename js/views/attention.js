/* views/attention.js — everything that needs a human, and the
 * find-and-replace that fixes a library's one systematic mistake. */

import * as lib from '../library.js';
import { dialog, emptyState, menu, toast, trackMenu, trackRowFactory } from '../ui.js';
import { el, fmtBytes, fmtCount, formatName, ico } from '../util.js';
import { playAll, shelf } from './shared.js';

export function viewAttention(host) {
  const head = el('header', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Needs attention' }),
    el('p', { class: 'page-sub', id: 'attn-sub', text: 'Looking…' }));
  host.appendChild(head);

  const body = el('div', { class: 'attn' });
  host.appendChild(body);

  const paint = () => {
    const a = lib.attention();
    body.textContent = '';

    const items = [
      {
        key: 'untagged', icon: 'info',
        title: 'Nothing in the file',
        note: 'Artist and album came from the folder name. These are the ones that make a library look wrong.',
        rows: a.untagged,
        act: (rows) => openEdit(rows),
        actLabel: 'Correct them',
      },
      {
        key: 'noart', icon: 'image',
        title: 'No cover',
        note: 'No artwork in the files and none chosen. Drop a picture on the record to set one.',
        rows: a.noArt,
        albums: true,
      },
      {
        key: 'dupes', icon: 'grip',
        title: 'Possible duplicates',
        note: 'Same artist, same title, same length — usually one file at two bitrates.',
        groups: a.duplicates,
      },
      {
        key: 'undecodable', icon: 'plug',
        title: 'This browser cannot play them',
        note: 'Catalogued and searchable, but no decoder here. Another browser may manage them.',
        rows: a.undecodable,
      },
      {
        key: 'suspect', icon: 'wave',
        title: 'Look like transcodes',
        note: 'A lossless container with a lossy encoder\u2019s shelf in the spectrum. Measured, not guessed — only tracks you have played are tested.',
        rows: a.suspect,
      },
      {
        key: 'guessed', icon: 'edit',
        title: 'Partly guessed',
        note: 'Some fields came from the folder tree rather than from the file.',
        rows: a.guessed,
        act: (rows) => openEdit(rows),
        actLabel: 'Correct them',
      },
    ];

    let total = 0;
    for (const item of items) {
      const n = item.groups ? item.groups.length : item.rows.length;
      total += n;
      if (!n) continue;

      const list = el('div', { class: 'attn-body', hidden: true });
      const card = el('section', { class: 'attn-card' },
        el('button', {
          class: 'attn-head', 'aria-expanded': 'false',
          onclick: (e) => {
            const open = list.hidden;
            list.hidden = !open;
            e.currentTarget.setAttribute('aria-expanded', String(open));
            if (open && !list.firstChild) fill(list, item);
          },
        },
          el('span', { class: 'attn-ico', html: ico(item.icon) }),
          el('span', { class: 'attn-text' },
            el('b', { text: item.title }),
            el('span', { class: 'attn-note', text: item.note })),
          el('span', { class: 'attn-count', text: String(n) })),
        list);

      if (item.act) {
        card.querySelector('.attn-head').after(el('div', { class: 'attn-actions' },
          el('button', {
            class: 'btn ghost sm', text: item.actLabel,
            onclick: () => item.act(item.rows),
          })));
      }
      body.appendChild(card);
    }

    const attnSub = host.querySelector('#attn-sub');
    attnSub.textContent = total
      ? `${fmtCount(total, 'thing')} worth a look`
      : 'Nothing needs you. The library is as tidy as the files allow.';
    // A tally is a readout; the all-clear is a sentence. See `.is-note`.
    attnSub.classList.toggle('is-note', !total);
    if (!total) {
      body.appendChild(emptyState({
        icon: 'star', title: 'All clear',
        note: 'Untagged files, missing covers, duplicates and anything this browser cannot play would be listed here.',
      }));
    }
  };

  /** Fills a card's list the first time it is opened, not before. */
  const fill = (list, item) => {
    if (item.albums) {
      const grid = el('div', { class: 'attn-albums' });
      for (const al of item.rows.slice(0, 60)) {
        grid.appendChild(el('a', { class: 'attn-album', href: '#/album/' + al.key },
          el('b', { text: al.title }), el('span', { text: al.artist })));
      }
      list.appendChild(grid);
      if (item.rows.length > 60) list.appendChild(el('p', { class: 'muted', text: `and ${item.rows.length - 60} more` }));
      return;
    }
    if (item.groups) {
      for (const group of item.groups.slice(0, 40)) {
        const g = el('div', { class: 'attn-group' },
          el('b', { text: `${group[0].title} — ${group[0].artist}` }));
        for (const t of group) {
          g.appendChild(el('div', { class: 'attn-file' },
            el('span', { class: 'attn-path', text: t.path || t.name }),
            el('span', { class: 'attn-meta', text: [formatName(t.name || ''), t.bitrate ? t.bitrate + ' kbps' : '', fmtBytes(t.size || 0)].filter(Boolean).join(' · ') })));
        }
        list.appendChild(g);
      }
      if (item.groups.length > 40) list.appendChild(el('p', { class: 'muted', text: `and ${item.groups.length - 40} more` }));
      return;
    }
    const rows = item.rows.slice(0, 200);
    const table = el('div', { class: 'plain-list' });
    const factory = trackRowFactory({
      columns: ['index', 'title', 'album', 'duration'],
      onPlay: (i) => playAll(rows, i, { type: 'attention', label: item.title }),
      onMenu: (i, anchor, event) => menu(trackMenu([rows[i]]), { anchor, event }),
    });
    rows.forEach((t, i) => {
      const row = factory.create();
      row.dataset.index = i;
      row.classList.add('static-row');
      factory.render(row, t, i);
      table.appendChild(row);
    });
    list.appendChild(table);
    if (item.rows.length > rows.length) {
      list.appendChild(el('p', { class: 'muted', text: `and ${item.rows.length - rows.length} more` }));
    }
  };

  /** The existing edit dialog, against the whole finding. */
  const openEdit = (rows) => {
    if (!rows.length) return;
    editDialog(rows.slice(0, 500));
  };

  /* L11: the one systematic mistake.
   *
   * Every library has one — "feat." against "ft.", a name misspelled the same
   * way across three albums — and one-at-a-time correction cannot reach it.
   * It lives here because this is the page somebody opens when their library
   * is wrong, and because it belongs beside the findings rather than behind a
   * menu on one track. */
  host.appendChild(el('div', { class: 'toolbar attn-tools' },
    el('button', {
      class: 'btn ghost', html: ico('edit') + '<span>Find and replace…</span>',
      onclick: () => replaceDialog(),
    })));

  paint();
  const off = lib.events.on('change', paint);
  return () => off();
}

/** Find and replace across one field, previewed before anything is written. */
function replaceDialog() {
  const fields = lib.replaceableFields();
  const pick = el('select', { class: 'settings-select', 'aria-label': 'Field' });
  for (const [id, label] of fields) pick.appendChild(el('option', { value: id, text: label }));
  const findIn = el('input', { class: 'input', placeholder: 'feat.', 'aria-label': 'Find' });
  const withIn = el('input', { class: 'input', placeholder: 'ft.', 'aria-label': 'Replace with' });

  let matchCase = false;
  let wholeOnly = false;
  const flag = (label, hint, get, set) => {
    const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-label': label },
      el('span', { class: 'switch-knob' }));
    b.addEventListener('click', () => {
      set(!get());
      b.classList.toggle('is-on', get());
      b.setAttribute('aria-checked', String(get()));
      preview();
    });
    return el('div', { class: 'settings-row' },
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: label }),
        el('div', { class: 'settings-note', text: hint })),
      el('div', { class: 'settings-actions' }, b));
  };

  const out = el('div', { class: 'replace-out' });
  let changes = [];

  const preview = () => {
    const find = findIn.value;
    changes = find
      ? lib.findReplace(pick.value, find, withIn.value, { caseSensitive: matchCase, whole: wholeOnly })
      : [];
    out.textContent = '';
    if (!find) {
      out.appendChild(el('p', { class: 'muted', text: 'Type something to find.' }));
      return;
    }
    if (!changes.length) {
      out.appendChild(el('p', { class: 'muted', text: 'Nothing matches.' }));
      return;
    }
    out.appendChild(el('p', { class: 'replace-count',
      text: `${fmtCount(changes.length, 'track')} would change` }));
    const list = el('ul', { class: 'replace-list' });
    for (const c of changes.slice(0, 40)) {
      list.appendChild(el('li', {},
        el('span', { class: 'replace-from', text: c.from }),
        el('span', { class: 'replace-arrow', text: '→' }),
        el('span', { class: 'replace-to', text: c.to })));
    }
    out.appendChild(list);
    if (changes.length > 40) out.appendChild(el('p', { class: 'muted', text: `and ${changes.length - 40} more` }));
  };

  findIn.addEventListener('input', preview);
  withIn.addEventListener('input', preview);
  pick.addEventListener('change', preview);

  const body = el('div', { class: 'replace-form' },
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'In' }), pick),
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'Find' }), findIn),
    el('div', { class: 'replace-row' },
      el('label', { class: 'replace-label', text: 'Replace with' }), withIn),
    flag('Match case', 'When off, “ft.” also finds “FT.”', () => matchCase, (v) => { matchCase = v; }),
    flag('Match the whole field', 'When on, “Various” changes a field that says exactly that and leaves “Various Artists” alone.', () => wholeOnly, (v) => { wholeOnly = v; }),
    out,
    el('p', { class: 'edit-note', text: 'Saved in Sonora only — your files are never modified. The whole run is one undo.' }));

  preview();

  dialog({
    title: 'Find and replace',
    body,
    width: 560,
    actions: [
      { label: 'Cancel' },
      { label: 'Replace', primary: true, onSelect: async () => {
        if (!changes.length) { toast('Nothing to replace'); return; }
        const n = await lib.applyReplace(pick.value, changes);
        toast(n ? `Changed ${fmtCount(n, 'track')}` : 'Nothing changed');
      } },
    ],
  });
}
