/* sound.js — the Sound page.
 *
 * A channel strip, not a settings list. The centre of it is the response
 * curve: the actual combined shape of ten filters, asked of the filters
 * themselves rather than drawn from the slider positions, so what is on screen
 * is what is in the signal — including the places where neighbouring bands
 * overlap and add, which is where an equaliser surprises you.
 *
 * You can drag the curve. Each band has a handle on it, and dragging one is
 * the same edit as moving its fader; both write to the same place and both
 * redraw from the same measurement.
 */

import { el, ico } from './util.js';
import * as rack from './audio.js';
import * as player from './player.js';
import { toast, promptDialog } from './ui.js';
import { enter, tick } from './motion.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/** The curve is drawn over this range, in Hz and in dB. */
const F_MIN = 20, F_MAX = 22050, DB = 15;
const W = 1000, H = 400;                     // the SVG's own coordinates
const POINTS = 220;

const xOf = (hz) => (Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
const yOf = (db) => H / 2 - (db / DB) * (H / 2);
const dbOf = (y) => ((H / 2 - y) / (H / 2)) * DB;

/** Frequencies to sample, log-spaced, allocated once. */
const freqs = new Float32Array(POINTS);
for (let i = 0; i < POINTS; i++) {
  freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (POINTS - 1));
}

const hz = (v) => (v >= 1000 ? (v % 1000 ? (v / 1000).toFixed(1) : v / 1000) + 'k' : String(v));
const dbText = (v) => (v > 0 ? '+' : '') + v.toFixed(1);

/* ------------------------------------------------------------------ view */

