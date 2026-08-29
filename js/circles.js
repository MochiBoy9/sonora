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

  const bar = el('div', { class: 'toolbar circle-bar' }, modeBar,
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

  host.append(head, bar, stage, pins, empty);

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
    rows = stats.byMode(mode);
    const totalSecs = stats.total();
    host.querySelector('#circle-total').textContent = rows.length
      ? `${secondsLabel(totalSecs)} listened · ${rows.length} ${mode === 'year' ? 'years' : mode === 'genre' ? 'genres' : 'artists'}`
      : 'No listening time recorded yet';

    const show = rows.length > 0;
    empty.hidden = show;
    stage.hidden = !show;
    bar.hidden = !show;
    pins.hidden = !show || pinned.size === 0;
    if (!show) return;

    const laid = layout(rows);
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
        el('span', { class: 'circle-tip-share', text: `${(node.data.share * 100).toFixed(1)}% of all listening · ${node.data.plays} tracks` }));
      moveTip(e);
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('pointermove', (e) => { if (hovered === node) moveTip(e); });
    g.addEventListener('pointerleave', () => { if (hovered === node) { hovered = null; tip.hidden = true; } });
    g.addEventListener('focus', () => show({ clientX: 0, clientY: 0 }));
    g.addEventListener('blur', () => { tip.hidden = true; });

    g.addEventListener('click', (e) => {
      if (node.moved) { node.moved = false; return; }   // that was a drag
      if (e.shiftKey || e.altKey) return playFor(node.data);
      togglePin(node.data.key);
    });
    g.addEventListener('dblclick', (e) => { e.preventDefault(); playFor(node.data); });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(node.data.key); }
      if (e.key === 'p' || e.key === 'P') playFor(node.data);
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
