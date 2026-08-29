/* audio.js — the rack.
 *
 * Everything between the file and the speakers that is not simply volume: a
 * ten-band parametric equaliser, bass and treble on their own shelves, a
 * compressor, a reverb built out of noise, stereo width, balance, a limiter,
 * and pitch and speed as two separate controls rather than one.
 *
 * Two things worth knowing before changing anything here.
 *
 * **The chain is always connected.** Bypassing an effect sets it to unity
 * rather than unplugging it — a biquad at 0 dB is transparent, a compressor at
 * a ratio of 1 is transparent — because rewiring a live graph clicks. The one
 * exception is the pitch shifter, which is a real detour: it costs an audio
 * thread hop and 85 ms of delay line, so at zero semitones the signal goes
 * around it, and the switch is crossfaded rather than cut.
 *
 * **Pitch and speed are different knobs.** `playbackRate` moves both, which is
 * what happens when you spin a record faster. Speed here uses `playbackRate`
 * with `preservesPitch`, so the tempo moves and the key does not; pitch uses a
 * delay-line shifter in an AudioWorklet, so the key moves and the tempo does
 * not. Either can be used alone, and both at once is a legitimate thing to
 * want.
 */

import * as db from './db.js';
import { Emitter, clamp } from './util.js';

export const events = new Emitter();

const KEY = 'audio:v1';
const SAVE_DEBOUNCE = 400;

/** The ten bands, in Hz. The ends are shelves; everything between is a bell. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Rooms, as decay time in seconds and a little colour. */
export const SPACES = {
  room:      { label: 'Room',      seconds: 0.6, damp: 0.55, predelay: 0.008 },
  hall:      { label: 'Hall',      seconds: 1.9, damp: 0.35, predelay: 0.022 },
  cathedral: { label: 'Cathedral', seconds: 4.2, damp: 0.20, predelay: 0.045 },
  plate:     { label: 'Plate',     seconds: 1.2, damp: 0.70, predelay: 0.002 },
  chamber:   { label: 'Chamber',   seconds: 0.9, damp: 0.45, predelay: 0.012 },
};

export const state = {
  on: true,                  // master: false is a true bypass, for A/B
  preamp: 0,                 // dB
  eq: BANDS.map(() => 0),    // dB per band
  bass: 0,                   // dB, low shelf at 110 Hz
  treble: 0,                 // dB, high shelf at 6 kHz
  comp: { on: false, threshold: -24, ratio: 3, attack: 0.004, release: 0.25, knee: 8 },
  space: { on: false, kind: 'hall', mix: 0.22 },
  width: 1,                  // 0 = mono, 1 = as recorded, 2 = wide
  balance: 0,                // -1 left, +1 right
  pitch: 0,                  // semitones
  speed: 1,                  // playback rate
  preservePitch: true,       // speed without changing the key
  limiter: true,
  preset: 'flat',
};

/* ------------------------------------------------------------------ presets */

const eq = (...v) => {
  const out = BANDS.map(() => 0);
  v.forEach((n, i) => { out[i] = n; });
  return out;
};

export const PRESETS = [
  { id: 'flat',      label: 'Flat',        eq: eq(), bass: 0, treble: 0 },
  { id: 'bass',      label: 'Bass Boost',  eq: eq(7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0), bass: 3, treble: 0 },
  { id: 'sub',       label: 'Sub',         eq: eq(10, 7, 2, -1, -2, -1, 0, 0, 1, 2), bass: 4, treble: 1 },
  { id: 'vocal',     label: 'Vocal',       eq: eq(-3, -2, -1, 1, 3, 4, 3, 1, 0, -1), bass: -1, treble: 1 },
  { id: 'acoustic',  label: 'Acoustic',    eq: eq(3, 2, 1, 0, 1, 1, 2, 3, 3, 2), bass: 1, treble: 2 },
  { id: 'electronic',label: 'Electronic',  eq: eq(5, 4, 1, 0, -2, 1, 2, 3, 4, 4), bass: 2, treble: 2 },
  { id: 'loudness',  label: 'Loudness',    eq: eq(6, 5, 2, 0, -1, 0, 1, 3, 5, 6), bass: 2, treble: 2 },
  { id: 'night',     label: 'Late Night',  eq: eq(-4, -3, -1, 1, 2, 2, 1, 0, -1, -2), bass: -3, treble: -1,
    comp: { on: true, threshold: -32, ratio: 6, attack: 0.006, release: 0.30, knee: 10 } },
  { id: 'podcast',   label: 'Spoken',      eq: eq(-6, -5, -2, 2, 4, 4, 3, 1, -1, -3), bass: -3, treble: 0,
    comp: { on: true, threshold: -26, ratio: 4, attack: 0.004, release: 0.18, knee: 8 } },
  { id: 'classical', label: 'Classical',   eq: eq(2, 2, 1, 0, 0, 0, 1, 2, 3, 3), bass: 0, treble: 1,
    space: { on: true, kind: 'hall', mix: 0.16 } },
  { id: 'headphone', label: 'Headphones',  eq: eq(3, 2, 0, -1, 0, 1, 1, 2, 3, 2), bass: 1, treble: 1, width: 0.75 },
];

