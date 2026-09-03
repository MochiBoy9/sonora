/* circles.js — the Circle Analysis Center.
 *
 * Listening time, drawn as area. One circle per artist, genre or year; the
 * area of each is proportional to the seconds spent there, so the picture is
 * honest at a glance — twice the circle is twice the listening, which is not
 * true of a radius-scaled chart and is the usual way these lie.
 *
 * The layout is packed by hand rather than by a library: circles are placed
 * largest first on an expanding spiral, rejecting positions that collide, then
 * the whole arrangement is scaled to fit the frame. For the sixty slices this
 * ever draws that costs well under a millisecond, and it is deterministic, so
 * switching modes and switching back puts everything where it was.
 *
 * Every transition is interpolated on the shared ticker: no layout thrash, no
 * per-circle animation objects, one pass writing transforms.
 */

import { el, fmtTotal } from './util.js';
import * as stats from './stats.js';
import * as lib from './library.js';
import * as player from './player.js';
import { tick, reduceMotion } from './motion.js';

const NS = 'http://www.w3.org/2000/svg';
const VIEW = 1000;                 // the SVG's own coordinate space
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
};

/* ------------------------------------------------------------------ packing */

/**
 * Places circles largest-first on a spiral, skipping any position that
 * overlaps something already placed. Returns them with x/y in the same units
 * as the radii; the caller scales the result to fit.
 */
function pack(items) {
  const placed = [];
  const STEP = 0.42;                            // radians between attempts
  const GAP = 2;

  for (const item of items) {
    const r = item.r;
    if (!placed.length) { placed.push({ ...item, x: 0, y: 0 }); continue; }

    let best = null;
    // Grow the ring until something fits, then take the first free slot.
    for (let ring = 1; ring < 400 && !best; ring++) {
      const dist = ring * (r * 0.34 + 6);
      for (let a = 0; a < Math.PI * 2; a += STEP) {
        const x = Math.cos(a) * dist;
        const y = Math.sin(a) * dist * 0.86;     // slightly wide: screens are
        let ok = true;
        for (const p of placed) {
          const dx = x - p.x, dy = y - p.y;
          if (dx * dx + dy * dy < (r + p.r + GAP) * (r + p.r + GAP)) { ok = false; break; }
        }
        if (ok) { best = { x, y }; break; }
      }
    }
    placed.push({ ...item, x: best ? best.x : 0, y: best ? best.y : 0 });
  }
  return placed;
}

/**
 * Centres a packed set on its own bounding box and scales it to the frame.
 *
 * Packing starts with the biggest circle at the origin and grows outward, so
 * the arrangement is rarely symmetrical about that point — measuring the box
 * and centring on *it* is what keeps the picture in the middle of the panel
 * instead of drifting toward whichever side filled up last.
 */
function fit(placed) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r); maxY = Math.max(maxY, p.y + p.r);
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = Math.min((VIEW - 40) / w, (VIEW - 40) / h);
  for (const p of placed) {
    p.x = (p.x - cx) * scale;
    p.y = (p.y - cy) * scale;
    p.r *= scale;
  }
  return placed;
}

/**
 * Turns rolled-up totals into laid-out circles.
 *
 * Radius comes from the square root of the seconds, which is what makes area
 * proportional; a floor keeps the long tail clickable.
 */
/* A7: how many circles a drawing can hold.
 *
 * Past a few dozen the picture stops being readable long before it stops being
 * computable: the smallest circles are at the 9px floor, their labels do not
 * fit inside them, and a hundred discs of nearly the same size is a texture
 * rather than a comparison. The tail is therefore drawn as one circle that
 * says how many it stands for — which is more honest than the alternative,
 * because a chart that silently drops its long tail claims the total it is
 * showing is the whole total. */
const MAX_CIRCLES = 32;
export const TAIL_KEY = '\u0000tail';

