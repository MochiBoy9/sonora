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
  /* S1: whether a bypass is level-matched. Off is the honest hard bypass, on
     is the fair comparison, and both are worth having because they answer
     different questions: "what is this doing to the level" and "what is this
     doing to the sound". */
  levelMatch: false,
  /* S7: which pitch shifter. 'fast' is the delay line — no latency worth the
     name and clean to about seven semitones. 'fine' is the phase vocoder,
     which holds a sustained note together at any shift and costs 50 ms of
     latency and a pair of FFTs per hop. Neither is right for every use, so it
     is a choice, and the control that offers it says what each one costs. */
  pitchQuality: 'fast',
};

/* dB the rack is louder than the dry signal, measured. Zero until something
   has been measured, which is also what it falls back to when the measurement
   cannot be trusted — see `measureMatch`. */
let matchDb = 0;
/* True only while `measureMatch` is reading the two legs. The correction is
   what is being measured, so it has to be out of circuit while the reading is
   taken or the second pass would measure the first pass's answer. */
let measuring = false;

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
let match = null;
let element = null;
let meterModule = null;          // the level-match meters' module, added once
let loaded = false;

/** What the graph is actually doing, for the tests and for a bad afternoon. */
export const __debug = () => ({
  ctx: !!ctx,
  worklet: !!pitchNode,
  shifter: pitchKind || null,
  matchDb,
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

  /* S1: the gain that makes an A/B honest.
   *
   * A true bypass is the right thing to have and exactly the thing that makes
   * a comparison misleading: louder wins every blind test ever run, so a rack
   * with 4 dB of make-up gain always sounds better and you never hear what it
   * is actually doing. This node sits at the very end and carries the measured
   * difference, applied to whichever leg is quieter, so the two sides of the
   * comparison arrive at the same loudness and the only thing left to hear is
   * the shape.
   *
   * After the limiter rather than before it, because it is not part of the
   * sound the rack makes — it is a correction to the comparison, and putting
   * it inside the chain would have the limiter respond to it. */
  match = ctx.createGain();
  spaceSum.connect(limiter).connect(match).connect(output);

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
/* Which shifter is in the graph, so a change of quality is noticed. */
let pitchKind = '';
const SHIFTERS = {
  fast: { module: './pitch-worklet.js', name: 'pitch-shift' },
  fine: { module: './vocoder-worklet.js', name: 'pitch-vocoder' },
};
const shifterModules = {};

async function setPitchActive(on) {
  if (!ctx) return;

  const want = SHIFTERS[state.pitchQuality] ? state.pitchQuality : 'fast';

  /* Changing the shifter means changing the node. Taken out while the dry path
     is carrying the signal — `apply()` calls this after writing the wet/dry
     gains, and a swap under a live wet leg is an audible cut. */
  if (pitchNode && pitchKind !== want) {
    const old = pitchNode;
    pitchNode = null;
    pitchKind = '';
    try { pitchIn.disconnect(old); old.disconnect(); } catch { /* already gone */ }
  }

  if (on && !pitchNode && !pitchFailed) {
    if (!ctx.audioWorklet) { pitchFailed = true; }
    else {
      const spec = SHIFTERS[want];
      if (!shifterModules[want]) {
        shifterModules[want] = ctx.audioWorklet
          .addModule(new URL(spec.module, import.meta.url));
      }
      try {
        await shifterModules[want];
      } catch (err) {
        shifterModules[want] = null;
        pitchFailed = true;
        console.warn('[sonora] pitch shifting is unavailable here', err);
        events.emit('pitch-unavailable');
      }
      if (!pitchFailed && !pitchNode) {                // two callers can race
        pitchNode = new AudioWorkletNode(ctx, spec.name, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        pitchKind = want;
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

    /* The hold outranks both the setting and the bypass: "what does this sound
       like in mono" is a question about the record, and a bypassed rack that
       ignored it would answer a different one. */
    set(widthGain.gain, monoHold ? 0 : (live ? state.width : 1));

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

    /* S1. The correction is applied to whichever leg needs it and to neither
       when matching is off. In: the rack is already at its own level, so this
       is unity. Out: raise the dry signal by however much louder the rack was,
       so the two sides land together. */
    set(match.gain, !measuring && state.levelMatch && !live ? dbToGain(matchDb) : 1);

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

/* S3: fold to mono for as long as it is held.
 *
 * Not a change to `state.width`. The whole point of a momentary check is that
 * the setting you were auditioning is still there when you let go, and writing
 * the width to zero would save mono to the preset, publish it to the readout
 * and lose whatever you had set. So the fold lives beside the setting and
 * `apply()` reads whichever is in force — which also means the Look, the
 * summary line and anything that persists the rack all still describe the
 * record rather than the check. */
let monoHold = false;

export function holdMono(on) {
  const next = !!on;
  if (next === monoHold) return;
  monoHold = next;
  apply();
  events.emit('mono', monoHold);
}

export const isMonoHeld = () => monoHold;

/**
 * S1: measures the difference in level between the rack and the bypass.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT THE OBVIOUS THING. The first version
 * compared the signal entering the rack with the signal leaving it, and it was
 * wrong by more than the correction it was applying. A bypass is not the dry
 * input: `on: false` neutralises the settings, but the signal still travels the
 * same chain — the width matrix, the wet/dry sum, the limiter — and those have
 * a gain of their own. Measured: the rack made the record 1.1 dB *quieter*
 * than the bypass, and a correction derived from input-versus-output moved it
 * 2.8 dB the other way.
 *
 * So this measures the thing it is actually correcting: the rack's gain from
 * input to output with the rack in, then the same ratio with it bypassed. The
 * difference between two ratios is what the switch is worth.
 *
 * A ratio rather than a level, because it is taken over whatever music happens
 * to be playing in that second. Levels from two different seconds cannot be
 * compared — the record got quieter, not the rack. Two ratios can: each is
 * measured against its own input at its own moment, so the music divides out
 * and what is left is the transfer function. The one thing that does not divide
 * out is the compressor's and limiter's programme dependence, and that is not a
 * flaw: how hard the rack squashes *this* music is part of what the switch is
 * worth.
 *
 * WORKLETS, NOT ANALYSERS. The obvious build is AnalyserNodes and a rAF loop.
 * An analyser hung off a node reports digital silence — nothing downstream of
 * it reaches the destination, so the graph has no reason to render it. The
 * meter worklet next door has never had the problem, because a worklet with no
 * outputs is a sink and is always processed. Two pairs of them, made when the
 * button is pressed and thrown away afterwards, so the steady-state graph is
 * unchanged.
 *
 * @returns {Promise<{ok: boolean, db: number, reason?: string}>}
 */
export async function measureMatch({ seconds = 1.4 } = {}) {
  if (!ctx || !input || !output) return { ok: false, db: matchDb, reason: 'no-graph' };
  if (!ctx.audioWorklet) return { ok: false, db: matchDb, reason: 'no-worklet' };

  try {
    meterModule = meterModule ||
      ctx.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url));
    await meterModule;
  } catch {
    meterModule = null;
    return { ok: false, db: matchDb, reason: 'no-worklet' };
  }

  const tap = (from) => {
    const node = new AudioWorkletNode(ctx, 'sonora-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
    const seen = { sumSq: 0, samples: 0 };
    node.port.onmessage = (e) => {
      if (!e.data) return;
      seen.sumSq = e.data.sumSq;
      seen.samples = e.data.samples;
    };
    from.connect(node);
    return { seen, stop: () => { try { from.disconnect(node); } catch { /* gone */ } node.port.onmessage = null; } };
  };

  /* One pass: how much louder the output is than the input, right now.
     The worklet ignores its first 75 blocks after construction — a settling
     window for the switch transient — so the wait is the measurement plus that
     and a post interval, or the last summary read would be of nothing. */
  const pass = async () => {
    const a = tap(input);
    const b = tap(output);
    await new Promise((r) => setTimeout(r, seconds * 1000 + 450));
    a.stop(); b.stop();
    const rate = ctx.sampleRate || 48000;
    if (!a.seen.samples || !b.seen.samples || a.seen.samples < rate / 3) return null;
    if (!a.seen.sumSq || !b.seen.sumSq) return null;
    return 10 * Math.log10((b.seen.sumSq / b.seen.samples) / (a.seen.sumSq / a.seen.samples));
  };

  const was = state.on;
  measuring = true;                 // holds `match` at unity while it is read
  try {
    state.on = true; apply();
    const onDb = await pass();
    state.on = false; apply();
    const offDb = await pass();
    if (onDb === null || offDb === null) return { ok: false, db: matchDb, reason: 'too-quiet' };
    /* Positive when the rack is the louder of the two, which is the amount the
       bypassed leg has to be lifted by to meet it. */
    const diff = onDb - offDb;
    /* Bounded. Past about 12 dB either way the rack is doing something a level
       match cannot fairly undo — a gate, a near-total cut — and matching it
       would produce a bypass at a level nobody asked for. */
    matchDb = Math.max(-12, Math.min(12, diff));
    events.emit('match', matchDb);
    return { ok: true, db: matchDb };
  } finally {
    measuring = false;
    state.on = was;
    apply();
  }
}

/**
 * Where the signal is, stage by stage, in dBFS over a short window.
 *
 * For the afternoon when the rack is silent and every gain reads unity. Uses
 * the same meter worklet the level match does, for the same reason: an
 * analyser hung off a node reports nothing, because nothing downstream of it
 * reaches the destination.
 */
export async function __levels({ seconds = 1 } = {}) {
  if (!ctx || !ctx.audioWorklet || !input) return null;
  try {
    meterModule = meterModule ||
      ctx.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url));
    await meterModule;
  } catch { return null; }

  const stages = { input, preamp, comp, limiter, match, output };
  const taps = [];
  for (const [name, node] of Object.entries(stages)) {
    if (!node) continue;
    const w = new AudioWorkletNode(ctx, 'sonora-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
    const seen = { sumSq: 0, samples: 0 };
    w.port.onmessage = (e) => { if (e.data) { seen.sumSq = e.data.sumSq; seen.samples = e.data.samples; } };
    node.connect(w);
    taps.push({ name, node, w, seen });
  }
  await new Promise((r) => setTimeout(r, seconds * 1000 + 450));
  const out = {};
  for (const t of taps) {
    try { t.node.disconnect(t.w); } catch { /* already gone */ }
    t.w.port.onmessage = null;
    out[t.name] = t.seen.samples
      ? +(10 * Math.log10(t.seen.sumSq / t.seen.samples)).toFixed(1)
      : null;
  }
  return out;
}

/** How much the bypassed leg is being corrected by, in dB. */
export const matchOffset = () => matchDb;

/* ------------------------------------------------------------------ two racks
 *
 * S2: bypass answers "is the rack doing anything?" and cannot answer "is this
 * curve better than that one?", which is the question you actually have once
 * you are past flat. Two slots and one key to swap them.
 *
 * A slot is a snapshot of everything the rack is, taken by the same shape
 * `loadRack` already reads — so a slot and a saved rack are the same object,
 * and the swap is `loadRack` in both directions. Only the settings: bindings,
 * presets and the graph itself are untouched.
 */
const SLOT_KEYS = ['preamp', 'eq', 'bass', 'treble', 'comp', 'space', 'width',
                   'balance', 'pitch', 'speed', 'preservePitch', 'limiter', 'preset'];

function snapshot() {
  const out = {};
  for (const k of SLOT_KEYS) {
    const v = state[k];
    out[k] = Array.isArray(v) ? v.slice() : (v && typeof v === 'object' ? { ...v } : v);
  }
  return out;
}

/* The other rack. Null until somebody puts something in it, because an empty
   B is not "flat" — flat is a setting somebody might have chosen for A, and
   swapping into a B nobody has filled should say so rather than quietly
   flattening the rack. */
let slotB = null;
let inB = false;

export const hasSlotB = () => !!slotB;
export const whichSlot = () => (inB ? 'B' : 'A');

/** Copies whatever is in the rack now into the other slot. */
export function copyToOther() {
  slotB = snapshot();
  events.emit('slots');
  return whichSlot() === 'A' ? 'B' : 'A';
}

/**
 * Swaps the rack with the other slot.
 *
 * Symmetric by construction: what is in the rack goes into the slot and what
 * was in the slot comes out, so pressing it twice is a no-op and there is no
 * "which one is the real one" to get wrong.
 */
export function swapSlots() {
  if (!slotB) return null;
  const here = snapshot();
  const there = slotB;
  slotB = here;
  for (const k of SLOT_KEYS) {
    if (!(k in there)) continue;
    const v = there[k];
    state[k] = Array.isArray(v) ? v.slice() : (v && typeof v === 'object' ? { ...v } : v);
  }
  inB = !inB;
  apply();
  events.emit('slots');
  return whichSlot();
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
  /* Not while a record is driving the rack. The saved rack is *yours* — the
     one you set by hand and expect to find next launch — and letting an
     album's settings write over it would mean playing one loud record once
     and finding the whole library equalised for it a week later. */
  if (bound) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.setKV(KEY, JSON.parse(JSON.stringify(state))).catch(() => {});
  }, SAVE_DEBOUNCE);
}

/* ------------------------------------------------- a rack per record
 *
 * Some records want a different chain. A thin early pressing wants the bass
 * shelf up; a loudness-war remaster wants the compressor off and the preamp
 * down; a live bootleg wants the room taken out of it. Setting that by hand
 * every time you put the record on is exactly the sort of small repeated
 * chore a local player should absorb.
 *
 * A binding is `scope:key -> rack id`, where the id names either a built-in
 * preset or a rack you saved. Album beats artist, because the more specific
 * statement wins and an album is the smaller claim.
 *
 * The rack you set by hand is the *house* rack, and it is parked rather than
 * overwritten while a record drives: leaving that album puts it back exactly.
 * Nothing about a binding is allowed to leak into the next record.
 */

const BIND_KEY = 'audio:bindings';

let bindings = {};              // 'album:<key>' | 'artist:<key>' -> rack id
let bound = null;               // { scope, key, id, label } currently driving
let house = null;               // the hand-set rack, parked while `bound`

/** What is driving the rack right now, or null for the house rack. */
export const boundRack = () => bound;

export const bindingOf = (scope, key) => bindings[scope + ':' + key] || null;

/** The id bound to a track, album first. Null when the house rack applies. */
export function bindingForTrack(t) {
  const hit = matchFor(t);
  return hit ? hit.id : null;
}

/** Which binding claims this track, and under which scope. Album beats artist. */
function matchFor(t) {
  if (!t) return null;
  const album = bindings['album:' + t.albumKey];
  if (album) return { scope: 'album', key: t.albumKey, id: album, label: t.album };
  const artist = bindings['artist:' + t.artistKey];
  if (artist) return { scope: 'artist', key: t.artistKey, id: artist, label: t.albumArtist };
  return null;
}

const saveBindings = () => db.setKV(BIND_KEY, bindings).catch(() => {});

/** Names a rack: a built-in preset id, or the name of one you saved. */
async function rackStateFor(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) {
    /* A preset is a partial statement — it says what the tone controls do and
       leaves everything else alone. Read onto a copy of the house rack so
       "Vocal" on an album does not also silently reset your width and
       balance to whatever the defaults happen to be. */
    const base = JSON.parse(JSON.stringify(house || state));
    return {
      ...base,
      eq: preset.eq.slice(),
      bass: preset.bass, treble: preset.treble,
      width: preset.width === undefined ? base.width : preset.width,
      comp: { ...base.comp, ...(preset.comp || { on: false }) },
      space: { ...base.space, ...(preset.space || { on: false }) },
      preset: preset.id,
      on: true,
    };
  }
  const saved = (await savedRacks()).find((r) => r.name === id);
  return saved ? JSON.parse(JSON.stringify(saved.state)) : null;
}

function put(next) {
  Object.assign(state, next, {
    eq: Array.isArray(next.eq) ? next.eq.slice() : state.eq,
    comp: { ...state.comp, ...(next.comp || {}) },
    space: { ...state.space, ...(next.space || {}) },
  });
  apply();
}

/**
 * Puts the rack a track asks for into the chain, or brings the house rack back.
 *
 * Returns what it did, so the caller can say so. Called only when nothing is
 * crossfading — see the note on `bindTo`.
 */
export async function followTrack(t) {
  const want = matchFor(t);

  if (!want) {
    if (!bound) return null;
    const back = house;
    bound = null;                 // cleared first: `put` calls apply, which saves
    house = null;
    if (back) put(back);
    events.emit('bound', null);
    return { released: true };
  }

  // Already in circuit. Re-applying would be a ramp on every track of the
  // album, which is a click you can hear for no change you asked for.
  if (bound && bound.id === want.id && bound.key === want.key) return null;

  const next = await rackStateFor(want.id);
  if (!next) {
    /* The rack was deleted after being bound. Drop the binding rather than
       leave a dangling one that fails quietly on every play, then resolve
       again — an album binding may be hiding an artist binding underneath it,
       and returning here would leave the previous record's rack in circuit
       until the track after this one. Terminates: each pass removes a
       binding, and there are only ever two. */
    delete bindings[want.scope + ':' + want.key];
    saveBindings();
    return followTrack(t);
  }

  if (!bound) house = JSON.parse(JSON.stringify(state));
  bound = want;
  put(next);
  events.emit('bound', bound);
  return { applied: want.id, label: want.label };
}

/**
 * Ties a rack to an album or an artist.
 *
 * Takes effect on the next track that asks for it rather than immediately,
 * and that is the whole subtlety of this feature: both decks feed one rack,
 * so changing the chain during a crossfade equalises the tail of the outgoing
 * record with the incoming one's settings. The caller waits for the handover
 * to finish — see `player.events.on('settled')`.
 */
export async function bindTo(scope, key, id) {
  if (!scope || !key) return;
  if (id) bindings[scope + ':' + key] = id; else delete bindings[scope + ':' + key];
  await saveBindings();
  events.emit('bindings', bindings);
}

export const unbindFrom = (scope, key) => bindTo(scope, key, null);

/** Writes the rack as it stands now onto whatever is currently driving it. */
export async function keepBoundRack() {
  if (!bound) return false;
  const name = `${bound.label || 'Album'} rack`;
  await saveRack(name);
  await bindTo(bound.scope, bound.key, name);
  bound = { ...bound, id: name };
  events.emit('bound', bound);
  return name;
}

/** Every binding, resolved against the library for display. */
export const allBindings = () => Object.entries(bindings)
  .map(([k, id]) => {
    const i = k.indexOf(':');
    return { scope: k.slice(0, i), key: k.slice(i + 1), id };
  });

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

/* ---------------------------------------------------------------- as a file
 *
 * S6: a rack can belong to a record, which makes it a thing worth passing on —
 * "here is the curve I use for that pressing". Inside IndexedDB it is reachable
 * by nothing and lost with a Clear library, which is precisely the objection
 * this application makes to every other player's playlists.
 *
 * A small JSON file, then. Versioned, because a rack written today should
 * still load in two years or say plainly that it cannot.
 */
export const RACK_FILE = 'sonora.rack';
const RACK_FILE_VERSION = 1;

export function exportRack(name = 'Rack') {
  return {
    kind: RACK_FILE,
    version: RACK_FILE_VERSION,
    app: 'Sonora',
    saved: new Date().toISOString(),
    name: String(name).slice(0, 60),
    state: snapshot(),
  };
}

/**
 * Reads a rack file without applying it.
 *
 * Nothing is trusted: a file names its own fields and any of them may be
 * missing, of the wrong type, or hostile. What comes back is a description of
 * what *would* change, which is what the import dialog shows before anything
 * is touched — the same discipline the library's own imports use.
 *
 * @returns {{ok: boolean, reason?: string, name?: string, state?: object, changes?: string[]}}
 */
export function readRackFile(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'That is not a Sonora rack file.' }; }
  if (!doc || doc.kind !== RACK_FILE) return { ok: false, reason: 'That is not a Sonora rack file.' };
  if (!(doc.version <= RACK_FILE_VERSION)) {
    return { ok: false, reason: 'That rack was written by a newer version of Sonora.' };
  }
  const src = doc.state;
  if (!src || typeof src !== 'object') return { ok: false, reason: 'That rack file has nothing in it.' };

  const num = (v, lo, hi, fallback) =>
    (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
  const clean = {
    preamp: num(src.preamp, -12, 12, 0),
    eq: Array.isArray(src.eq)
      ? BANDS.map((_, i) => num(src.eq[i], -12, 12, 0))
      : BANDS.map(() => 0),
    bass: num(src.bass, -12, 12, 0),
    treble: num(src.treble, -12, 12, 0),
    width: num(src.width, 0, 2, 1),
    balance: num(src.balance, -1, 1, 0),
    pitch: num(src.pitch, -12, 12, 0),
    speed: num(src.speed, 0.25, 4, 1),
    preservePitch: src.preservePitch !== false,
    limiter: src.limiter !== false,
    preset: typeof src.preset === 'string' ? src.preset.slice(0, 40) : 'custom',
    comp: {
      on: !!src.comp?.on,
      threshold: num(src.comp?.threshold, -60, 0, -24),
      ratio: num(src.comp?.ratio, 1, 20, 3),
      attack: num(src.comp?.attack, 0, 1, 0.004),
      release: num(src.comp?.release, 0, 2, 0.25),
      knee: num(src.comp?.knee, 0, 40, 8),
    },
    space: {
      on: !!src.space?.on,
      kind: SPACES[src.space?.kind] ? src.space.kind : 'hall',
      mix: num(src.space?.mix, 0, 1, 0.22),
    },
  };

  /* What is about to change, in the words the dialog will use. A preview that
     lists every field is a preview nobody reads. */
  const changes = [];
  if (clean.eq.some((v, i) => Math.abs(v - state.eq[i]) > 0.05)) changes.push('the ten bands');
  if (Math.abs(clean.preamp - state.preamp) > 0.05) changes.push('preamp');
  if (Math.abs(clean.bass - state.bass) > 0.05 || Math.abs(clean.treble - state.treble) > 0.05) changes.push('bass and treble');
  if (Math.abs(clean.width - state.width) > 0.005) changes.push('width');
  if (Math.abs(clean.balance - state.balance) > 0.005) changes.push('balance');
  if (clean.pitch !== state.pitch || Math.abs(clean.speed - state.speed) > 0.005) changes.push('pitch and speed');
  if (clean.comp.on !== state.comp.on) changes.push(clean.comp.on ? 'the compressor, on' : 'the compressor, off');
  if (clean.space.on !== state.space.on) changes.push(clean.space.on ? 'the room, on' : 'the room, off');

  return { ok: true, name: String(doc.name || 'Rack').slice(0, 60), state: clean, changes };
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
  const marks = await db.getKV(BIND_KEY).catch(() => null);
  if (marks && typeof marks === 'object' && !Array.isArray(marks)) bindings = marks;
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