/* ------------------------------------------------------------------ graph */

let ctx = null;
let input = null, output = null;
let preamp = null, bassNode = null, trebleNode = null;
let bands = [];
let comp = null, limiter = null;
let pitchIn = null, pitchDirect = null, pitchWet = null, pitchNode = null;
let convolver = null, dry = null, wet = null, spaceSum = null;
let widthIn = null, widthGain = null, balL = null, balR = null;
let element = null;
let workletReady = null;
let loaded = false;

/** What the graph is actually doing, for the tests and for a bad afternoon. */
export const __debug = () => ({
  ctx: !!ctx,
  worklet: !!pitchNode,
  wet: pitchWet ? +pitchWet.gain.value.toFixed(3) : null,
  direct: pitchDirect ? +pitchDirect.gain.value.toFixed(3) : null,
  ratio: pitchNode ? +pitchNode.parameters.get('ratio').value.toFixed(4) : null,
  channels: pitchNode ? pitchNode.channelCount : null,
  rate: element ? element.playbackRate : null,
  // Gain reduction, in dB and negative. If the rack ever goes quiet for no
  // reason, this is the first place to look.
  compDb: comp ? +comp.reduction.toFixed(2) : null,
  limitDb: limiter ? +limiter.reduction.toFixed(2) : null,
});

/** True once the rack is between the player's gain and its analyser. */
export const isLive = () => !!ctx;

/**
 * Takes the media element, before there is any graph at all.
 *
 * Speed is the element's own property, so it works whether or not Web Audio
 * ever starts — and Web Audio only starts on the first play. Someone who sets
 * a speed and then presses play should hear it on the first note.
 */
export function bindElement(media) {
  element = media;
  if (loaded) apply();
}

/**
 * Builds the rack inside an existing context.
 *
 * @param {AudioContext} context
 * @param {HTMLMediaElement} media  for speed, which is the element's job
 * @returns {{ input: AudioNode, output: AudioNode }}
 */
export function attach(context, media) {
  if (ctx) return { input, output };
  ctx = context;
  element = media || element;

  input = ctx.createGain();
  output = ctx.createGain();
  preamp = ctx.createGain();

  bands = BANDS.map((hz, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = hz;
    // A Q of 1.1 is about 1.3 octaves — wide enough that ten bands cover the
    // spectrum without gaps, narrow enough that each one does something.
    f.Q.value = 1.1;
    f.gain.value = 0;
    return f;
  });

  bassNode = ctx.createBiquadFilter();
  bassNode.type = 'lowshelf';
  bassNode.frequency.value = 110;

  trebleNode = ctx.createBiquadFilter();
  trebleNode.type = 'highshelf';
  trebleNode.frequency.value = 6000;

  pitchIn = ctx.createGain();
  pitchDirect = ctx.createGain();
  pitchWet = ctx.createGain();
  pitchWet.gain.value = 0;

  comp = ctx.createDynamicsCompressor();
  limiter = ctx.createDynamicsCompressor();

  // Stereo work needs two channels even when the file has one, or width and
  // balance would turn a mono recording into a one-eared one.
  widthIn = ctx.createGain();
  widthIn.channelCount = 2;
  widthIn.channelCountMode = 'explicit';
  widthIn.channelInterpretation = 'speakers';

  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const mid = ctx.createGain(), side = ctx.createGain();
  const mL = ctx.createGain(), mR = ctx.createGain();
  const sL = ctx.createGain(), sR = ctx.createGain();
  const sumL = ctx.createGain(), sumR = ctx.createGain();
  const sideNeg = ctx.createGain();
  widthGain = ctx.createGain();
  balL = ctx.createGain();
  balR = ctx.createGain();

  mL.gain.value = 0.5; mR.gain.value = 0.5;          // mid  = (L + R) / 2
  sL.gain.value = 0.5; sR.gain.value = -0.5;         // side = (L - R) / 2
  sideNeg.gain.value = -1;

  convolver = ctx.createConvolver();
  dry = ctx.createGain();
  wet = ctx.createGain();
  spaceSum = ctx.createGain();
  wet.gain.value = 0;

  /* ---- wiring ---------------------------------------------------------- */

  let node = input.connect(preamp);
  for (const f of bands) node = node.connect(f);
  node = node.connect(bassNode).connect(trebleNode).connect(pitchIn);

  pitchIn.connect(pitchDirect);
  pitchDirect.connect(comp);
  pitchWet.connect(comp);

  comp.connect(widthIn);
  widthIn.connect(split);
  split.connect(mL, 0); split.connect(mR, 1);
  split.connect(sL, 0); split.connect(sR, 1);
  mL.connect(mid); mR.connect(mid);
  sL.connect(side); sR.connect(side);
  side.connect(widthGain);
  mid.connect(sumL); mid.connect(sumR);
  widthGain.connect(sumL);
  widthGain.connect(sideNeg).connect(sumR);
  sumL.connect(balL).connect(merge, 0, 0);
  sumR.connect(balR).connect(merge, 0, 1);

  merge.connect(dry).connect(spaceSum);
  merge.connect(convolver).connect(wet).connect(spaceSum);
  spaceSum.connect(limiter).connect(output);

  if (loaded) apply(); else load();
  return { input, output };
}