function withTail(rows) {
  if (rows.length <= MAX_CIRCLES) return rows;
  const head = rows.slice(0, MAX_CIRCLES - 1);
  const tail = rows.slice(MAX_CIRCLES - 1);
  const seconds = tail.reduce((n, r) => n + (r.seconds || 0), 0);
  return head.concat([{
    key: TAIL_KEY,
    label: `and ${tail.length} more`,
    seconds,
    tail: tail.length,
  }]);
}

function layout(rows) {
  if (!rows.length) return [];
  const top = rows[0].seconds || 1;
  const items = rows.map((row) => ({
    ...row,
    r: Math.max(9, Math.sqrt(row.seconds / top) * 100),
  }));
  return fit(pack(items));
}

/* ------------------------------------------------------------------ view */

export function mountCircles(host) {
  const modeKey = 'sonora:circle-mode';
  let mode = 'artist';
  try { const v = localStorage.getItem(modeKey); if (stats.isMode(v)) mode = v; } catch { /* private mode */ }

  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'Analysis' }),
    el('h1', { class: 'page-title', text: 'Circle Analysis Center' }),
    el('p', { class: 'page-sub', id: 'circle-total' }));

  const modeBar = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Group listening time by' });
  for (const m of stats.MODES) {
    modeBar.appendChild(el('button', {
      class: 'seg' + (m.id === mode ? ' is-on' : ''),
      role: 'tab', text: m.label, data: { mode: m.id },
      'aria-selected': String(m.id === mode),
      onclick: () => setMode(m.id),
    }));
  }

  // Two different resets, kept apart on purpose: one undoes an arrangement,
  // the other throws away months of listening. They should never be one button.
  const clearBtn = el('button', {
    class: 'btn ghost sm', text: 'Reset view', hidden: true,
    onclick: () => clearArrangement(),
  });
  const resetBtn = el('button', {
    class: 'btn ghost sm', text: 'Reset data',
    onclick: () => host.dispatchEvent(new CustomEvent('circles:reset', { bubbles: true })),
  });

  /* A2: any period, reviewed.
   *
   * The same three modes over a window rather than over all time, which turns
   * one chart into a different question every time you move it: this month,
   * this year, the fortnight something took over completely. It is not "your
   * year in music" once a December — that is a report, and this is an
   * instrument.
   *
   * "All time" is kept and kept first, because it is the only setting that can
   * answer for listening from before the day log existed. Every other preset
   * reads the log, so they are offered only once there is a log to read. */
  const PERIODS = [
    { id: 'all', label: 'All time' },
    { id: '7', label: 'Last 7 days', days: 6 },
    { id: '30', label: 'Last 30 days', days: 29 },
    { id: '90', label: 'Last 90 days', days: 89 },
    { id: '365', label: 'Last year', days: 364 },
  ];
  const periodKey = 'sonora:circle-period';
  let period = 'all';
  try { const v = localStorage.getItem(periodKey); if (PERIODS.some((p) => p.id === v)) period = v; } catch { /* private mode */ }

  const periodBar = el('div', { class: 'segmented quiet', role: 'tablist', 'aria-label': 'Over what period' });
  for (const p of PERIODS) {
    periodBar.appendChild(el('button', {
      class: 'seg' + (p.id === period ? ' is-on' : ''),
      role: 'tab', text: p.label, data: { period: p.id },
      'aria-selected': String(p.id === period),
      onclick: () => setPeriod(p.id),
    }));
  }

  const windowOf = () => {
    const p = PERIODS.find((x) => x.id === period);
    if (!p || p.days === undefined) return { from: null, to: null };
    return { from: stats.daysAgo(p.days), to: stats.dayKey() };
  };

  function setPeriod(next) {
    if (next === period || !PERIODS.some((p) => p.id === next)) return;
    period = next;
    try { localStorage.setItem(periodKey, period); } catch { /* private mode */ }
    for (const b of periodBar.children) {
      const on = b.dataset.period === period;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    // Pins are about a chart, and this is a different chart.
    pinned.clear();
    build();
  }

  const bar = el('div', { class: 'toolbar circle-bar' }, modeBar, periodBar,
    el('span', {
      class: 'circle-hint label',
      text: 'Click to pin · double-click to play · drag to arrange',
    }), clearBtn, resetBtn);

  const svg = svgEl('svg', {
    class: 'circle-canvas', viewBox: `0 0 ${VIEW} ${VIEW}`,
    role: 'img', 'aria-label': 'Listening time by ' + mode,
  });
  const gRoot = svgEl('g', { class: 'circle-root' });
  svg.appendChild(gRoot);

  const tip = el('div', { class: 'circle-tip', hidden: true });
  const pins = el('div', { class: 'circle-pins' });
  const stage = el('div', { class: 'circle-stage' }, svg, tip);

  const empty = el('div', { class: 'empty circle-empty' },
    el('div', { class: 'empty-ico', html: '<svg class="ico"><use href="#i-circles"/></svg>' }),
    el('h3', { text: 'Nothing measured yet' }),
    el('p', { text: 'Listening time is counted while audio is actually playing. Play something for a few seconds and it will appear here.' }));

  /* A3: the same figures, as figures.
   *
   * The drawing is a hand-packed SVG — which is to say it is a picture of
   * numbers, and a screen reader is handed a `role="img"` with a one-line
   * label. That is the whole of what it can know about months of listening.
   *
   * So the numbers are also a table. Not a visually-hidden one: a table is
   * frequently the faster way to read this even with the picture in front of
   * you — "how much more is the first than the fourth" is a question a sorted
   * column answers and a packed circle does not — so it is offered to
   * everybody, and it is the tail circle's own destination.
   *
   * It is built from `rows`, the same array the circles are laid out from, so
   * the two cannot disagree. */
  const tableBtn = el('button', {
    class: 'btn ghost sm', 'aria-expanded': 'false', 'aria-controls': 'circle-table',
    text: 'As a table',
    onclick: () => showTable(),
  });
  bar.appendChild(tableBtn);

  const find = el('input', {
    type: 'search', class: 'circle-find', placeholder: 'Find…',
    'aria-label': 'Find in the table',
  });
  const tbody = el('tbody');
  const table = el('div', { class: 'circle-table', id: 'circle-table', hidden: true },
    el('div', { class: 'circle-table-head' }, find),
    el('table', {},
      el('caption', { class: 'sr-only', text: 'Listening time, longest first' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: 'Name' }),
        el('th', { scope: 'col', class: 'num', text: 'Time' }),
        el('th', { scope: 'col', class: 'num', text: 'Share' }),
        el('th', { scope: 'col', class: 'num', text: 'Tracks' }))),
      tbody));

  find.addEventListener('input', () => paintTable());

  /** Opens or closes the table. `force` opens it without toggling. */
  function showTable(force) {
    const open = force ? true : table.hidden;
    table.hidden = !open;
    tableBtn.setAttribute('aria-expanded', String(open));
    tableBtn.textContent = open ? 'Hide the table' : 'As a table';
    if (open) { paintTable(); find.focus(); }
  }

  function paintTable() {
    if (table.hidden) return;
    const q = find.value.trim().toLowerCase();
    const shown = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
    tbody.textContent = '';
    if (!shown.length) {
      tbody.appendChild(el('tr', {}, el('td', { colSpan: '4', class: 'muted', text: 'Nothing matches.' })));
      return;
    }
    for (const r of shown) {
      const tr = el('tr', {},
        el('th', { scope: 'row' },
          el('button', {
            class: 'linkish', text: r.label,
            /* A7's other half: finding one in a hundred. Choosing a row pins
               its circle and scrolls the drawing back into view, so the table
               is a way *into* the picture rather than a replacement for it. */
            onclick: () => {
              if (!pinned.has(r.key)) togglePin(r.key);
              stage.scrollIntoView({ behavior: reduceMotion.matches ? 'instant' : 'smooth', block: 'nearest' });
            },
          })),
        el('td', { class: 'num', text: secondsLabel(r.seconds) }),
        el('td', { class: 'num', text: (r.share * 100).toFixed(1) + '%' }),
        el('td', { class: 'num', text: String(r.plays) }));
      tr.classList.toggle('is-pinned', pinned.has(r.key));
      tbody.appendChild(tr);
    }
  }

  host.append(head, bar, stage, pins, table, empty);

  /* ---------------------------------------------------------------- state */

  const nodes = new Map();          // key -> { g, circle, label, value, cur, target }
  const pinned = new Set();
  let rows = [];
  let hovered = null;
  let dragging = null;
  let stopTick = null;

  const secondsLabel = (s) => (s >= 60 ? fmtTotal(s) : `${Math.round(s)} sec`);

  function setMode(next) {
    if (!stats.isMode(next) || next === mode) return;
    mode = next;
    try { localStorage.setItem(modeKey, mode); } catch { /* private mode */ }
    for (const b of modeBar.children) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    svg.setAttribute('aria-label', 'Listening time by ' + mode);
    build();
  }

  /* ---------------------------------------------------------------- build */

  function build() {
    const win = windowOf();
    rows = stats.byMode(mode, win);
    const totalSecs = rows.reduce((n, r) => n + r.seconds, 0);
    const named = mode === 'year' ? 'years' : mode === 'genre' ? 'genres' : 'artists';
    const over = period === 'all' ? '' : ' · ' +
      (PERIODS.find((p) => p.id === period) || {}).label.toLowerCase();
    host.querySelector('#circle-total').textContent = rows.length
      ? `${secondsLabel(totalSecs)} listened · ${rows.length} ${named}${over}`
      /* A window with nothing in it is not the same news as an empty library,
         and saying "no listening time recorded yet" to somebody who has been
         listening for a year but not this week would be a lie. */
      : period === 'all' ? 'No listening time recorded yet'
      : 'Nothing played in that period';

    // Only offered once there is a history to slice. Before that every preset
    // gives the same empty chart, which teaches that the control is broken.
    periodBar.hidden = stats.dayCount() < 2;

    const show = rows.length > 0;
    empty.hidden = show;
    stage.hidden = !show;
    /* The toolbar survives an empty window, because the window is set from it:
       hiding the control that caused the emptiness leaves no way back. It only
       goes away when there is nothing recorded at all. */
    bar.hidden = !show && period === 'all';
    pins.hidden = !show || pinned.size === 0;
    // Nothing measured, nothing to tabulate — and the button that opens the
    // table should not be there to be pressed either.
    if (!show) { table.hidden = true; tableBtn.setAttribute('aria-expanded', 'false'); return; }

    const laid = layout(withTail(rows));
    const seen = new Set();

    for (const item of laid) {
      seen.add(item.key);
      let node = nodes.get(item.key);
      if (!node) {
        node = createNode(item);
        nodes.set(item.key, node);
        gRoot.appendChild(node.g);
        // New arrivals grow from the middle rather than popping in.
        node.cur = { x: VIEW / 2, y: VIEW / 2, r: 0, o: 0 };
      }
      node.data = item;
      node.g.classList.toggle('is-tail', item.key === TAIL_KEY);
      // A circle the listener has dragged keeps where they put it. The layout
      // is recomputed every time the totals move — every twenty seconds while
      // music plays — and an arrangement that dissolves under you is worse
      // than no arrangement at all.
      const held = node.fixed && node.target;
      node.target = {
        x: held ? held.x : VIEW / 2 + item.x,
        y: held ? held.y : VIEW / 2 + item.y,
        r: item.r,
        o: pinned.size && !pinned.has(item.key) ? 0.4 : 1,
      };
      paintNode(node, item);
    }

    for (const [key, node] of nodes) {
      if (seen.has(key)) continue;
      node.target = { ...node.cur, r: 0, o: 0 };
      node.dead = true;
    }

    paintPins();
    paintTable();
    clearBtn.hidden = !arranged();
    run();
  }

  function createNode(item) {
    const g = svgEl('g', { class: 'circle-node', tabindex: '0', role: 'button' });
    const circle = svgEl('circle', { class: 'circle-disc', r: 0 });
    const ring = svgEl('circle', { class: 'circle-ring', r: 0 });
    const label = svgEl('text', { class: 'circle-label', 'text-anchor': 'middle', y: '-4' });
    const value = svgEl('text', { class: 'circle-value', 'text-anchor': 'middle', y: '24' });
    g.append(circle, ring, label, value);

    const node = { g, circle, ring, label, value, cur: null, target: null, data: item, offset: null };

    const show = (e) => {
      hovered = node;
      tip.hidden = false;
      tip.innerHTML = '';
      tip.append(
        el('strong', { text: node.data.label }),
        el('span', { class: 'circle-tip-value', text: secondsLabel(node.data.seconds) }),
        el('span', { class: 'circle-tip-share', text: node.data.tail
          ? 'Everything below the biggest few, added up. Open the table to read them.'
          : `${(node.data.share * 100).toFixed(1)}% of all listening · ${node.data.plays} tracks` }));
      moveTip(e);
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('pointermove', (e) => { if (hovered === node) moveTip(e); });
    g.addEventListener('pointerleave', () => { if (hovered === node) { hovered = null; tip.hidden = true; } });
    g.addEventListener('focus', () => show({ clientX: 0, clientY: 0 }));
    g.addEventListener('blur', () => { tip.hidden = true; });

    /* The tail circle stands for many things at once, so it is not one of
       them: it cannot be pinned, and there is nothing to play. It opens the
       table instead, which is where the things it stands for are listed. */
    const isTail = () => node.data.key === TAIL_KEY;

    g.addEventListener('click', (e) => {
      if (node.moved) { node.moved = false; return; }   // that was a drag
      if (isTail()) return showTable(true);
      if (e.shiftKey || e.altKey) return playFor(node.data);
      togglePin(node.data.key);
    });
    g.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (isTail()) return showTable(true);
      playFor(node.data);
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isTail()) showTable(true); else togglePin(node.data.key);
      }
      if ((e.key === 'p' || e.key === 'P') && !isTail()) playFor(node.data);
    });

    // Dragging: the arrangement is yours to rearrange.
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = node;
      node.moved = false;
      const pt = toView(e);
      node.offset = { x: pt.x - node.cur.x, y: pt.y - node.cur.y };
      g.setPointerCapture(e.pointerId);
      g.classList.add('is-dragging');
    });
    g.addEventListener('pointermove', (e) => {
      if (dragging !== node || !node.offset) return;
      const pt = toView(e);
      node.moved = true;
      node.target = { ...node.target, x: pt.x - node.offset.x, y: pt.y - node.offset.y };
      node.fixed = true;
      clearBtn.hidden = false;
      run();
    });
    const endDrag = (e) => {
      if (dragging !== node) return;
      dragging = null;
      node.offset = null;
      try { g.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      g.classList.remove('is-dragging');
    };
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);

    return node;
  }

  function paintNode(node, item) {
    node.g.setAttribute('aria-label',
      `${item.label}, ${secondsLabel(item.seconds)}, ${(item.share * 100).toFixed(1)} percent of listening`);
    node.g.classList.toggle('is-pinned', pinned.has(item.key));
    const room = item.r;
    node.label.textContent = room > 52 ? clip(item.label, Math.floor(room / 7)) : '';
    node.value.textContent = room > 72 ? secondsLabel(item.seconds) : '';
    // Hue walks with rank so neighbouring circles never share a colour.
    const t = Math.min(1, item.share * 2.4);
    node.circle.style.setProperty('--t', t.toFixed(3));
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

  /* ---------------------------------------------------------------- pins */

  function togglePin(key) {
    if (pinned.has(key)) pinned.delete(key); else pinned.add(key);
    build();
  }

  /** Unpins everything and lets the packer have the arrangement back. */
  function clearArrangement() {
    pinned.clear();
    for (const node of nodes.values()) node.fixed = false;
    build();
  }

  /** Whether there is an arrangement to undo — a pin, or a circle moved. */
  const arranged = () => pinned.size > 0 || [...nodes.values()].some((n) => n.fixed);

  function paintPins() {
    pins.textContent = '';
    if (!pinned.size) { pins.hidden = true; return; }
    pins.hidden = false;
    const chosen = rows.filter((r) => pinned.has(r.key));
    const top = chosen.reduce((n, r) => Math.max(n, r.seconds), 1);

    pins.appendChild(el('span', { class: 'label', text: 'Pinned' }));
    for (const row of chosen) {
      const chip = el('div', { class: 'circle-pin' },
        el('span', { class: 'circle-pin-name', text: row.label }),
        el('span', { class: 'circle-pin-value mono', text: secondsLabel(row.seconds) }),
        el('button', {
          class: 'icon-btn sm', 'aria-label': `Unpin ${row.label}`,
          html: '<svg class="ico"><use href="#i-close"/></svg>',
          onclick: () => togglePin(row.key),
        }));
      chip.style.setProperty('--fill', (row.seconds / top).toFixed(3));
      pins.appendChild(chip);
    }
    if (chosen.length > 1) {
      const [a, b] = chosen;
      const ratio = b.seconds ? a.seconds / b.seconds : 0;
      pins.appendChild(el('span', { class: 'circle-compare label',
        text: `${a.label} is ${ratio.toFixed(1)}× ${b.label}` }));
    }
  }

  /* ---------------------------------------------------------------- play */

  /** Plays everything behind a slice, so the chart is a way in, not a poster. */
  function playFor(row) {
    const tracks = lib.allTracks().filter((t) => {
      if (mode === 'genre') return (t.genre ? t.genre.toLowerCase() : '~none') === (row.label === 'No genre' ? '~none' : row.label.toLowerCase());
      if (mode === 'year') return String(t.year || '') === (row.label === 'No year' ? '' : row.label);
      return t.artistKey === row.key;
    });
    if (tracks.length) player.playTracks(tracks, 0, { type: 'analysis', key: row.key, label: row.label });
  }

  /* ---------------------------------------------------------------- frame */

  function toView(e) {
    const box = svg.getBoundingClientRect();
    const size = Math.min(box.width, box.height) || 1;
    return {
      x: ((e.clientX - box.left - (box.width - size) / 2) / size) * VIEW,
      y: ((e.clientY - box.top - (box.height - size) / 2) / size) * VIEW,
    };
  }

  function moveTip(e) {
    const box = stage.getBoundingClientRect();
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
  }

  /** Interpolates every circle toward its target; stops when all have arrived. */
  function run() {
    if (stopTick) return;
    stopTick = tick((dt) => {
      let moving = false;
      const k = reduceMotion.matches ? 1 : Math.min(1, dt / 130);

      for (const [key, node] of nodes) {
        const t = node.target;
        if (!t) continue;
        if (!node.cur) node.cur = { ...t };
        const c = node.cur;
        c.x += (t.x - c.x) * k;
        c.y += (t.y - c.y) * k;
        c.r += (t.r - c.r) * k;
        c.o += ((t.o ?? 1) - c.o) * k;

        if (Math.abs(t.x - c.x) > 0.3 || Math.abs(t.y - c.y) > 0.3 ||
            Math.abs(t.r - c.r) > 0.3 || Math.abs((t.o ?? 1) - c.o) > 0.01) moving = true;

        node.g.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
        node.g.style.opacity = c.o.toFixed(3);
        node.circle.setAttribute('r', Math.max(0, c.r).toFixed(1));
        node.ring.setAttribute('r', Math.max(0, c.r + 3).toFixed(1));

        if (node.dead && c.r < 0.5) { node.g.remove(); nodes.delete(key); }
      }

      if (!moving) { stopTick = null; return false; }
      void 0;
    });
  }

  /* ---------------------------------------------------------------- wiring */

  const offStats = stats.events.on('change', () => {
    // Listening time accrues while you watch; refresh the picture, but not
    // more often than it can possibly have changed meaningfully.
    if (host.isConnected) build();
  });
  const offChange = lib.events.on('change', () => { if (host.isConnected) build(); });

  build();

  return {
    refresh: build,
    destroy() {
      offStats();
      offChange();
      if (stopTick) { stopTick(); stopTick = null; }
      nodes.clear();
    },
  };
}
