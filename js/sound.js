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
import { toast, promptDialog, dialog } from './ui.js';
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
    class: 'btn ghost sm', text: 'Reset the rack',
    onclick: () => { rack.reset(); paintAll(); toast('Rack reset'); },
  });
  /* The unit's own plate and lamp. The lamp is not decoration: it is lit while
     the rack is in circuit, amber while it is bypassed, and it flickers with
     what is actually passing through. A lamp that is always on is a sticker. */
  const lamp = el('i', { class: 'rack-lamp', 'aria-hidden': 'true' });
  const plate = el('span', { class: 'rack-plate' }, lamp,
    el('b', { text: 'SONORA' }), el('span', { text: 'RK-10' }));

  /* S1: the switch that makes the comparison fair.
   *
   * Beside the bypass rather than inside it, because they are two different
   * questions and both are worth asking: the hard bypass says what the rack is
   * doing to the level, and the matched one says what it is doing to the
   * sound. Louder wins every blind test, so an unmatched A/B on a rack with
   * make-up gain is not a comparison at all — it is a volume control with
   * opinions. */
  const matchBtn = el('button', {
    class: 'btn ghost sm rack-match', 'aria-pressed': 'false',
    title: 'Level-match the bypass, so the two sides are the same loudness',
    html: ico('sliders') + '<span>Match</span>',
    onclick: async () => {
      const on = !rack.state.levelMatch;
      rack.set({ levelMatch: on });
      paintAll();
      if (!on) return;
      /* Measured now rather than remembered: the figure belongs to this rack
         against this record, and the last one was neither. */
      matchBtn.classList.add('is-busy');
      const res = await rack.measureMatch();
      matchBtn.classList.remove('is-busy');
      paintAll();
      if (res.ok) toast(`Matched: bypass ${res.db >= 0 ? '+' : ''}${res.db.toFixed(1)} dB`);
      else if (res.reason === 'too-quiet') toast('Play something for a couple of seconds, then match');
      else toast('Nothing to measure yet');
    },
  });

  /* S2: the other rack. */
  const slotBtn = el('button', {
    class: 'btn ghost sm rack-slot', title: 'Swap with the other rack (Shift+B)',
    html: '<span>A</span>',
    onclick: () => {
      if (!rack.hasSlotB()) {
        rack.copyToOther();
        toast('Copied into B — change the rack, then swap');
      } else {
        toast('Now on ' + rack.swapSlots());
      }
      paintAll();
    },
  });

  left.appendChild(el('div', { class: 'rack-head' },
    el('span', { class: 'label', text: 'Equaliser' }), plate, slotBtn, matchBtn, bypass, resetBtn));

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

  /* H3: on a finger the band handles are 44px boxes around a 19px cap, so the
     two at the ends overhang the stage by half a target. Nothing visible is
     cut — the cap is centred and well inside — and the alternative is handles
     too small to drag, which is the thing the rule exists to prevent.
     `data-clips` is how an element says the cut is deliberate. */
  const stage = el('div', { class: 'eq-stage', 'data-clips': '' });

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

  /* S5: the live spectrum, behind the curve and on the same axes.
   *
   * A canvas rather than more SVG: this is repainted every frame and a path of
   * five hundred points reparsed sixty times a second is the one shape of work
   * this file has otherwise avoided.
   *
   * It reads `player.spectrum()`, which is dBFS per bin with nothing done to
   * it — not the visualiser's `analysis()`, whose bands are tilted, curved and
   * normalised for the eye. A dB scale printed against those would be a ruler
   * beside a lie. */
  const scope = el('canvas', { class: 'eq-scope', 'aria-hidden': 'true' });
  stage.appendChild(scope);

  const SPEC_TOP = -18, SPEC_FLOOR = -96;         // dBFS at the top and bottom
  const specY = (db) => (SPEC_TOP - db) / (SPEC_TOP - SPEC_FLOOR);
  let hold = null;                                 // peak hold, per bin
  let holdAt = 0;

  function paintScope(dt) {
    const cw = scope.clientWidth, ch = scope.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (scope.width !== Math.round(cw * dpr) || scope.height !== Math.round(ch * dpr)) {
      scope.width = Math.round(cw * dpr);
      scope.height = Math.round(ch * dpr);
    }
    const g = scope.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    const sp = player.spectrum();
    if (!sp.db || !sp.live) { hold = null; return; }
    if (!hold || hold.length !== sp.bins) hold = new Float32Array(sp.bins).fill(-Infinity);

    /* Peak hold falls at 12 dB a second — slow enough to read a transient off
       the screen, fast enough that the line follows the music rather than
       recording the loudest moment of the record. */
    const fall = 12 * (dt / 1000);

    g.beginPath();
    let started = false;
    for (let i = 1; i < sp.bins; i++) {
      const f = sp.hz[i];
      if (f < F_MIN || f > F_MAX) continue;
      const x = (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * cw;
      const db = sp.db[i];
      hold[i] = Math.max(db, hold[i] - fall);
      const y = Math.max(0, Math.min(1, specY(db))) * ch;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.lineTo(cw, ch); g.lineTo(0, ch); g.closePath();
    const grd = g.createLinearGradient(0, 0, 0, ch);
    grd.addColorStop(0, 'rgba(255,255,255,.20)');
    grd.addColorStop(1, 'rgba(255,255,255,.02)');
    g.fillStyle = grd;
    g.fill();

    // The hold, as a hairline above it.
    g.beginPath();
    started = false;
    for (let i = 1; i < sp.bins; i++) {
      const f = sp.hz[i];
      if (f < F_MIN || f > F_MAX) continue;
      const x = (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * cw;
      const y = Math.max(0, Math.min(1, specY(hold[i]))) * ch;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(255,255,255,.30)';
    g.lineWidth = 1;
    g.stroke();
    holdAt = performance.now();
  }

  /* The readout under the pointer. Two numbers — where you are and what is
     there — because a spectrum you cannot put a number to is a picture. */
  const readout = el('div', { class: 'eq-readout', hidden: true });
  stage.appendChild(readout);
  const cross = el('i', { class: 'eq-cross', hidden: true, 'aria-hidden': 'true' });
  stage.appendChild(cross);

  const onHover = (e) => {
    const r = stage.getBoundingClientRect();
    const t = (e.clientX - r.left) / r.width;
    if (t < 0 || t > 1) return;
    const f = F_MIN * Math.pow(F_MAX / F_MIN, t);
    const sp = player.spectrum();
    let db = null;
    if (sp.db && sp.live && sp.bins) {
      const step = sp.hz[1] - sp.hz[0];
      const i = Math.max(1, Math.min(sp.bins - 1, Math.round(f / step - 0.5)));
      db = sp.db[i];
    }
    // Already in dB — `response()` sums each filter's magnitude in decibels and
    // adds the preamp. Converting it again read −120 dB across a flat rack.
    const curve = rack.response(Float32Array.of(f))[0];
    readout.hidden = false;
    cross.hidden = false;
    cross.style.left = (t * 100).toFixed(2) + '%';
    readout.style.left = (t * 100).toFixed(2) + '%';
    readout.classList.toggle('is-right', t > 0.72);
    /* Below the floor of the plot there is no number worth printing: a
       22 kHz-sampled file reads −184 dBFS above its own Nyquist, which is
       true, unhelpful, and four characters wider than everything else. */
    const level = db === null || !isFinite(db) ? ''
      : db < SPEC_FLOOR ? ` · under ${SPEC_FLOOR} dBFS`
      : ` · ${db.toFixed(0)} dBFS`;
    readout.textContent = `${hz(Math.round(f))}Hz · rack ${dbText(curve)} dB${level}`;
  };
  const offHover = () => { readout.hidden = true; cross.hidden = true; };
  stage.addEventListener('pointermove', onHover);
  stage.addEventListener('pointerleave', offHover);

  const overlay = el('div', { class: 'eq-overlay' });
  /* The dBFS scale for the spectrum, down the right edge — the left edge
     already carries the rack's own dB scale, and one axis cannot mean two
     things. */
  for (const d of [-24, -48, -72]) {
    overlay.appendChild(el('span', {
      class: 'eq-mark eq-mark-spec', text: d + ' dBFS',
      style: `top:${(specY(d) * 100).toFixed(1)}%`,
    }));
  }
  for (const f of HZ_MARKS) {
    // The last gridline is all but against the right edge, so its label is set
    // back from the line rather than out past it.
    const end = f === HZ_MARKS[HZ_MARKS.length - 1];
    overlay.appendChild(el('span', {
      class: 'eq-mark eq-mark-x' + (end ? ' is-end' : ''), text: hz(f),
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

  /* G5: the two gain-reduction meters, and the frame loop that drives them. */
  const grMeters = [];

  function reductionRow() {
    const make = (name, pick) => {
      const fill = el('i', { class: 'gr-fill' });
      const bar = el('span', {
        class: 'gr', role: 'meter', 'aria-label': name + ' gain reduction',
        'aria-valuemin': '-12', 'aria-valuemax': '0', 'aria-valuenow': '0',
      }, fill, el('i', { class: 'gr-ticks', 'aria-hidden': 'true' }));
      const val = el('span', { class: 'rack-val gr-val', text: '0.0' });
      grMeters.push({ pick, fill, bar, val, at: 0 });
      return el('div', { class: 'rack-row gr-row' },
        el('span', { class: 'rack-name', text: name, title: `How much the ${name.toLowerCase()} is pulling the level down` }),
        bar, val);
    };
    return el('div', { class: 'gr-pair' }, make('Compressor', 'comp'), make('Limiter', 'limit'));
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
      'Off, speed drags the pitch with it — the sound of a record played fast'),
    /* S7: which shifter. The cost is stated where the choice is made, because
       "fine" is not free and a control that hides its price is a control that
       gets blamed for the latency later. */
    qualityRow());

  /* S3: held, not set. The check is worth having as a control as well as a
     key, because somebody on the Sound page with a mouse in their hand should
     not have to know about O — and pointer capture is what makes the release
     reliable when the pointer wanders off the button mid-press. */
  function monoRow() {
    const btn = el('button', { class: 'preset mono-check', text: 'Hold to check' });
    const down = (e) => {
      btn.setPointerCapture?.(e.pointerId);
      btn.classList.add('is-on');
      rack.holdMono(true);
    };
    const up = () => { btn.classList.remove('is-on'); rack.holdMono(false); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    /* And from the keyboard, where a button is pressed with Space or Enter and
       there is no pointer to capture. `keyup` on the button is delivered even
       if focus moves, because focus cannot move while a key is down. */
    btn.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (!e.repeat) { btn.classList.add('is-on'); rack.holdMono(true); }
    });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
    btn.addEventListener('blur', up);
    return el('div', { class: 'rack-row' },
      el('span', { class: 'rack-name', text: 'Mono check',
        title: 'Hold to hear the two channels summed. Anything that disappears will disappear on a phone speaker too. (O)' }),
      el('span', {}), btn);
  }

  function qualityRow() {
    const pick = el('div', { class: 'segmented sm', role: 'radiogroup', 'aria-label': 'Pitch shifter' });
    for (const [id, label, hint] of [
      ['fast', 'Fast', 'A delay line: no latency worth the name, clean to about seven semitones'],
      ['fine', 'Fine', 'A phase vocoder: holds a sustained note together at any shift, at about 50 ms of latency'],
    ]) {
      const b = el('button', {
        class: 'seg' + (rack.state.pitchQuality === id ? ' is-on' : ''),
        role: 'radio', 'aria-checked': String(rack.state.pitchQuality === id),
        text: label, title: hint,
      });
      b.addEventListener('click', () => {
        rack.set({ pitchQuality: id });
        for (const x of pick.children) {
          const on = x === b;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-checked', String(on));
        }
        if (id === 'fine' && rack.state.pitch) toast('Fine shifting adds about 50 ms of delay');
      });
      pick.appendChild(b);
    }
    return el('div', { class: 'rack-row' },
      el('span', { class: 'rack-name', text: 'Shifter',
        title: 'Fast is a delay line and adds no delay. Fine is a phase vocoder: better on sustained notes and large shifts, at about 50 ms of latency.' }),
      el('span', {}), pick);
  }

  module('Stereo',
    knob('Width', { min: 0, max: 200, step: 1, neutral: 100,
      get: () => Math.round(rack.state.width * 100), set: (v) => rack.set({ width: v / 100 }),
      format: (v) => (v === 0 ? 'Mono' : v + '%'),
      hint: '0 is mono, 100 is as recorded, 200 pushes the sides out' }),
    monoRow(),
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
      'A brickwall at −1.5 dB, so a boost cannot clip'),
    /* G5: what the two of them are actually doing.
     *
     * Both meters read downward from zero, because gain reduction is negative
     * and a bar that grows upward for "quieter" is a bar that lies about its
     * own direction. Twelve decibels of scale: past that the setting is wrong
     * rather than interesting, and a meter that never reaches its end is a
     * meter with no resolution where the work happens. */
    reductionRow());

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
  /* S6: a rack as a file.
   *
   * The application's whole argument is that your library is a folder on your
   * disk and nothing is locked away; a rack that exists only inside IndexedDB,
   * reachable by nothing and lost with a Clear library, is the same objection
   * turned inward. So: written out as a small JSON file, and read back by
   * choosing one or by dropping it on the page. */
  const exportBtn = el('button', {
    class: 'btn ghost sm', html: ico('file') + '<span>Save as a file</span>',
    title: 'Write this rack out, to keep or to pass on',
    onclick: () => promptDialog({
      title: 'Save this rack as a file',
      label: 'Name',
      placeholder: 'That pressing of Kind of Blue…',
      confirm: 'Save',
      onConfirm: (name) => {
        const doc = rack.exportRack(name || 'Rack');
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: (doc.name || 'rack').replace(/[^\w -]+/g, '') + '.sonora-rack.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Freed on the next turn of the loop rather than immediately: revoking
        // it in the same task cancels the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Saved');
      },
    }),
  });

  const picker = el('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async () => {
      const file = picker.files && picker.files[0];
      picker.value = '';
      if (file) offerRack(await file.text());
    },
  });
  const importBtn = el('button', {
    class: 'btn ghost sm', html: ico('folder') + '<span>Open a rack file</span>',
    title: 'Read a rack somebody wrote out. You will see what it changes first.',
    onclick: () => picker.click(),
  });

  /** Shows what a rack file would change, and applies it only if asked. */
  function offerRack(text) {
    const read = rack.readRackFile(text);
    if (!read.ok) { toast(read.reason); return; }
    const body = el('div', {},
      el('p', { text: read.changes.length
        ? `“${read.name}” changes ${read.changes.join(', ')}.`
        : `“${read.name}” is the same as what you have now.` }),
      el('p', { class: 'muted', text: 'Nothing is saved until you load it, and Undo does not cover the rack — write your own out first if you want it back.' }));
    dialog({
      title: 'Load this rack?',
      body,
      width: 460,
      actions: [
        { label: 'Cancel' },
        { label: 'Load it', primary: true, onSelect: () => {
          rack.loadRack({ state: read.state });
          paintAll();
          toast('Loaded “' + read.name + '”');
        } },
      ],
    });
  }

  /* Dropped on the page, which is how a file arrives when somebody has just
     been sent one. Scoped to the Sound page and taken back with it. */
  const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); host.classList.add('is-dropping'); } };
  const onDragLeave = () => host.classList.remove('is-dropping');
  const onDrop = async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    host.classList.remove('is-dropping');
    if (!/\.json$/i.test(file.name)) { toast('A rack is a .json file'); return; }
    offerRack(await file.text());
  };
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('dragleave', onDragLeave);
  host.addEventListener('drop', onDrop);
  offs.push(() => {
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('dragleave', onDragLeave);
    host.removeEventListener('drop', onDrop);
  });

  const mine = module('Your racks', rackStrip, saveBtn, exportBtn, importBtn, picker);
  mine.classList.add('rack-mine');

  async function paintRacks() {
    const list = await rack.savedRacks();
    rackStrip.textContent = '';
    if (!list.length) {
      rackStrip.appendChild(el('span', { class: 'rack-note', text: 'Nothing saved yet. Set the rack how you want it and press Keep.' }));
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
    matchBtn.classList.toggle('is-on', rack.state.levelMatch);
    matchBtn.setAttribute('aria-pressed', String(rack.state.levelMatch));
    {
      const off = rack.matchOffset();
      matchBtn.querySelector('span').textContent = rack.state.levelMatch && off
        ? `${off >= 0 ? '+' : ''}${off.toFixed(1)} dB` : 'Match';
    }
    slotBtn.querySelector('span').textContent = rack.hasSlotB() ? rack.whichSlot() : 'A→B';
    slotBtn.classList.toggle('is-on', rack.hasSlotB() && rack.whichSlot() === 'B');
    slotBtn.title = rack.hasSlotB()
      ? `On rack ${rack.whichSlot()} — swap with the other (Shift+B)`
      : 'Copy this rack into B, so the two can be compared (Shift+B)';
    host.classList.toggle('is-bypassed', !rack.state.on);

    const sub = host.querySelector('#rack-sub');
    if (sub) {
      sub.textContent = !rack.state.on
        ? 'Bypassed — you are hearing the file'
        : rack.isDefault()
          ? 'Flat. Nothing between the file and the speakers.'
          : summarise();
      // Every branch of this is a sentence, so it is set as one. See `.is-note`.
      sub.classList.add('is-note');
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
    paintScope(dt);
    const live = player.state.playing && rack.state.on;
    const target = live ? Math.min(1, player.analysis().level * 1.6) : 0;
    sig += (target - sig) * Math.min(1, dt / (target > sig ? 60 : 260));
    grid.style.setProperty('--sig', sig.toFixed(3));

    /* G5. Read on the same frame as everything else, so the meters cost one
       call rather than one each. Fast down, slow back up: a gain-reduction
       meter has to catch the transient that caused the reduction, and a
       symmetric smoothing either misses it or leaves the needle hanging. */
    if (grMeters.length) {
      const r = rack.reduction();
      for (const m of grMeters) {
        const on = m.pick === 'comp' ? r.compOn : r.limitOn;
        const want = on ? Math.max(-12, Math.min(0, r[m.pick] || 0)) : 0;
        m.at += (want - m.at) * Math.min(1, dt / (want < m.at ? 45 : 320));
        const pct = Math.min(1, Math.abs(m.at) / 12);
        m.fill.style.transform = `scaleX(${pct.toFixed(4)})`;
        m.bar.classList.toggle('is-idle', !on);
        m.bar.setAttribute('aria-valuenow', m.at.toFixed(1));
        const text = on ? (m.at > -0.05 ? '0.0' : m.at.toFixed(1)) : '—';
        if (m.val.textContent !== text) m.val.textContent = text;
      }
    }
  });
  offs.push(stopLamp);

  enter(host.children, { each: 60, y: 12 });
  return () => {
    stage.removeEventListener('pointermove', onHover);
    stage.removeEventListener('pointerleave', offHover);
    while (offs.length) offs.pop()();
  };
}