/* ------------------------------------------------------------------ pitch */

/** False on a browser without AudioWorklet, where pitch cannot be offered. */
export const canPitch = () =>
  typeof AudioWorkletNode === 'function' && !!(ctx ? ctx.audioWorklet : true);

let pitchFailed = false;

/**
 * Brings the shifter in and out of the path.
 *
 * The worklet is only loaded the first time someone actually asks for a pitch
 * change, so a listener who never touches it never pays for the module.
 *
 * Everything about the shifter is set *here*, after the node exists, and never
 * from `apply()`. Doing it the other way round is two bugs at once: the first
 * `apply()` reads a node that has not been constructed yet, so the ratio is
 * never written and the audio comes out at its original pitch; and the
 * crossfade to the wet path starts before there is anything on the wet path,
 * so the sound drops out for as long as the module takes to fetch.
 */
async function setPitchActive(on) {
  if (!ctx) return;

  if (on && !pitchNode && !pitchFailed) {
    if (!ctx.audioWorklet) { pitchFailed = true; }
    else {
      if (!workletReady) {
        workletReady = ctx.audioWorklet
          .addModule(new URL('./pitch-worklet.js', import.meta.url));
      }
      try {
        await workletReady;
      } catch (err) {
        pitchFailed = true;
        console.warn('[sonora] pitch shifting is unavailable here', err);
        events.emit('pitch-unavailable');
      }
      if (!pitchFailed && !pitchNode) {                // two callers can race
        pitchNode = new AudioWorkletNode(ctx, 'pitch-shift', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        pitchIn.connect(pitchNode);
        pitchNode.connect(pitchWet);
      }
    }
  }

  const t = ctx.currentTime;
  const ramp = 0.06;                                  // crossfade, not a cut

  if (!pitchNode) {
    // Nothing to fade to: make sure the dry path is carrying the signal.
    pitchDirect.gain.cancelScheduledValues(t);
    pitchDirect.gain.setTargetAtTime(1, t, ramp);
    pitchWet.gain.cancelScheduledValues(t);
    pitchWet.gain.setTargetAtTime(0, t, ramp);
    return;
  }

  // Read the state again rather than trusting the argument: this is async, and
  // the knob may have moved while the module was being fetched.
  const semis = state.on ? state.pitch : 0;
  const wet = semis !== 0;
  pitchNode.parameters.get('ratio')
    .setTargetAtTime(Math.pow(2, semis / 12), t, 0.03);
  pitchWet.gain.cancelScheduledValues(t);
  pitchDirect.gain.cancelScheduledValues(t);
  pitchWet.gain.setTargetAtTime(wet ? 1 : 0, t, ramp);
  pitchDirect.gain.setTargetAtTime(wet ? 0 : 1, t, ramp);
}

/* ------------------------------------------------------------------ apply */

const dbToGain = (dB) => Math.pow(10, dB / 20);

/** Pushes the whole of `state` at the graph. Cheap; called on every change. */
export function apply() {
  if (ctx) {
    const t = ctx.currentTime;
    const live = state.on;
    const set = (param, value) => {
      // A short ramp instead of a jump: a step on a gain is a click, and a
      // step on a filter gain is a click with a tail.
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, 0.02);
    };

    set(preamp.gain, live ? dbToGain(state.preamp) : 1);
    bands.forEach((f, i) => set(f.gain, live ? state.eq[i] : 0));
    set(bassNode.gain, live ? state.bass : 0);
    set(trebleNode.gain, live ? state.treble : 0);

    const c = state.comp;
    const compOn = live && c.on;
    set(comp.threshold, compOn ? c.threshold : 0);
    set(comp.ratio, compOn ? c.ratio : 1);
    set(comp.knee, compOn ? c.knee : 0);
    comp.attack.value = compOn ? c.attack : 0.003;
    comp.release.value = compOn ? c.release : 0.25;

    // The limiter is not a sound, it is a seatbelt: fast, brickwall, and only
    // audible when a boost would otherwise have clipped.
    const limitOn = live && state.limiter;
    set(limiter.threshold, limitOn ? -1.5 : 0);
    set(limiter.ratio, limitOn ? 20 : 1);
    set(limiter.knee, 0);
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;

    set(widthGain.gain, live ? state.width : 1);

    // Balance holds total power steady rather than turning one side down.
    const b = live ? clamp(state.balance, -1, 1) : 0;
    set(balL.gain, Math.cos((b + 1) * Math.PI / 4) * Math.SQRT2);
    set(balR.gain, Math.sin((b + 1) * Math.PI / 4) * Math.SQRT2);

    const spaceOn = live && state.space.on;
    if (spaceOn && convolver.buffer?._kind !== state.space.kind) {
      convolver.buffer = impulse(state.space.kind);
    }
    const mix = spaceOn ? clamp(state.space.mix, 0, 1) : 0;
    // Equal-power wet/dry, so turning the room up does not turn the record down.
    set(wet.gain, Math.sin(mix * Math.PI / 2));
    set(dry.gain, Math.cos(mix * Math.PI / 2));

    setPitchActive((live ? state.pitch : 0) !== 0);
  }

  if (element) {
    const rate = state.on ? clamp(state.speed, 0.25, 4) : 1;
    if (Math.abs(element.playbackRate - rate) > 0.0005) element.playbackRate = rate;
    const keep = state.on ? state.preservePitch : true;
    for (const k of ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch']) {
      if (k in element) element[k] = keep;
    }
  }

  events.emit('change', state);
  schedule();
}