export function mountSound(host) {
  const offs = [];
  const on = (target, evt, fn) => offs.push(target.events.on(evt, fn));

  host.append(
    el('header', { class: 'page-head' },
      el('p', { class: 'eyebrow', text: 'Sound' }),
      el('h1', { class: 'page-title', text: 'The Rack' }),
      el('p', { class: 'page-sub', id: 'rack-sub' })));

  /* When a record is driving the chain, the controls below are still live but
     they are not editing what you would assume. Saying so is the whole of the
     fix — a page that silently means something different is worse than one
     that carries an extra line. */
  const boundLine = el('div', { class: 'rack-bound', hidden: true });
  host.appendChild(boundLine);

  function paintBound() {
    const b = rack.boundRack();
    boundLine.hidden = !b;
    if (!b) return;
    boundLine.textContent = '';
    boundLine.append(
      el('p', { class: 'rack-bound-text' },
        el('span', { text: 'This chain came with ' }),
        el('b', { text: b.label || 'the record playing' }),
        el('span', { text: `. Your own rack is parked, and comes back when ${b.scope === 'album' ? 'the album' : 'the artist'} does.` })),
      el('button', {
        class: 'btn ghost sm', text: 'Keep changes',
        title: 'Save the rack as it stands now onto this record',
        onclick: async () => {
          const name = await rack.keepBoundRack();
          toast(name ? `Saved as “${name}”` : 'Nothing to save');
        },
      }),
      el('button', {
        class: 'btn ghost sm', text: 'Detach',
        onclick: async () => {
          await rack.unbindFrom(b.scope, b.key);
          await rack.followTrack(player.state.current);
          toast('Back to your rack');
        },
      }));
  }

  const grid = el('div', { class: 'rack' });
  host.appendChild(grid);

  const left = el('div', { class: 'rack-panel' });
  const right = el('div', {});
  grid.append(left, right);

  /* ---- head ------------------------------------------------------------ */

  const bypass = el('button', {
    class: 'btn ghost sm', title: 'Compare with the rack switched out (B)',
    html: ico('refresh') + '<span>Bypass</span>',
    onclick: () => { rack.set({ on: !rack.state.on }); paintAll(); },
  });
  const resetBtn = el('button', {
    class: 'btn ghost sm', text: 'Reset',
    onclick: () => { rack.reset(); paintAll(); toast('Rack reset'); },
  });
  /* The unit's own plate and lamp. The lamp is not decoration: it is lit while
     the rack is in circuit, amber while it is bypassed, and it flickers with
     what is actually passing through. A lamp that is always on is a sticker. */
  const lamp = el('i', { class: 'rack-lamp', 'aria-hidden': 'true' });
  const plate = el('span', { class: 'rack-plate' }, lamp,
    el('b', { text: 'SONORA' }), el('span', { text: 'RK-10' }));

  left.appendChild(el('div', { class: 'rack-head' },
    el('span', { class: 'label', text: 'Equaliser' }), plate, bypass, resetBtn));

  /* ---- presets --------------------------------------------------------- */

  const strip = el('div', { class: 'preset-strip' });
  for (const p of rack.PRESETS) {
    strip.appendChild(el('button', {
      class: 'preset', text: p.label, data: { preset: p.id },
      onclick: () => { rack.usePreset(p.id); paintAll(); },
    }));
  }
  left.appendChild(strip);

  /* ---- curve ----------------------------------------------------------- */

  const stage = el('div', { class: 'eq-stage' });

  /* The path layer is stretched to fill the box — that is what makes a curve
     read as a curve rather than as a thin band in the middle. Stretching it
     would also stretch every label and turn every handle into an ellipse, so
     the text and the handles are HTML on top instead, positioned in percent.
     Two layers, each drawn the way it wants to be. */
  const svg = svgEl('svg', {
    class: 'eq-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    'aria-hidden': 'true', focusable: 'false',
  });

  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'eq-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0', 'stop-color': 'rgb(var(--accent-rgb))', 'stop-opacity': '.55' }),
    svgEl('stop', { offset: '1', 'stop-color': 'rgb(var(--accent-2-rgb))', 'stop-opacity': '.02' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const gGrid = svgEl('g', { class: 'eq-grid' });
  const HZ_MARKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const DB_MARKS = [12, 6, 0, -6, -12];
  for (const f of HZ_MARKS) {
    const x = xOf(f);
    gGrid.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: H }));
  }
  for (const d of DB_MARKS) {
    const y = yOf(d);
    const l = svgEl('line', { x1: 0, y1: y, x2: W, y2: y });
    if (!d) l.setAttribute('class', 'zero');
    gGrid.appendChild(l);
  }
  svg.appendChild(gGrid);

  const fill = svgEl('path', { class: 'eq-fill' });
  const line = svgEl('path', { class: 'eq-line' });
  svg.append(fill, line);
  stage.appendChild(svg);

  const overlay = el('div', { class: 'eq-overlay' });
  for (const f of HZ_MARKS) {
    overlay.appendChild(el('span', {
      class: 'eq-mark eq-mark-x', text: hz(f),
      style: `left:${(xOf(f) / W) * 100}%`,
    }));
  }
  for (const d of DB_MARKS) {
    overlay.appendChild(el('span', {
      class: 'eq-mark eq-mark-y', text: dbText(d),
      style: `top:${(yOf(d) / H) * 100}%`,
    }));
  }
  stage.appendChild(overlay);

  /* One handle per band, sitting on the curve. Dragging one is the same edit
     as moving its fader; both write to the same place. */
  const grabber = el('div', { class: 'eq-handles' });
  const handles = rack.BANDS.map((f, i) => {
    const dot = el('button', {
      class: 'eq-handle', type: 'button',
      role: 'slider', 'aria-valuemin': '-12', 'aria-valuemax': '12',
      'aria-label': `${hz(f)} hertz`,
      style: `left:${(xOf(f) / W) * 100}%`,
    }, el('span', { class: 'eq-handle-cap' }));
    grabber.appendChild(dot);
    bindHandle(dot, i);
    return { dot, i };
  });
  stage.appendChild(grabber);
  left.appendChild(stage);

  /* ---- faders ---------------------------------------------------------- */

  const faders = el('div', { class: 'eq-faders' });
  const faderCells = rack.BANDS.map((f, i) => {
    const input = el('input', {
      type: 'range', min: '-12', max: '12', step: '.5',
      'aria-label': `${hz(f)} hertz`,
      oninput: (e) => { rack.setBand(i, +e.target.value); paintAll(); },
    });
    const db = el('span', { class: 'fader-db' });
    const cell = el('div', { class: 'fader' },
      db, input, el('span', { class: 'fader-hz', text: hz(f) }));
    faders.appendChild(cell);
    return { cell, input, db };
  });
  left.appendChild(faders);

  /* ---- modules --------------------------------------------------------- */

  const module = (title, ...rows) => {
    const p = el('div', { class: 'rack-panel' },
      el('div', { class: 'rack-head' }, el('span', { class: 'label', text: title })));
    p.append(...rows.filter(Boolean));
    right.appendChild(p);
    return p;
  };

  /** One labelled slider with a live readout. */
  const knobs = [];
  function knob(name, opts) {
    const { min, max, step = 1, get, set, format, hint } = opts;
    const val = el('span', { class: 'rack-val' });
    const input = el('input', {
      type: 'range', min: String(min), max: String(max), step: String(step),
      'aria-label': name, title: hint || name,
      oninput: (e) => { set(+e.target.value); paintAll(); },
    });
    const row = el('div', { class: 'rack-row' },
      el('span', { class: 'rack-name', text: name, title: hint || name }), input, val);
    knobs.push({ row, input, val, get, format, neutral: opts.neutral });
    return row;
  }

  function toggleRow(name, get, set, hint) {
    const btn = el('button', {
      class: 'preset', text: 'Off',
      onclick: () => { set(!get()); paintAll(); },
    });
    const row = el('div', { class: 'rack-row' },
      el('span', { class: 'rack-name', text: name, title: hint || name }),
      el('span', {}), btn);
    knobs.push({ row, toggle: btn, get });
    return row;
  }

  module('Tone',
    knob('Preamp', { min: -12, max: 12, step: .5, neutral: 0,
      get: () => rack.state.preamp, set: (v) => rack.set({ preamp: v }),
      format: (v) => dbText(v) + ' dB',
      hint: 'Level into the rack. Turn it down if boosting makes the limiter work.' }),
    knob('Bass', { min: -12, max: 12, step: .5, neutral: 0,
      get: () => rack.state.bass, set: (v) => rack.set({ bass: v }),
      format: (v) => dbText(v) + ' dB', hint: 'A shelf at 110 Hz, under the whole bottom end' }),
    knob('Treble', { min: -12, max: 12, step: .5, neutral: 0,
      get: () => rack.state.treble, set: (v) => rack.set({ treble: v }),
      format: (v) => dbText(v) + ' dB', hint: 'A shelf at 6 kHz, over the whole top end' }));

  module('Pitch & speed',
    knob('Pitch', { min: -12, max: 12, step: 1, neutral: 0,
      get: () => rack.state.pitch, set: (v) => rack.set({ pitch: v }),
      format: (v) => (v > 0 ? '+' : '') + v + (Math.abs(v) === 1 ? ' semi' : ' semis'),
      hint: 'Changes the key without changing the tempo' }),
    knob('Speed', { min: 50, max: 200, step: 1, neutral: 100,
      get: () => Math.round(rack.state.speed * 100), set: (v) => rack.set({ speed: v / 100 }),
      format: (v) => (v / 100).toFixed(2) + '×',
      hint: 'Changes the tempo without changing the key' }),
    toggleRow('Keep the key', () => rack.state.preservePitch, (v) => rack.set({ preservePitch: v }),
      'Off, speed drags the pitch with it — the sound of a record played fast'));

  module('Stereo',
    knob('Width', { min: 0, max: 200, step: 1, neutral: 100,
      get: () => Math.round(rack.state.width * 100), set: (v) => rack.set({ width: v / 100 }),
      format: (v) => (v === 0 ? 'Mono' : v + '%'),
      hint: '0 is mono, 100 is as recorded, 200 pushes the sides out' }),
    knob('Balance', { min: -100, max: 100, step: 1, neutral: 0,
      get: () => Math.round(rack.state.balance * 100), set: (v) => rack.set({ balance: v / 100 }),
      format: (v) => (v === 0 ? 'Centre' : (v < 0 ? 'L' : 'R') + Math.abs(v)) }));

  module('Dynamics',
    toggleRow('Compressor', () => rack.state.comp.on, (v) => rack.setComp({ on: v }),
      'Evens out the loud and the quiet'),
    knob('Threshold', { min: -60, max: 0, step: 1, neutral: -24,
      get: () => rack.state.comp.threshold, set: (v) => rack.setComp({ threshold: v }),
      format: (v) => v + ' dB' }),
    knob('Ratio', { min: 1, max: 20, step: .5, neutral: 3,
      get: () => rack.state.comp.ratio, set: (v) => rack.setComp({ ratio: v }),
      format: (v) => v + ':1' }),
    knob('Attack', { min: 0, max: 200, step: 1, neutral: 4,
      get: () => Math.round(rack.state.comp.attack * 1000), set: (v) => rack.setComp({ attack: v / 1000 }),
      format: (v) => v + ' ms' }),
    knob('Release', { min: 20, max: 1000, step: 10, neutral: 250,
      get: () => Math.round(rack.state.comp.release * 1000), set: (v) => rack.setComp({ release: v / 1000 }),
      format: (v) => v + ' ms' }),
    toggleRow('Limiter', () => rack.state.limiter, (v) => rack.set({ limiter: v }),
      'A brickwall at −1.5 dB, so a boost cannot clip'));

  const spaceStrip = el('div', { class: 'preset-strip' });
  for (const [id, spec] of Object.entries(rack.SPACES)) {
    spaceStrip.appendChild(el('button', {
      class: 'preset', text: spec.label, data: { space: id },
      onclick: () => { rack.setSpace({ kind: id, on: true }); paintAll(); },
    }));
  }
  module('Space',
    toggleRow('Reverb', () => rack.state.space.on, (v) => rack.setSpace({ on: v }),
      'A room, made out of noise — no samples, nothing downloaded'),
    spaceStrip,
    knob('Amount', { min: 0, max: 100, step: 1, neutral: 22,
      get: () => Math.round(rack.state.space.mix * 100), set: (v) => rack.setSpace({ mix: v / 100 }),
      format: (v) => v + '%' }));

  /* ---- saved racks ----------------------------------------------------- */

  const rackStrip = el('div', { class: 'preset-strip' });
  const saveBtn = el('button', {
    class: 'btn ghost sm', html: ico('plus') + '<span>Save this rack</span>',
    onclick: () => promptDialog({
      title: 'Name this rack',
      label: 'Name',
      placeholder: 'Late night, car, headphones…',
      confirm: 'Save',
      onConfirm: async (name) => {
        if (!name) return;
        await rack.saveRack(name.slice(0, 40));
        paintRacks();
        toast('Saved “' + name.slice(0, 40) + '”');
      },
    }),
  });
  const mine = module('Your racks', rackStrip, saveBtn);
  mine.classList.add('rack-mine');

  async function paintRacks() {
    const list = await rack.savedRacks();
    rackStrip.textContent = '';
    if (!list.length) {
      rackStrip.appendChild(el('span', { class: 'rack-note', text: 'Nothing saved yet. Build a sound and keep it.' }));
      return;
    }
    for (const r of list) {
      rackStrip.appendChild(el('button', {
        class: 'preset', text: r.name, title: 'Load, or right-click to delete',
        onclick: () => { rack.loadRack(r); paintAll(); toast('Loaded “' + r.name + '”'); },
        oncontextmenu: async (e) => {
          e.preventDefault();
          await rack.deleteRack(r.name);
          paintRacks();
          toast('Deleted “' + r.name + '”');
        },
      }));
    }
  }
  paintRacks();

  /* ---- dragging the curve --------------------------------------------- */

  function bindHandle(g, i) {
    const toDb = (e) => {
      const box = stage.getBoundingClientRect();
      const ratio = (e.clientY - box.top) / Math.max(1, box.height);
      return Math.max(-12, Math.min(12, Math.round((1 - ratio * 2) * DB * 2) / 2));
    };
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.dataset.drag = '1';
      g.focus();
    });
    g.addEventListener('pointermove', (e) => {
      if (!g.dataset.drag) return;
      rack.setBand(i, toDb(e));
      paintAll();
    });
    const end = (e) => {
      if (!g.dataset.drag) return;
      delete g.dataset.drag;
      try { g.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', () => { rack.setBand(i, 0); paintAll(); });
    g.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 3 : 0.5;
      if (e.key === 'ArrowUp') rack.setBand(i, rack.state.eq[i] + step);
      else if (e.key === 'ArrowDown') rack.setBand(i, rack.state.eq[i] - step);
      else if (e.key === 'Home' || e.key === 'Backspace') rack.setBand(i, 0);
      else return;
      e.preventDefault();
      paintAll();
    });
  }

  /* ---- painting -------------------------------------------------------- */

  function paintCurve() {
    const db = rack.state.on ? rack.response(freqs) : new Float32Array(POINTS);
    let d = '';
    for (let i = 0; i < POINTS; i++) {
      const x = (i / (POINTS - 1)) * W;
      const y = Math.max(-40, Math.min(H + 40, yOf(db[i])));
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    line.setAttribute('d', d);
    fill.setAttribute('d', d + `L${W} ${yOf(0)}L0 ${yOf(0)}Z`);

    for (const h of handles) {
      const v = rack.state.on ? rack.state.eq[h.i] : 0;
      h.dot.style.top = ((yOf(v) / H) * 100).toFixed(2) + '%';
      h.dot.classList.toggle('is-set', Math.abs(v) > 0.05);
      h.dot.setAttribute('aria-valuenow', String(v));
      h.dot.setAttribute('aria-valuetext',
        `${hz(rack.BANDS[h.i])} hertz, ${dbText(v)} decibels`);
      h.dot.dataset.db = dbText(v);
    }
  }

  function paintAll() {
    /* Whether the unit is in circuit is state, not signal, so it is written
       here rather than from the ticker. The ticker stops when nothing is
       playing — which is exactly when somebody is most likely to be pressing
       Bypass and looking at the lamp to see whether it did anything. */
    grid.classList.toggle('is-live', rack.state.on);
    grid.classList.toggle('is-bypassed', !rack.state.on);
    paintCurve();

    faderCells.forEach((f, i) => {
      const v = rack.state.eq[i];
      if (document.activeElement !== f.input) f.input.value = String(v);
      f.db.textContent = dbText(v);
      f.cell.classList.toggle('is-boosted', v > 0.05);
      f.cell.classList.toggle('is-cut', v < -0.05);
    });

    for (const k of knobs) {
      if (k.toggle) {
        const on = !!k.get();
        k.toggle.textContent = on ? 'On' : 'Off';
        k.toggle.classList.toggle('is-on', on);
        k.row.classList.toggle('is-set', on);
        continue;
      }
      const v = k.get();
      if (document.activeElement !== k.input) k.input.value = String(v);
      k.val.textContent = k.format ? k.format(v) : String(v);
      k.row.classList.toggle('is-set', k.neutral !== undefined && Math.abs(v - k.neutral) > 0.001);
    }

    for (const btn of strip.children) {
      btn.classList.toggle('is-on', btn.dataset.preset === rack.state.preset);
    }
    for (const btn of spaceStrip.children) {
      btn.classList.toggle('is-on', rack.state.space.on && btn.dataset.space === rack.state.space.kind);
    }

    bypass.classList.toggle('is-on', !rack.state.on);
    bypass.querySelector('span').textContent = rack.state.on ? 'Bypass' : 'Bypassed';
    host.classList.toggle('is-bypassed', !rack.state.on);

    const sub = host.querySelector('#rack-sub');
    if (sub) {
      sub.textContent = !rack.state.on
        ? 'Bypassed — you are hearing the file'
        : rack.isDefault()
          ? 'Flat. Nothing between the file and the speakers.'
          : summarise();
    }
  }

  /** What the rack is doing, in one line of plain language. */
  function summarise() {
    const s = rack.state;
    const parts = [];
    if (s.preset !== 'flat' && s.preset !== 'custom') {
      parts.push(rack.PRESETS.find((p) => p.id === s.preset)?.label);
    } else if (s.eq.some((v) => Math.abs(v) > 0.05)) {
      parts.push('Custom curve');
    }
    if (s.preamp) parts.push(dbText(s.preamp) + ' dB in');
    if (s.pitch) parts.push((s.pitch > 0 ? '+' : '') + s.pitch + ' semitones');
    if (s.speed !== 1) parts.push(s.speed.toFixed(2) + '× speed');
    if (s.width !== 1) parts.push(s.width === 0 ? 'mono' : Math.round(s.width * 100) + '% width');
    if (s.balance) parts.push('balance ' + (s.balance < 0 ? 'left' : 'right'));
    if (s.comp.on) parts.push('compressed');
    if (s.space.on) parts.push((rack.SPACES[s.space.kind]?.label || 'reverb').toLowerCase());
    return parts.length ? parts.join(' · ') : 'Flat';
  }

  rack.preload().then(paintAll);
  paintAll();

  on(rack, 'change', () => { if (!host.isConnected) return; paintAll(); });
  on(player, 'track', () => paintAll());
  on(rack, 'bound', () => { if (host.isConnected) paintBound(); });
  paintBound();

  /* The lamp reads the same per-frame analysis every visualiser reads, so it
     costs no second look at the analyser — and the ticker stops on its own
     when nothing is playing, which is exactly when a signal lamp should go
     out. Smoothed on the way down only: a lamp that tracks a waveform sample
     for sample strobes, and a lamp that lags the music is not reporting it. */
  let sig = 0;
  const stopLamp = tick((dt) => {
    if (!host.isConnected) return;
    const live = player.state.playing && rack.state.on;
    const target = live ? Math.min(1, player.analysis().level * 1.6) : 0;
    sig += (target - sig) * Math.min(1, dt / (target > sig ? 60 : 260));
    grid.style.setProperty('--sig', sig.toFixed(3));
  });
  offs.push(stopLamp);

  enter(host.children, { each: 60, y: 12 });
  return () => { while (offs.length) offs.pop()(); };
}