/* ------------------------------------------------------------------ reverb */

const impulses = new Map();

/**
 * A room, made of noise.
 *
 * A convolution reverb needs a recording of a real space, and shipping one
 * would mean shipping a megabyte of audio. Exponentially decaying noise is the
 * textbook stand-in and sounds like a room because a room *is* a dense cloud of
 * decaying reflections; the damping term rolls the top off as it decays, which
 * is what air and soft furnishings actually do.
 */
function impulse(kind) {
  if (impulses.has(kind)) return impulses.get(kind);
  const spec = SPACES[kind] || SPACES.hall;
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * spec.seconds));
  const pre = Math.floor(rate * spec.predelay);
  const buf = ctx.createBuffer(2, len + pre, rate);

  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const decay = Math.pow(1 - t, 2 + spec.damp * 3);
      const white = Math.random() * 2 - 1;
      // One-pole low pass, opening less as the tail decays: the late tail is
      // darker than the early reflections, which is what makes it read as air.
      lp += (white - lp) * (1 - spec.damp * t);
      data[pre + i] = lp * decay;
    }
    // A handful of discrete early reflections give the room a size; without
    // them the noise cloud sounds like a effect rather than a place.
    for (let k = 0; k < 6; k++) {
      const at = pre + Math.floor(rate * (0.004 + k * 0.011 + Math.random() * 0.004));
      if (at < data.length) data[at] += (0.5 - k * 0.07) * (c ? -1 : 1);
    }
  }
  buf._kind = kind;
  impulses.set(kind, buf);
  return buf;
}

/* ------------------------------------------------------------------ curve */

/** A context that exists only to answer questions about filters. */
let probe = null, probeBands = null;

function probeFilters() {
  if (probeBands) return probeBands;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  probe = new OAC(1, 1, 44100);
  probeBands = BANDS.map((hz, i) => {
    const f = probe.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = hz;
    f.Q.value = 1.1;
    return f;
  });
  const b = probe.createBiquadFilter();
  b.type = 'lowshelf'; b.frequency.value = 110;
  const t = probe.createBiquadFilter();
  t.type = 'highshelf'; t.frequency.value = 6000;
  probeBands.push(b, t);
  return probeBands;
}

/**
 * The combined response of the whole equaliser, in dB, at the frequencies
 * given. Asked of the filters themselves rather than derived from the slider
 * positions, so the curve on screen is the curve in the signal — including the
 * skirts where neighbouring bands overlap and add.
 */
export function response(freqs) {
  const out = new Float32Array(freqs.length);
  const filters = probeFilters();
  if (!filters) return out;

  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  const values = [...state.eq, state.bass, state.treble];

  for (let i = 0; i < filters.length; i++) {
    const gainDb = values[i] || 0;
    if (!gainDb) continue;
    filters[i].gain.value = gainDb;
    filters[i].getFrequencyResponse(freqs, mag, phase);
    for (let n = 0; n < out.length; n++) out[n] += 20 * Math.log10(mag[n] || 1e-6);
  }
  for (let n = 0; n < out.length; n++) out[n] += state.preamp;
  return out;
}

/* ------------------------------------------------------------------ edits */

export function setBand(i, dB) {
  state.eq[i] = clamp(Math.round(dB * 10) / 10, -12, 12);
  state.preset = matchPreset();
  apply();
}

export function set(patch) {
  Object.assign(state, patch);
  state.preset = matchPreset();
  apply();
}

export function setComp(patch) { Object.assign(state.comp, patch); apply(); }
export function setSpace(patch) { Object.assign(state.space, patch); apply(); }

/** Which named preset the current settings are, if any. */
function matchPreset() {
  for (const p of PRESETS) {
    if (p.eq.some((v, i) => Math.abs(v - state.eq[i]) > 0.05)) continue;
    if (Math.abs((p.bass || 0) - state.bass) > 0.05) continue;
    if (Math.abs((p.treble || 0) - state.treble) > 0.05) continue;
    return p.id;
  }
  return 'custom';
}

export function usePreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  state.eq = p.eq.slice();
  state.bass = p.bass || 0;
  state.treble = p.treble || 0;
  state.width = p.width ?? 1;
  Object.assign(state.comp, { on: false, threshold: -24, ratio: 3, attack: 0.004, release: 0.25, knee: 8 }, p.comp || {});
  Object.assign(state.space, { on: false, kind: 'hall', mix: 0.22 }, p.space || {});
  state.preset = id;
  apply();
}

/** Back to nothing at all — every knob, not just the equaliser. */
export function reset() {
  state.preamp = 0;
  state.eq = BANDS.map(() => 0);
  state.bass = 0; state.treble = 0;
  state.comp = { on: false, threshold: -24, ratio: 3, attack: 0.004, release: 0.25, knee: 8 };
  state.space = { on: false, kind: 'hall', mix: 0.22 };
  state.width = 1; state.balance = 0;
  state.pitch = 0; state.speed = 1; state.preservePitch = true;
  state.limiter = true;
  state.preset = 'flat';
  apply();
}

export const isDefault = () =>
  state.preset === 'flat' && !state.preamp && !state.comp.on && !state.space.on &&
  state.width === 1 && !state.balance && !state.pitch && state.speed === 1;

/* ------------------------------------------------------------------ store */

let saveTimer = 0;

function schedule() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.setKV(KEY, JSON.parse(JSON.stringify(state))).catch(() => {});
  }, SAVE_DEBOUNCE);
}

/** User-named racks, kept beside the built-in presets. */
export async function savedRacks() {
  const list = await db.getKV('audio:racks').catch(() => null);
  return Array.isArray(list) ? list : [];
}

export async function saveRack(name) {
  const list = await savedRacks();
  const rack = { name, at: Date.now(), state: JSON.parse(JSON.stringify(state)) };
  const next = [rack, ...list.filter((r) => r.name !== name)].slice(0, 24);
  await db.setKV('audio:racks', next).catch(() => {});
  events.emit('racks', next);
  return next;
}

export async function deleteRack(name) {
  const next = (await savedRacks()).filter((r) => r.name !== name);
  await db.setKV('audio:racks', next).catch(() => {});
  events.emit('racks', next);
  return next;
}

export function loadRack(rack) {
  if (!rack?.state) return;
  const s = rack.state;
  Object.assign(state, s, {
    eq: Array.isArray(s.eq) ? s.eq.slice() : state.eq,
    comp: { ...state.comp, ...(s.comp || {}) },
    space: { ...state.space, ...(s.space || {}) },
  });
  apply();
}

async function load() {
  if (loaded) return state;
  loaded = true;
  const saved = await db.getKV(KEY).catch(() => null);
  if (saved && typeof saved === 'object') {
    Object.assign(state, saved, {
      eq: Array.isArray(saved.eq) && saved.eq.length === BANDS.length ? saved.eq.slice() : state.eq,
      comp: { ...state.comp, ...(saved.comp || {}) },
      space: { ...state.space, ...(saved.space || {}) },
    });
  }
  apply();
  events.emit('ready', state);
  return state;
}

/** Called before the graph exists, so the rack view can open cold. */
export const preload = () => (loaded ? Promise.resolve(state) : load());
