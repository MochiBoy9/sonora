/* player.js — playback, queue, and the Web Audio graph.
 *
 * Two <audio> elements do the decoding, wired in parallel into one volume
 * control. One of them is the one you are hearing; the other is already
 * holding the next track, decoded and paused at zero. That is what makes the
 * handover between tracks cost milliseconds instead of however long the next
 * file takes to open, and it is the whole of both gapless and crossfade — see
 * the deck section below.
 *
 * Volume runs through a GainNode on a perceptual curve rather than the
 * element's linear property, and an AnalyserNode feeds the visualiser — banded
 * onto a logarithmic scale once per frame, because that is how hearing is
 * arranged and how a spectrum has to be drawn for the bars to line up with
 * what you can hear.
 */

import * as lib from './library.js';
import * as db from './db.js';
import * as rack from './audio.js';
import * as peakmap from './peaks.js';
import { Emitter, clamp, canDecode } from './util.js';
import { tick } from './motion.js';

export const events = new Emitter();

export const state = {
  current: null,          // track record
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',          // 'off' | 'all' | 'one'
  queue: [],              // track ids in play order
  index: -1,
  origin: null,           // { type, key, label } — where the queue came from
  /* Seconds of overlap between tracks. Zero is gapless: the next deck starts
     the instant the last one ends, which is what a live album or a beat-mixed
     record needs. Above zero they overlap on an equal-power curve. */
  crossfade: 0,
  /* Whether to run the handover at all. Off means the old behaviour: wait for
     `ended`, then load the next file. Kept because a listener who wants the
     silence between tracks is entitled to it, and because an album with real
     silence at the end of a track sounds wrong crossfaded. */
  seamless: true,
  /* Loudness levelling: 'off', 'track' or 'album'. Album keeps the balance a
     record was mastered with and only moves the record; track evens out every
     song, which is right for a shuffle and wrong for a concept album. */
  levelling: 'track',
  /* 'even' is the plain shuffle; 'weighted' leans on what you actually play. */
  shuffleMode: 'even',
  /* How the two decks trade places. 'equal' holds constant *power* across the
     overlap, which is right for two unrelated recordings; 'linear' holds
     constant *amplitude*, which is right when the two are correlated — the
     same take, a segue, a live record where the applause carries across. The
     difference is audible on every single handover: linear dips about three
     decibels in the middle of uncorrelated material, and equal-power swells by
     the same amount on correlated material. Neither is the right answer for
     both, which is why it is a control and not a constant. */
  fadeCurve: 'equal',
  /* S4: phase correlation of what is leaving the file, −1 to +1, or null when
     there is nothing to measure — silence, or a mono source, where the
     question does not arise. Written by the meter worklet's summaries. */
  correlation: null,
  /* Which output the audio leaves by, as a device id. Empty means the system
     default, which is what everything did before this existed — and on a desk
     with an interface, a DAC and a pair of speakers, that meant changing the
     operating system's default to move the music. */
  sink: '',
  /* A timestamp, the string 'track', or null. */
  sleepUntil: null,
  /* Start at the first note rather than at the first sample. Most rips carry
     between half a second and three seconds of nothing, and on shuffle that is
     a stutter between every track — the gap the two decks exist to remove, put
     back by the files. Off for anyone who wants the air before a recording. */
  trimSilence: false,
  /* Line the overlap up with the beat when both tracks have a confident tempo
     and the two are close enough for it to mean anything. */
  beatMatch: true,
};

/* Below this there is nothing worth skipping and the seek would only risk
   clipping an attack. */
const MIN_TRIM = 0.35;

/** The longest overlap on offer. Past this it stops being a crossfade. */
export const MAX_CROSSFADE = 12;

/* ------------------------------------------------------------------ decks
 *
 * Two decoders, not one, and everything about gapless and crossfade follows
 * from that. A single <audio> element cannot hand over to itself: setting
 * `src` tears down the decode, and whatever it was doing stops for as long as
 * the next file takes to open. That gap is why a live album has holes in it.
 *
 * So there are two, wired in parallel into the same volume control, and one of
 * them is the one you are hearing. The other spends its time already holding
 * the next track, decoded and paused at zero — which is the whole trick: at
 * the handover there is nothing left to load, only a `play()` and a gain.
 *
 * Gapless and crossfade are the same mechanism with one number changed. At
 * zero seconds the outgoing deck is cut and the incoming one started at the
 * boundary; above zero they overlap and trade places on an equal-power curve.
 * There is no separate code path, which is why turning crossfade down to zero
 * gives you gapless rather than something subtly different.
 */

function makeDeck(name) {
  const el = new Audio();
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  return { name, el, url: null, trackId: null, src: null, gain: null, level: null };
}

/* ------------------------------------------------------------------ levelling
 *
 * ReplayGain, and a fallback for the vast majority of files that have none.
 *
 * The tag is preferred wherever it exists, because somebody computed it
 * properly with a K-weighted, gated measurement and this app has not. Where
 * there is no tag, the RMS figure that `peaks.js` produced on the first listen
 * stands in — it is cruder, and it is written down as such, but it is enough
 * to stop a 1974 master and a 2011 remaster of the same song differing by
 * twelve decibels.
 *
 * -14 dBFS is the reference. It is what the streaming services settled on and
 * it leaves headroom above a typical modern master rather than turning
 * everything down to meet the quietest thing in the library.
 */
const LEVEL_TARGET = -14;
/* Nothing is moved by more than this. A correction bigger than 12 dB is
   describing a broken measurement or a field recording, and either way an
   automatic system should decline rather than commit. */
const LEVEL_LIMIT = 12;

/** The correction for one track in dB, or 0 if levelling is off or unknown. */
function levelDbFor(track) {
  if (!track || state.levelling === 'off') return 0;
  let db = null;
  // Album mode prefers the album figure and falls back to the track's own, so
  // a record with only per-track tags still gets levelled rather than nothing.
  if (state.levelling === 'album' && typeof track.gainAlbum === 'number') db = track.gainAlbum;
  if (db == null && typeof track.gain === 'number') db = track.gain;
  if (db == null) {
    // No tag: fall back to what was measured off the file, if anything has been.
    const rec = peakmap.peek(track);
    if (rec && typeof rec.rms === 'number' && isFinite(rec.rms)) db = LEVEL_TARGET - rec.rms;
  }
  if (db == null || !isFinite(db)) return 0;
  return clamp(db, -LEVEL_LIMIT, LEVEL_LIMIT);
}

/** Writes the correction onto a deck, ramped so it is never a click. */
function applyLevel(d, track) {
  if (!d || !d.level || !ctx) return;
  const db = levelDbFor(track);
  const value = Math.pow(10, db / 20);
  d.level.gain.cancelScheduledValues(ctx.currentTime);
  d.level.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
}

const deckA = makeDeck('a');
const deckB = makeDeck('b');

/** The deck being heard, and the one holding what comes next. */
let deck = deckA;
let idleDeck = deckB;

/* Every existing reference in this file reads `audio`, and it keeps meaning
   "the element that is playing" — it is reassigned when the decks swap. */
let audio = deck.el;

let loadToken = 0;
/* Set while a handover is in progress, so the ticker does not start a second
   one and `ended` does not fire a redundant `next()`. */
let handover = null;

/**
 * What the two decks are doing, for the tests and for a bad afternoon.
 *
 * The same idea as `rack.__debug()`: a handover is three things happening at
 * once on two elements and a pair of gains, and none of it is visible from the
 * outside once it has gone right or wrong.
 */
export const __decks = () => [deckA, deckB].map((d) => ({
  name: d.name,
  active: d === deck,
  trackId: d.trackId,
  ready: d.el.readyState,
  paused: d.el.paused,
  time: +(d.el.currentTime || 0).toFixed(3),
  duration: isFinite(d.el.duration) ? +d.el.duration.toFixed(3) : null,
  gain: d.gain ? +d.gain.gain.value.toFixed(3) : null,
  level: d.level ? +d.level.gain.value.toFixed(3) : null,
  err: d.el.error ? d.el.error.code : null,
}));

/** Whether a handover is in flight, and to what. */
export const __handover = () => (handover ? { id: handover.id, from: handover.from.name, to: handover.to.name } : null);

/* ------------------------------------------------------------------ graph */

let ctx = null, gain = null, analyser = null;
let freqData = null, timeData = null;

/** How many bands the analysis is folded into, and the range they cover. */
const BANDS = 64;
const F_LOW = 32, F_HIGH = 16000;

const bands = new Float32Array(BANDS);      // smoothed magnitudes, 0..1
const peaks = new Float32Array(BANDS);      // slow-falling caps
const raw = new Float32Array(BANDS);
let edges = null;                           // bin index per band boundary

const level = { bass: 0, mid: 0, treble: 0, level: 0, pulse: 0, beat: false };
const bassLog = new Float32Array(48);
let bassAt = 0, lastBeat = 0, frameAt = 0, silentFor = 0;

/* ------------------------------------------------------------------ meter */

/**
 * Crest factor, measured off the file while you listen to it.
 *
 * Peak against RMS over a whole listen is the crest factor, which is the
 * number people mean when they say a master is squashed — a well-cut record
 * sits around 12–16 dB, a loudness-war victim under 8. It costs one pass over
 * 2048 floats a frame, on a task that only exists while something is playing.
 *
 * `peaks.js` now decodes the same track in the background and could produce
 * this figure exactly rather than from what happened to be played. This is
 * kept anyway, and the reason is not inertia: the analysis there is of the
 * file, and this is a measurement of the signal *leaving the file into this
 * rack* — tapped before the equaliser but after the decoder, on the samples
 * that actually played. When the two disagree, the disagreement is
 * interesting. The scrubber's waveform and this meter answer different
 * questions and are allowed to be two numbers.
 *
 * The cost of doing it this way is honest and worth stating: a track you have
 * never played has no figure, and one you skipped through has no figure worth
 * having — which is why nothing is written below MIN_LISTEN seconds.
 */
let meter = null, meterData = null;
const MIN_LISTEN = 25;
/* A forward jump bigger than this is a seek rather than time passing. Four
   seconds is chosen against the app's own controls — the arrow keys move five
   and thirty — while still counting the multi-second gaps a tab under load or
   in the background produces between frames, which are elapsed time and must
   not be thrown away. Miscounting a five-second seek as four seconds of
   listening costs nothing: the seconds only decide *whether* to write a
   figure, never what the figure is. */
const SEEK_GAP = 4;
/* And enough of the waveform actually looked at to mean something. Frames stop
   in a background tab while the audio clock does not, so a track can elapse
   without being sampled; this is the half of the test the clock cannot give. */
const MIN_SAMPLES = 100000;

const dr = { track: null, peak: 0, sumSq: 0, samples: 0, seconds: 0, at: -1 };

function resetMeter(track) {
  dr.track = track || null;
  dr.peak = 0; dr.sumSq = 0; dr.samples = 0; dr.seconds = 0; dr.at = -1;
  state.correlation = null;
  // The worklet keeps its own running totals and would otherwise carry the
  // previous track's peak into the next one's figure.
  if (meterNode) meterNode.port.postMessage({ type: 'reset' });
}

function meterFrame() {
  if (!meter || !state.playing) return;
  /* When the worklet is running it owns the peak and the sum — it has seen
     every sample and this has seen one window per frame, so adding this on top
     would be mixing an exact measurement with a partial one and calling the
     result exact. The elapsed-seconds tally below still runs either way. */
  if (!meterExact) {
    meter.getFloatTimeDomainData(meterData);
    let peak = dr.peak, sum = 0;
    for (let i = 0; i < meterData.length; i++) {
      const v = meterData[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    dr.peak = peak;
    dr.sumSq += sum;
    dr.samples += meterData.length;
  }

  /* How much of the track went past, taken from the audio clock rather than
     from frame deltas.

     They are not the same number. Frames stop in a background tab and stutter
     under load, so counting them would under-report a listen that really
     happened and throw away a perfectly good measurement. The decoder's own
     clock is the one thing here that keeps running regardless.

     A gap larger than a second is a seek rather than elapsed time, and a
     backward one is a seek for certain; both are skipped rather than counted.
     The sampling goes sparse when frames do, which costs precision in the RMS
     and nothing in its correctness — a thinner random sample of a waveform is
     still an unbiased sample of it. */
  // The worklet reports its own elapsed time from the samples it measured;
  // this is the fallback's version of the same tally.
  if (meterExact) return;
  const now = audio.currentTime;
  if (dr.at >= 0 && now > dr.at && now - dr.at < SEEK_GAP) dr.seconds += now - dr.at;
  dr.at = now;
}

/**
 * Writes the figure to the track, if the listen was long enough to mean one.
 *
 * "Long enough" is the lesser of half a minute and most of the track, not a
 * flat threshold: a fixed 25 seconds would mean no interlude, skit or
 * two-minute punk single ever gets measured, which is exactly backwards —
 * a short track played to the end is a *better* sample than half a long one.
 */
function commitMeter() {
  const t = dr.track;
  const enough = Math.min(MIN_LISTEN, (t && t.duration > 0 ? t.duration : MIN_LISTEN) * 0.8);
  if (!t || dr.seconds < enough || dr.samples < MIN_SAMPLES || dr.peak < 0.0008) {
    return resetMeter(null);
  }
  const rms = Math.sqrt(dr.sumSq / dr.samples);
  const value = rms > 0 ? 20 * Math.log10(dr.peak / rms) : 0;
  // A figure outside this range is a measurement fault rather than a master:
  // silence, a decode that never started, or a file that is one long sine.
  if (isFinite(value) && value > 1 && value < 40) {
    t.dr = Math.round(value * 10) / 10;
    t.drAt = Date.now();
    db.putTracks([t]).catch(() => {});
  }
  resetMeter(null);
}

/* ---- the worklet, where there is one -------------------------------------
 *
 * `process` runs on the audio thread once per 128-frame block, so it sees
 * every sample: the peak is a true peak and the RMS is over the whole listen
 * rather than over whatever the frame loop managed to catch. The frame-based
 * meter above stays as the fallback and is not dead code — an engine without
 * AudioWorklet, or one where the module fails to load, still gets a figure.
 *
 * The two agree on what they are computing, so nothing downstream has to know
 * which produced a given number. What differs is only how complete the sample
 * behind it is, and `meterExact` records which was used.
 */
let meterNode = null;
let meterExact = false;
let meterModule = null;
let meterFault = null;

async function ensureMeterWorklet() {
  if (!ctx || !ctx.audioWorklet || meterNode) return;
  try {
    if (!meterModule) {
      meterModule = ctx.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url));
    }
    await meterModule;
    if (meterNode || !ctx) return;
    const node = new AudioWorkletNode(ctx, 'sonora-meter', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    node.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      dr.peak = d.peak;
      dr.sumSq = d.sumSq;
      dr.samples = d.samples;
      /* How long the listen was, taken from the samples that were actually
         measured rather than from elapsed frames.

         This used to be counted off the audio clock in the frame loop, and
         that made writing a figure at all depend on frames being drawn: in a
         background tab, or in any host that throttles rAF, the audio played
         perfectly and the tally never reached the threshold, so nothing was
         ever written down. Observed, not theorised.

         The worklet's own count has none of that exposure. It is also a better
         definition of the thing: gated samples over the sample rate is the
         duration of the audio that was measured, so a seek adds nothing and
         silence between tracks adds nothing, which is exactly what "how much
         of this did you actually listen to" should mean. */
      const chans = Math.max(1, node.channelCount || 2);
      dr.seconds = d.samples / chans / (ctx ? ctx.sampleRate : 48000);
      /* S4. The worklet has already normalised it; this only smooths the
         needle. A raw eighth-of-a-second figure jitters by a tenth of the
         scale on any real music, which reads as a broken instrument rather
         than as a live one — the same reason the VU has ballistics. Rising
         faster than it falls, so a moment of cancellation is seen. */
      if (d.corr === null || d.corr === undefined) state.correlation = null;
      else if (state.correlation === null) state.correlation = d.corr;
      else {
        const k = d.corr < state.correlation ? 0.55 : 0.28;
        state.correlation = state.correlation + (d.corr - state.correlation) * k;
      }
    };
    /* Tapped on the decoders themselves, ahead of every gain this app owns.
     *
     * The analyser version tapped the volume node, and that was wrong in a way
     * only a real measurement exposes: turning the volume down mid-track
     * changes the figure. The peak is set by the loud part before the change
     * and the RMS is dragged down by the quiet part after it, so the crest
     * factor climbs — measured at 11.9 dB on a sine whose true value is 3.01,
     * purely because a slider moved.
     *
     * Here the tap is before volume, before the crossfade and before
     * ReplayGain, which is what "what is leaving the file" has always claimed
     * to mean. Both decks feed it: the idle one is paused, so it contributes
     * silence, which the worklet's gate drops.
     *
     * No output — it is a leaf that costs an analysis and no audio.
     */
    deckA.src.connect(node);
    deckB.src.connect(node);
    meterNode = node;
    meterExact = true;
  } catch (err) {
    // Not fatal in any way: the frame-based meter is still running. Kept
    // rather than swallowed, because "the exact meter quietly did not start"
    // is otherwise indistinguishable from "this engine has no worklets".
    meterExact = false;
    meterFault = String(err && err.message || err);
  }
}

let stopMeter = null;
function syncMeter() {
  /* Both are only ever wanted while something is playing. The frame loop is
     kept running even when the worklet exists — not to measure, but because
     it is what advances `dr.seconds` off the audio clock, and that is the test
     for whether the listen was long enough to write down at all. */
  const wanted = !!(meter && state.playing);
  if (wanted && !stopMeter) stopMeter = tick(meterFrame);
  else if (!wanted && stopMeter) { stopMeter(); stopMeter = null; }
  if (wanted) ensureMeterWorklet();
}

/** Which meter produced the last figure, for the tests and the readout. */
export const __meterExact = () => ({ exact: meterExact, node: !!meterNode, fault: meterFault, ctx: !!ctx, worklet: !!(ctx && ctx.audioWorklet) });

/** The tally as it stands, for the tests. */
export const __meterState = () => ({
  peak: +dr.peak.toFixed(5),
  rms: dr.samples ? +Math.sqrt(dr.sumSq / dr.samples).toFixed(5) : 0,
  crestDb: dr.samples && dr.peak > 0
    ? +(20 * Math.log10(dr.peak / Math.sqrt(dr.sumSq / dr.samples))).toFixed(3) : null,
  samples: dr.samples,
  seconds: +dr.seconds.toFixed(2),
  track: dr.track ? dr.track.title : null,
});

function ensureGraph() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    /* One source per deck, each behind its own gain, both summed into the
       shared volume control. The crossfade happens on those two deck gains and
       nowhere else, so it cannot be heard by the equaliser, the meter or the
       visualiser as anything other than what it is: two records playing at
       once for a moment. */
    for (const d of [deckA, deckB]) {
      d.src = ctx.createMediaElementSource(d.el);
      /* Two gains per deck, and they are not the same job. `level` carries
         this track's own loudness correction and holds still; `gain` is the
         crossfade and moves between 0 and 1. Folding them into one node would
         mean the fade had to know each track's ReplayGain to compute its
         endpoints, and a fade between two differently-corrected tracks would
         stop being equal-power. */
      d.level = ctx.createGain();
      d.gain = ctx.createGain();
      d.gain.gain.value = d === deck ? 1 : 0;
      d.src.connect(d.level).connect(d.gain);
    }
    gain = ctx.createGain();
    deckA.gain.connect(gain);
    deckB.gain.connect(gain);
    analyser = ctx.createAnalyser();
    // 2048 buys ~23 Hz of resolution at 48 kHz: enough to separate the bass
    // bands, cheap enough to read every frame.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.62;
    analyser.minDecibels = -84;
    analyser.maxDecibels = -18;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.frequencyBinCount);

    // The rack sits between the volume control and the analyser, so the
    // spectrum on screen is the sound leaving the speakers rather than the
    // sound leaving the file: turn the bass up and the bars agree with you.
    const fx = rack.attach(ctx, audio);
    gain.connect(fx.input);
    fx.output.connect(analyser).connect(ctx.destination);

    /* The meter is tapped *before* the rack, and that is the whole point of it
       being a second node rather than a second reading of the first. The
       spectrum on screen should show what is leaving the speakers; a
       measurement of the master has to show what is leaving the file, or every
       figure it produces describes the equaliser instead. It is a leaf: nothing
       is connected downstream of it, so it costs an analysis and no audio. */
    meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    meterData = new Float32Array(meter.fftSize);
    gain.connect(meter);

    applyVolume();
    return true;
  } catch (err) {
    console.warn('[sonora] Web Audio unavailable', err);
    ctx = null;
    return false;
  }
}

/** Bin boundaries for logarithmically spaced bands, built once per context. */
function buildEdges() {
  const count = analyser.frequencyBinCount;
  const perBin = (ctx.sampleRate / 2) / count;
  edges = new Uint16Array(BANDS + 1);
  for (let i = 0; i <= BANDS; i++) {
    const hz = F_LOW * Math.pow(F_HIGH / F_LOW, i / BANDS);
    edges[i] = Math.min(count, Math.max(0, Math.round(hz / perBin)));
  }
  // Every band wants at least one bin of its own, or the bass end goes flat —
  // but not one past the end of the data: at a low sample rate the top of the
  // range falls off the end of the spectrum, and those bands are simply empty.
  for (let i = 1; i <= BANDS; i++) {
    if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
    if (edges[i] > count) edges[i] = count;
  }
}

/**
 * Loudness is perceived roughly logarithmically, so square the slider.
 *
 * Both decks, always, and that is not tidiness. Before the graph exists there
 * is no gain node and volume has to be the element's own property — and this
 * used to write it to `audio`, meaning whichever deck happened to be active.
 * The other kept `volume = 1`, and once the graph came up this function
 * stopped touching element volume at all, so the difference was frozen in for
 * the session.
 *
 * The result was a level jump at every gapless handover: the two decks were
 * playing the same music at different volumes, which is precisely the seam the
 * two-deck design exists to remove. Found by measuring one file twice through
 * the new meter and getting two different peaks — 0.640 on one deck and 0.807
 * on the other.
 *
 * Once the gain node owns volume the elements go back to unity, so there is
 * exactly one thing in the path deciding how loud this is.
 */
function applyVolume() {
  const v = state.muted ? 0 : state.volume * state.volume;
  if (gain) {
    gain.gain.value = v;
    for (const d of [deckA, deckB]) if (d.el.volume !== 1) d.el.volume = 1;
  } else {
    const ev = state.muted ? 0 : state.volume;
    for (const d of [deckA, deckB]) d.el.volume = ev;
  }
}

/**
 * One reading of the spectrum per frame, shared by every visualiser on screen.
 *
 * Bands are logarithmic, tilted to undo the natural roll-off of recorded music
 * so the top end is visible at all, smoothed asymmetrically (fast attack, slow
 * release — the shape of a real VU meter) and capped by peaks that fall under
 * their own weight. Nothing here allocates.
 */
/* S5: the spectrum as a measurement rather than as a picture.
 *
 * `analysis()` next door is a *drawing*: its bands are tilted to undo the
 * natural roll-off of recorded music, raised to a power to make the quiet parts
 * visible, normalised to 0..1 and smoothed with a meter's ballistics. Every one
 * of those is right for a visualiser and wrong for an instrument — a dB scale
 * printed against those numbers would be a lie with a ruler next to it.
 *
 * So this is a second, plain read: `getFloatFrequencyData` hands back dBFS per
 * bin with nothing done to it. The analyser's own smoothing (0.62) stays,
 * because that is a time constant rather than a shaping, and a spectrum with
 * none of it is unreadable.
 */
let specData = null;
let specAt = 0;
const spec = { db: null, hz: null, bins: 0, live: false, floor: -100 };

export function spectrum() {
  const now = performance.now();
  if (now - specAt < 12) return spec;                 // at most once a frame
  specAt = now;
  if (!analyser) { spec.live = false; return spec; }
  if (!specData || specData.length !== analyser.frequencyBinCount) {
    specData = new Float32Array(analyser.frequencyBinCount);
    spec.db = specData;
    spec.bins = specData.length;
    spec.hz = new Float32Array(specData.length);
    const step = (ctx ? ctx.sampleRate : 48000) / 2 / specData.length;
    for (let i = 0; i < specData.length; i++) spec.hz[i] = (i + 0.5) * step;
  }
  spec.live = !!state.playing;
  if (spec.live) analyser.getFloatFrequencyData(specData);
  else specData.fill(-Infinity);
  return spec;
}

export function analysis() {
  const now = performance.now();
  const dt = frameAt ? Math.min(64, now - frameAt) : 16.7;
  if (now - frameAt < 6) return view;                 // twice in one frame
  frameAt = now;

  const live = !!(analyser && state.playing);
  if (live) {
    if (!edges) buildEdges();
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);
    for (let i = 0; i < BANDS; i++) {
      let sum = 0, n = 0, top = 0;
      for (let j = edges[i]; j < edges[i + 1]; j++) { const v = freqData[j]; sum += v; if (v > top) top = v; n++; }
      // Mixing mean and max keeps wide high bands alive without letting one
      // noisy bin dominate a narrow low one.
      const v = n ? ((sum / n) * 0.55 + top * 0.45) / 255 : 0;
      const tilt = 1 + (i / BANDS) * 0.55;
      raw[i] = Math.min(1, Math.pow(v, 1.32) * tilt * 1.22);
    }
  } else {
    raw.fill(0);
  }

  const attack = 1 - Math.pow(0.0005, dt / 1000);     // ~fast rise
  const release = 1 - Math.pow(0.22, dt / 1000);      // ~slow fall
  let sum = 0, bass = 0, mid = 0, treble = 0;
  for (let i = 0; i < BANDS; i++) {
    const target = raw[i];
    bands[i] += (target - bands[i]) * (target > bands[i] ? attack : release);
    if (bands[i] > peaks[i]) peaks[i] = bands[i];
    else peaks[i] = Math.max(bands[i], peaks[i] - dt * 0.00045);
    sum += bands[i];
    if (i < BANDS * 0.18) bass += bands[i];
    else if (i < BANDS * 0.55) mid += bands[i];
    else treble += bands[i];
  }
  level.bass = bass / (BANDS * 0.18);
  level.mid = mid / (BANDS * 0.37);
  level.treble = treble / (BANDS * 0.45);
  level.level = sum / BANDS;

  // Beat: bass well above its own recent average, with a refractory period so
  // one kick doesn't register three times.
  bassLog[bassAt = (bassAt + 1) % bassLog.length] = level.bass;
  let avg = 0;
  for (let i = 0; i < bassLog.length; i++) avg += bassLog[i];
  avg /= bassLog.length;
  level.beat = false;
  if (live && level.bass > 0.06 && level.bass > avg * 1.32 && now - lastBeat > 210) {
    lastBeat = now;
    level.beat = true;
    level.pulse = 1;
  } else {
    level.pulse = Math.max(0, level.pulse - dt / 420);
  }

  silentFor = level.level > 0.002 ? 0 : silentFor + dt;
  view.wave = live ? timeData : null;
  view.live = live;
  view.idle = !live && silentFor > 900;                // renderers may rest
  return view;
}

const view = {
  bands, peaks, wave: null, get bass() { return level.bass; }, get mid() { return level.mid; },
  get treble() { return level.treble; }, get level() { return level.level; },
  get pulse() { return level.pulse; }, get beat() { return level.beat; },
  live: false, idle: true,
};

/* ------------------------------------------------------------------ loading */

function revoke(url) { if (url) URL.revokeObjectURL(url); }

/** Puts a track's file on a deck and waits until it can actually play. */
async function cueDeck(d, track) {
  const file = await lib.fileFor(track.id);
  if (!file) return false;
  const url = URL.createObjectURL(file);
  releaseDeck(d);
  d.url = url;
  d.trackId = track.id;
  d.el.src = url;
  d.el.load();
  // Ready enough to start without stalling. A deck that is merely `src`-set
  // still has to open the file, and starting one at the handover is the whole
  // reason there are two.
  if (d.el.readyState < 3) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        d.el.removeEventListener('canplay', finish);
        d.el.removeEventListener('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, 4000);
      d.el.addEventListener('canplay', finish);
      d.el.addEventListener('error', finish);
    });
  }
  return d.trackId === track.id;
}

/** Frees whatever a deck was holding. */
function releaseDeck(d) {
  revoke(d.url);
  d.url = null;
  d.trackId = null;
}

/** Immediately, with no fade: used for manual track changes. */
function cutTo(d) {
  const t = ctx ? ctx.currentTime : 0;
  for (const x of [deckA, deckB]) {
    if (!x.gain) continue;
    x.gain.gain.cancelScheduledValues(t);
    x.gain.gain.setValueAtTime(x === d ? 1 : 0, t);
  }
  if (d !== deck) {
    const old = deck;
    deck = d;
    idleDeck = old;
    audio = deck.el;
    old.el.pause();
    // The rack drives speed and pitch preservation through the element, and it
    // is a different element now.
    rack.bindElement(audio);
    rack.apply();
  }
}

async function load(track, autoplay, { count = true } = {}) {
  // A container this browser has no decoder for is a dead end, and saying so is
  // better than a silent skip the listener has to work out for themselves.
  if (!canDecode(track.name || track.path || '')) {
    track.undecodable = true;
    state.current = track;
    state.loading = false;
    events.emit('track', track);
    events.emit('unsupported', track);
    events.emit('state');
    return skipForward();
  }

  const token = ++loadToken;
  // Whatever was being measured ends here, and the new track starts its own
  // tally. Committed before `state.current` moves, or the figure lands on the
  // wrong record.
  commitMeter();
  noteLongPosition();
  state.loading = true;
  state.current = track;
  state.time = 0;
  state.duration = track.duration || 0;
  resetMeter(track);
  events.emit('track', track);
  events.emit('state');

  /* A manual change cancels any handover in flight — pressing next during a
     crossfade should land on what was asked for, not on whatever the fade was
     already heading towards. */
  cancelHandover();

  /* The idle deck may already be holding exactly this track, because the
     previous one warmed it. Then there is nothing to load: swap and go. */
  if (idleDeck.trackId === track.id && idleDeck.el.readyState >= 2) {
    const incoming = idleDeck;
    try { incoming.el.currentTime = 0; } catch { /* not seekable yet */ }
    cutTo(incoming);
    applyLevel(incoming, track);
  } else {
    const ok = await cueDeck(deck, track);
    if (token !== loadToken) return;
    if (!ok) {
      state.loading = false;
      events.emit('unavailable', track);
      events.emit('state');
      return skipForward();
    }
    cutTo(deck);
  }
  applyLevel(deck, track);

  /* Start at the first note, where there is dead air and the listener asked
     for it to go. Done before play() rather than after, so nothing of the
     silence is ever heard — a seek a moment later is audible as a stumble. */
  /* A remembered position in a long recording wins over the lead-in trim: one
     is "skip the silence at the start", the other is "you were an hour in",
     and they are not both true at once. */
  const mark = longMarkFor(track.id);
  const cueAt = track.cueStart > 0 ? track.cueStart : 0;
  // A mark is in the piece's own time, so it is placed inside the piece.
  const from = mark > 0 ? cueAt + mark : startOf(track);
  if (from > 0) {
    try { audio.currentTime = from; state.time = Math.max(0, from - cueAt); } catch { /* not seekable */ }
  }
  if (mark > 0) events.emit('resumed', { track, at: mark });

  try {
    if (autoplay) await play();
  } catch (err) {
    if (token === loadToken) { state.loading = false; events.emit('state'); }
  }
  updateMediaSession(track);
  if (count) lib.notePlay(track);
  /* The scrubber wants a waveform and the rack wants a loudness figure, and
     both come out of the same decode. Asked for on idle so it never competes
     with the decode that is actually making sound. */
  peakmap.warm(track, 'wave');
  warmNext();
  /* One deck is playing and nothing is crossfading, so the shared chain is
     safe to change. A direct load is settled the moment it starts; the
     handover path emits this later, when the outgoing deck is parked. */
  events.emit('settled', track);
}

/**
 * Puts the next track on the idle deck, decoded and paused at zero.
 *
 * This used to be a hint to the disk cache — an object URL on a muted element
 * nobody listened to. It is now the thing that makes the handover possible:
 * the deck is genuinely loaded and one `play()` away, which is why a gapless
 * transition costs milliseconds rather than however long the file takes to
 * open.
 */
async function warmNext() {
  const nextTrack = peek(1);
  if (!nextTrack) return;
  if (idleDeck.trackId === nextTrack.id) return;
  if (!canDecode(nextTrack.name || nextTrack.path || '')) return;
  const target = idleDeck;
  await cueDeck(target, nextTrack);
  // Held at the start, silent, until the handover wants it — and already at
  // its own level, so the crossfade never has to move two things at once.
  if (target.trackId === nextTrack.id) {
    try { target.el.currentTime = 0; } catch { /* not seekable yet */ }
    target.el.pause();
    applyLevel(target, nextTrack);
  }
}

/* The fallback figure only exists once a track has been analysed, and that
   finishes a second or two after playback starts. Re-apply when it lands, so
   the first track of a session is levelled too rather than being the one that
   is always wrong. */
peakmap.events.on('peaks', (id) => {
  if (state.current && state.current.id === id) applyLevel(deck, state.current);
  else if (idleDeck.trackId === id) applyLevel(idleDeck, lib.getTrack(id));
});

/* ------------------------------------------------------------------ handover
 *
 * Where gapless and crossfade actually happen.
 *
 * Checked once a frame off the shared ticker, against the audio clock rather
 * than a timer: `setTimeout` in a background tab is clamped to a second or
 * more, which is an eternity when the whole point is to be seamless.
 *
 * At zero crossfade the incoming deck is started as the outgoing one runs out
 * and the gains are swapped at the boundary — the residual gap is one frame,
 * against the several hundred milliseconds a re-`src` costs. Above zero the
 * two overlap for the requested time on an equal-power curve, so the sum holds
 * its loudness through the middle instead of dipping.
 */

function cancelHandover() {
  if (!handover) return;
  const { from, to, timer } = handover;
  handover = null;
  clearTimeout(timer);
  /* Whatever the fade was doing to either gain, stop it and put the decks back
     where they belong: the one being heard at full, the other silent. Leaving
     a scheduled ramp behind is how a cancelled crossfade turns into a track
     that fades itself out thirty seconds later. */
  if (ctx) {
    const t = ctx.currentTime;
    for (const d of [from, to]) {
      if (!d || !d.gain) continue;
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d === deck ? 1 : 0, t);
    }
  }
}

/**
 * Where this track should start, in seconds.
 *
 * Zero unless the listener asked for the silence to be skipped and the
 * analysis found enough of it to be worth skipping. The figure comes off the
 * waveform, which is measured once and kept — nothing is decoded to answer
 * this, and a track with no analysis yet simply starts at zero like it always
 * did.
 */
export function startOf(track) {
  /* L15: a cue track begins where its sheet says, and the lead-in trim does
     not apply — the silence at the top of a side belongs to the first piece
     and to nothing after it. */
  if (track && track.cueStart > 0) return track.cueStart;
  if (!state.trimSilence || !track) return 0;
  const rec = peakmap.peek(track);
  const lead = rec && rec.lead;
  if (!lead || lead < MIN_TRIM) return 0;
  // Never eat more than a fifth of a track: a lead-in that long is the piece.
  const cap = (track.duration || 0) * 0.2;
  return cap > 0 ? Math.min(lead, cap) : lead;
}

/**
 * How far to nudge a handover so the two tracks land in step.
 *
 * Returns seconds to *delay* the overlap by, at most one beat of the outgoing
 * track. The idea is small and the constraint on it is the interesting part:
 * this only runs when both tempos are confident and close, because a
 * beat-match between 92 and 140 is not a transition, it is a collision — and
 * an alignment computed from a tempo the analysis was unsure about is worse
 * than no alignment, because it moves the fade for no reason.
 */
function beatOffset(fromTrack, toTrack, remaining, fade) {
  if (!state.beatMatch || fade <= 0) return 0;
  const a = peakmap.peek(fromTrack);
  const b = peakmap.peek(toTrack);
  if (!a || !b || !a.bpm || !b.bpm) return 0;
  if ((a.bpmConfidence || 0) < 0.4 || (b.bpmConfidence || 0) < 0.4) return 0;
  // Within a tenth of each other, or one is double the other — either can be
  // mixed. Anything else is two different records being played at once.
  const ratio = a.bpm / b.bpm;
  const close = Math.abs(ratio - 1) < 0.1 ||
                Math.abs(ratio - 2) < 0.2 || Math.abs(ratio - 0.5) < 0.05;
  if (!close) return 0;

  const beat = 60 / a.bpm;
  if (!isFinite(beat) || beat <= 0) return 0;
  /* Where the outgoing track's beat grid falls relative to the moment the fade
     would otherwise start. Delay to the next beat, never advance — pulling the
     fade earlier could start it before the arming window and miss it. */
  const startAt = audio.currentTime + Math.max(0, remaining - fade);
  const phase = ((startAt - (a.lead || 0)) % beat + beat) % beat;
  const wait = phase < 0.01 ? 0 : beat - phase;
  return wait < beat * 0.98 ? wait : 0;
}

/** Seconds of overlap actually usable for this pair of tracks. */
function fadeFor(remaining, nextDuration) {
  if (!state.seamless) return -1;
  const want = clamp(state.crossfade, 0, MAX_CROSSFADE);
  if (!want) return 0;
  // Never fade for longer than either track can afford. A ten-second overlap
  // on a nine-second interlude would start it before the previous track's
  // chorus had finished.
  return Math.max(0, Math.min(want, nextDuration ? nextDuration * 0.4 : want));
}

/* How far out the handover is armed. The poll only has to land somewhere in
   this second and a half; a timer does the actual timing. */
const ARM_WINDOW = 1.5;

/**
 * Polled once a frame. Arms the handover; it does not perform it.
 *
 * The obvious version fires the swap directly from the poll, and it is too
 * fragile to ship: gapless has to start the next deck within a few tens of
 * milliseconds of the last one ending, and a poll that misses that window —
 * one dropped frame, a busy machine, a throttled tab — misses the handover
 * entirely and the track ends in silence. Observed, not theorised.
 *
 * So the poll only has to notice that the end is *approaching*, anywhere in a
 * second and a half, and then a single timer does the timing. A timeout in a
 * foreground tab lands within a few milliseconds, and it does not care whether
 * frames are being drawn.
 */
function maybeHandover() {
  if (!state.seamless || handover || !state.playing) return;
  if (state.repeat === 'one') return;
  // "Stop after this one" means exactly that: no handover into the next.
  if (state.sleepUntil === 'track') return;
  const d = state.duration || audio.duration || 0;
  if (!d || !isFinite(d)) return;

  const nextTrack = peek(1);
  if (!nextTrack) return;
  // The deck has to be holding the right track and be ready to play it.
  if (idleDeck.trackId !== nextTrack.id || idleDeck.el.readyState < 3) return;

  const remaining = d - audio.currentTime;
  if (remaining <= 0 || remaining > MAX_CROSSFADE + ARM_WINDOW) return;

  const fade = fadeFor(remaining, nextTrack.duration || 0);
  if (fade < 0) return;
  if (remaining > fade + ARM_WINDOW) return;

  /* Nudged onto the beat where both tracks agree on one, and never by more
     than a single beat — so the overlap still finishes inside the track. */
  const nudge = beatOffset(state.current, nextTrack, remaining, fade);
  const delay = Math.max(0, Math.min(remaining - fade + nudge, remaining));
  armHandover(nextTrack, peekIndex(1), fade, delay);
}

function armHandover(nextTrack, nextIndex, fade, delaySeconds) {
  const from = deck;
  const to = idleDeck;
  const timer = setTimeout(() => beginHandover(nextTrack, nextIndex, fade, from, to),
                           Math.round(delaySeconds * 1000));
  handover = { from, to, id: nextTrack.id, timer, armed: true };
}

function beginHandover(nextTrack, nextIndex, fade, from, to) {
  // Everything may have moved since the timer was set: a seek backwards, a
  // manual skip, a pause. Re-check rather than trusting a 1.5-second-old plan.
  if (!handover || handover.to !== to || handover.from !== from) return;
  if (!state.playing || deck !== from || idleDeck.trackId !== nextTrack.id) {
    cancelHandover();
    return;
  }
  handover.armed = false;

  {
    const t = ctx ? ctx.currentTime : 0;

    if (ctx && from.gain && to.gain) {
      from.gain.gain.cancelScheduledValues(t);
      to.gain.gain.cancelScheduledValues(t);
      if (fade > 0) {
        /* Equal power, in eight steps. `setValueCurveAtTime` would be the
           tidier call and it cannot be used here: it refuses to overlap an
           earlier curve on the same param, and a listener who presses next
           mid-fade produces exactly that. */
        const steps = 8;
        const upCurve = [], downCurve = [];
        const equal = state.fadeCurve !== 'linear';
        for (let i = 0; i <= steps; i++) {
          const x = i / steps;
          // Sine/cosine sum to constant power; x and 1-x sum to constant
          // amplitude. See `fadeCurve` in the state above for which is which.
          upCurve.push(equal ? Math.sin(x * Math.PI / 2) : x);
          downCurve.push(equal ? Math.cos(x * Math.PI / 2) : 1 - x);
        }
        to.gain.gain.setValueAtTime(0, t);
        from.gain.gain.setValueAtTime(from.gain.gain.value, t);
        for (let i = 0; i <= steps; i++) {
          const at = t + (fade * i) / steps;
          to.gain.gain.linearRampToValueAtTime(upCurve[i], at);
          from.gain.gain.linearRampToValueAtTime(downCurve[i], at);
        }
      } else {
        to.gain.gain.setValueAtTime(1, t);
        from.gain.gain.setValueAtTime(0, t);
      }
    }

    to.el.play().catch(() => {});
    finishHandover(nextTrack, nextIndex, from, to, fade);
  }
}

/**
 * Moves the app's idea of "current" onto the incoming deck.
 *
 * Done as the fade starts rather than when it ends, deliberately: the track
 * you can hear coming up is the one the transport, the title and the media
 * session should already be describing. The outgoing deck is left running
 * until its own fade is over and is then parked.
 */
function finishHandover(track, nextIndex, from, to, fade) {
  const token = ++loadToken;
  commitMeter();

  deck = to;
  idleDeck = from;
  audio = to.el;
  rack.bindElement(audio);
  rack.apply();

  /* The position `peek` actually chose, carried down from the arming rather
     than recomputed as `index + 1`. Those two agree everywhere except at the
     end of a queue on repeat-all, where peek wraps to 0 and `index + 1` runs
     off the end and gets clamped to the last track — leaving the transport
     pointing at the record that just finished while the first one plays. */
  state.index = nextIndex >= 0 ? nextIndex
    : Math.min(state.index + 1, state.queue.length - 1);
  state.current = track;
  state.time = to.el.currentTime || 0;
  state.duration = track.duration || to.el.duration || 0;
  resetMeter(track);
  events.emit('track', track);
  events.emit('queue');
  events.emit('state');
  updateMediaSession(track);
  lib.notePlay(track);
  peakmap.warm(track, 'wave');

  // Park the outgoing deck once its fade has finished, then warm what's next.
  const parkIn = Math.max(60, fade * 1000 + 120);
  setTimeout(() => {
    if (token !== loadToken) return;
    from.el.pause();
    try { from.el.currentTime = 0; } catch { /* fine */ }
    releaseDeck(from);
    handover = null;
    warmNext();
    /* The fade is over and only one deck is making sound. Anything that
       changes the chain both decks share — a rack bound to this record —
       has been waiting for exactly this moment: doing it a moment earlier
       would have equalised the tail of the record that just ended. */
    events.emit('settled', track);
  }, parkIn);
}

/* ------------------------------------------------------------------ control */

export async function play() {
  if (!state.current) {
    if (state.queue.length) return jumpTo(0);
    return;
  }
  ensureGraph();
  if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  try {
    await audio.play();
    state.playing = true;
  } catch (err) {
    state.playing = false;
  }
  events.emit('state');
}

export function pause() {
  /* Both of them. Mid-crossfade there are two decks making sound, and pausing
     only the one the transport calls "current" leaves the other playing to
     the end of the fade with nothing on screen to explain it. */
  cancelHandover();
  deckA.el.pause();
  deckB.el.pause();
  state.playing = false;
  /* Pausing an hour into a long recording is the moment somebody is most
     likely to walk away and close the tab. `pagehide` also writes the mark,
     but a write started as the page is being torn down is not guaranteed to
     land; this one has all the time it needs. */
  noteLongPosition();
  events.emit('state');
}

export function toggle() { state.playing ? pause() : play(); }

export function seek(seconds) {
  if (!state.current) return;
  /* An armed handover was timed against where the playhead used to be. Seeking
     backwards would leave it to fire mid-track and change the record on you. */
  if (handover && handover.armed) cancelHandover();
  // The piece's own length, not the file's: `state.duration` is already the
  // former for a cue track, and `audio.duration` would be the latter.
  const d = state.duration || (state.current && state.current.cueStart !== undefined ? 0 : audio.duration) || 0;
  const want = clamp(seconds, 0, Math.max(0, d - 0.05));
  // L15: the scrubber and everything reading `state.time` work in the piece's
  // own time; the element works in the file's. `cueOffset` is the difference,
  // and it is zero for every track that is a file of its own.
  audio.currentTime = want + cueOffset();
  state.time = want;
  events.emit('time', state.time);
}

/** Where in the file the current piece starts. Zero unless it came from a cue. */
const cueOffset = () => (state.current && state.current.cueStart > 0 ? state.current.cueStart : 0);

export const seekRatio = (r) => seek(r * (state.duration || 0));

/*
 * Where the sound comes out.
 *
 * Both decks, because either of them can be the one you are hearing — routing
 * only the live one moves the music back to the default at the next handover.
 * `setSinkId` is a promise that rejects if the device has gone, which happens
 * constantly with anything on USB, so a failure puts the setting back to the
 * default rather than leaving it pointing at something that is not there.
 */
export async function setSink(id) {
  const wanted = id || '';
  if (!deckA.el.setSinkId) return { supported: false, ok: false };
  try {
    await Promise.all([deckA.el.setSinkId(wanted), deckB.el.setSinkId(wanted)]);
    state.sink = wanted;
    db.setKV('sink', wanted).catch(() => {});
    events.emit('state');
    return { supported: true, ok: true };
  } catch {
    state.sink = '';
    db.setKV('sink', '').catch(() => {});
    events.emit('state');
    return { supported: true, ok: false };
  }
}

/** Whether this browser can route audio anywhere but the system default. */
export function canRouteOutput() {
  return typeof deckA.el.setSinkId === 'function' && !!navigator.mediaDevices?.enumerateDevices;
}

/**
 * Whether the outputs already carry names.
 *
 * `enumerateDevices` always answers, but before permission is granted every
 * label is the empty string — a list of four blanks is worse than no list, so
 * this is what decides between showing the picker and showing the button.
 */
export async function outputsNamed() {
  if (!canRouteOutput()) return false;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outs = all.filter((d) => d.kind === 'audiooutput');
    return outs.length > 1 && outs.some((d) => d.label);
  } catch { return false; }
}

/** The named outputs, minus the default the empty option already stands for. */
export async function outputs() {
  if (!canRouteOutput()) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Output ' + d.deviceId.slice(0, 6) }));
  } catch { return []; }
}

/**
 * Asks for the permission that puts names on the outputs.
 *
 * `selectAudioOutput` asks for exactly that and nothing else, but only Firefox
 * has it. Everywhere else the only key to the labels is a microphone grant,
 * which is opened and closed immediately: the track is stopped on the next
 * line, so nothing is recorded and no indicator stays lit.
 */
export async function askForOutputs() {
  if (!canRouteOutput()) return false;
  if (navigator.mediaDevices.selectAudioOutput) {
    try {
      const d = await navigator.mediaDevices.selectAudioOutput();
      if (d?.deviceId) await setSink(d.deviceId);
      return true;
    } catch { return false; }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return true;
  } catch { return false; }
}

export function setFadeCurve(curve) {
  state.fadeCurve = curve === 'linear' ? 'linear' : 'equal';
  db.setKV('fadeCurve', state.fadeCurve).catch(() => {});
  events.emit('state');
}

export function setVolume(v) {
  state.volume = clamp(v, 0, 1);
  if (state.volume > 0) state.muted = false;
  applyVolume();
  db.setKV('volume', state.volume).catch(() => {});
  events.emit('volume');
}

export function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  events.emit('volume');
}

export function setShuffle(on) {
  state.shuffle = on === undefined ? !state.shuffle : on;
  if (state.shuffle) buildShuffle(); else restoreOrder();
  db.setKV('shuffle', state.shuffle).catch(() => {});
  events.emit('queue');
}

/**
 * Seconds of overlap between tracks. Zero is gapless.
 *
 * One control for both, because they are one mechanism: at zero the next deck
 * starts as the last one ends, and above zero they overlap. Anyone reaching
 * for "gapless" and anyone reaching for "crossfade" is reaching for the same
 * knob at two of its positions.
 */
export function setCrossfade(seconds) {
  state.crossfade = clamp(Number(seconds) || 0, 0, MAX_CROSSFADE);
  db.setKV('crossfade', state.crossfade).catch(() => {});
  events.emit('state');
}

/**
 * Loudness levelling: 'off', 'track' or 'album'.
 *
 * Album is not just a different number, it is a different intention: it keeps
 * the balance the record was mastered with — the quiet interlude stays quiet
 * against the song after it — and only moves the record as a whole. Track
 * evens out every song against every other, which is what a shuffle across
 * four decades needs and what a concept album does not.
 */
export function setLevelling(mode) {
  state.levelling = mode === 'off' || mode === 'album' ? mode : 'track';
  applyLevel(deck, state.current);
  if (idleDeck.trackId) applyLevel(idleDeck, lib.getTrack(idleDeck.trackId));
  db.setKV('levelling', state.levelling).catch(() => {});
  events.emit('state');
}

/** The correction in dB currently applied to a track, for the readouts. */
export const levelFor = (track) => levelDbFor(track);

/** Start at the first note rather than at the first sample. */
export function setTrimSilence(on) {
  state.trimSilence = on === undefined ? !state.trimSilence : !!on;
  db.setKV('trimSilence', state.trimSilence).catch(() => {});
  events.emit('state');
}

/** Line the overlap up with the beat where both tracks agree on one. */
export function setBeatMatch(on) {
  state.beatMatch = on === undefined ? !state.beatMatch : !!on;
  db.setKV('beatMatch', state.beatMatch).catch(() => {});
  events.emit('state');
}

/**
 * Jumps to the part of the track that repeats most — the chorus, in nearly all
 * popular music. Returns false when the analysis declined to name one, which
 * is the honest answer for anything through-composed.
 */
export function playHook(track) {
  const t = track || state.current;
  if (!t) return false;
  const rec = peakmap.peek(t);
  if (!rec || rec.hookAt == null || (rec.hookConfidence || 0) < 0.35) return false;
  if (state.current !== t) { playTracks([t], 0, state.origin); }
  seek(rec.hookAt);
  play();
  return true;
}

/** Where the hook is, or null. For the menu, which hides itself without one. */
export function hookOf(track) {
  const rec = track && peakmap.peek(track);
  if (!rec || rec.hookAt == null || (rec.hookConfidence || 0) < 0.35) return null;
  return { at: rec.hookAt, length: rec.hookLen, confidence: rec.hookConfidence };
}

/** Whether tracks run into each other at all. Off restores the plain gap. */
export function setSeamless(on) {
  state.seamless = on === undefined ? !state.seamless : !!on;
  if (!state.seamless) cancelHandover();
  db.setKV('seamless', state.seamless).catch(() => {});
  syncHandoverWatch();
  events.emit('state');
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  db.setKV('repeat', state.repeat).catch(() => {});
  events.emit('state');
}

/* ------------------------------------------------------------------ queue */

let baseOrder = [];        // pre-shuffle order, so unshuffling restores it

export function setQueue(tracks, startIndex = 0, origin = null) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  baseOrder = ids.slice();
  state.queue = ids.slice();
  state.origin = origin;
  /* A fresh queue replaces the old provenance wholesale: the tracks somebody
     added by hand to the *last* queue are not in this one. */
  provenance.clear();
  noteOrigin(ids, origin && origin.label);

  if (state.shuffle && ids.length > 1) {
    const first = state.queue[startIndex];
    shuffleInPlace(state.queue);
    const at = state.queue.indexOf(first);
    if (at > 0) { state.queue.splice(at, 1); state.queue.unshift(first); }
    startIndex = 0;
  }
  state.index = clamp(startIndex, 0, Math.max(0, state.queue.length - 1));
  events.emit('queue');
  const t = lib.getTrack(state.queue[state.index]);
  if (t) load(t, true);
}

function buildShuffle() {
  if (!state.queue.length) return;
  const currentId = state.queue[state.index];
  baseOrder = baseOrder.length ? baseOrder : state.queue.slice();
  const rest = state.queue.filter((id) => id !== currentId);
  shuffleInPlace(rest);
  state.queue = currentId ? [currentId, ...rest] : rest;
  state.index = currentId ? 0 : -1;
}

function restoreOrder() {
  if (!baseOrder.length) return;
  const currentId = state.queue[state.index];
  state.queue = baseOrder.slice();
  state.index = Math.max(0, state.queue.indexOf(currentId));
}

function shuffleInPlace(arr) {
  if (state.shuffleMode === 'weighted') return weightedShuffle(arr);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * A shuffle that knows what you actually listen to.
 *
 * A uniform shuffle of a four-thousand-track library is mostly a tour of the
 * things you skipped in 2019. The signal for doing better is already here: the
 * play counts, the favourites, and the recent list.
 *
 * The weighting is deliberately gentle, and that restraint is the whole design.
 * A strong weighting stops being a shuffle and becomes a greatest-hits loop —
 * you would hear your top forty tracks and nothing else, which is worse than
 * random because at least random finds things. So the multipliers are small,
 * everything keeps a floor, and the *only* aggressive term is a negative one:
 * something played in the last few dozen tracks is pushed well down, because
 * the one thing a shuffle must never do is repeat itself immediately.
 *
 * Implemented as a weighted sample without replacement, using the exponential
 * trick — a key of `-ln(U)/w` sorted ascending draws exactly in proportion to
 * the weights, in one pass and one sort, with no repeated scanning.
 */
function weightedShuffle(arr) {
  const recent = lib.history.recent || [];
  // Position in the recent list, most recent first.
  const seenAt = new Map();
  for (let i = 0; i < recent.length && i < 60; i++) {
    if (!seenAt.has(recent[i])) seenAt.set(recent[i], i);
  }

  const keyed = arr.map((id) => {
    /* The count lives on the track record, which is where notePlay writes it.
       This used to read `history.plays`, a Map that is declared and never
       filled — so the play-count term contributed exactly nothing and the
       shuffle was leaning on favourites and recency alone. The unit test that
       passed had populated that Map by hand, which is how a dead read survives
       a green test. */
    const plays = (lib.getTrack(id) || {}).playCount || 0;
    // Diminishing returns: the fortieth listen should not count forty times.
    let w = 1 + Math.log1p(plays) * 0.55;
    if (lib.isFavourite(id)) w *= 1.5;
    const at = seenAt.get(id);
    if (at !== undefined) {
      // Heard in the last sixty: from a twentieth of a chance up to nearly
      // normal as it recedes.
      w *= 0.05 + 0.95 * (at / 60);
    }
    if (!(w > 0.01)) w = 0.01;
    return { id, k: -Math.log(Math.random() || 1e-9) / w };
  });

  keyed.sort((a, b) => a.k - b.k);
  for (let i = 0; i < arr.length; i++) arr[i] = keyed[i].id;
  return arr;
}

/** 'even' is the plain shuffle; 'weighted' leans on your listening. */
export function setShuffleMode(mode) {
  state.shuffleMode = mode === 'weighted' ? 'weighted' : 'even';
  db.setKV('shuffleMode', state.shuffleMode).catch(() => {});
  if (state.shuffle) { buildShuffle(); events.emit('queue'); }
  events.emit('state');
}

/* ------------------------------------------------------------------ sleep
 *
 * A timer that ends the evening rather than cutting it off.
 *
 * The last thirty seconds are a fade rather than a stop, because waking up to
 * a hard silence is worse than the music. It rides the same volume node the
 * slider uses, and it puts the volume back afterwards — a sleep timer that
 * leaves you at zero the next morning is a bug people would blame on the
 * speakers.
 *
 * "End of track" is the other thing people mean by this, and it is a different
 * shape: no clock at all, just a flag that stops the handover from happening.
 */
const SLEEP_FADE = 30;

let sleepTimer = 0;
let sleepFade = null;

/** Seconds left, or null if no timer is running. */
export function sleepRemaining() {
  if (state.sleepUntil === 'track') return 'track';
  if (!state.sleepUntil) return null;
  return Math.max(0, (state.sleepUntil - Date.now()) / 1000);
}

export function setSleep(minutes) {
  clearTimeout(sleepTimer);
  sleepTimer = 0;
  if (sleepFade) { sleepFade(); sleepFade = null; }

  if (!minutes) {
    state.sleepUntil = null;
  } else if (minutes === 'track') {
    state.sleepUntil = 'track';
  } else {
    state.sleepUntil = Date.now() + minutes * 60000;
    const ms = minutes * 60000;
    // Two timers: one to start the fade, one to stop. The fade is scheduled on
    // the audio clock so it keeps its shape even if the tab is throttled.
    sleepTimer = setTimeout(() => {
      beginSleepFade();
      sleepTimer = setTimeout(() => finishSleep(), SLEEP_FADE * 1000);
    }, Math.max(0, ms - SLEEP_FADE * 1000));
  }
  events.emit('sleep');
  events.emit('state');
}

function beginSleepFade() {
  if (!ctx || !gain) return;
  const t = ctx.currentTime;
  const from = gain.gain.value;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(from, t);
  gain.gain.linearRampToValueAtTime(0.0001, t + SLEEP_FADE);
  sleepFade = () => {
    // Cancelled part-way: put the volume back where the slider says it is.
    gain.gain.cancelScheduledValues(ctx.currentTime);
    applyVolume();
  };
}

function finishSleep() {
  pause();
  state.sleepUntil = null;
  sleepFade = null;
  // The gain was ramped to nearly zero to get here; the slider never moved, so
  // restoring from it is what makes the next press of play work normally.
  applyVolume();
  events.emit('sleep');
  events.emit('state');
}

/*
 * Where each queued track came from.
 *
 * `state.origin` says where the *queue* came from, which stops being the whole
 * truth the moment anything is added by hand — and after an evening of
 * right-clicking, a queue that mixes an album, a shuffle and eight things you
 * picked has nothing on screen saying which is which. So "why is this playing?"
 * has no answer, and pulling the shuffle back out without losing the eight is
 * impossible.
 *
 * Keyed by id and not by position, because positions move under drag,
 * shuffle and removal, and a label that follows the wrong row is worse than
 * none. An id that appears twice gets one label, which is the honest limit of
 * a map and not worth a second data structure to fix.
 */
const provenance = new Map();

/** What to print beside a queued track, or ''. */
export const originOf = (id) => provenance.get(id) || '';

function noteOrigin(ids, label) {
  if (!label) return;
  for (const id of ids) provenance.set(id, label);
}

export function playNext(tracks) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  state.queue.splice(state.index + 1, 0, ...ids);
  baseOrder.push(...ids);                    // so unshuffling keeps them
  noteOrigin(ids, 'Added');
  events.emit('queue');
  warmNext();
}

/**
 * C2: puts tracks at a chosen place in the queue.
 *
 * `playNext` and `enqueue` are the two ends of this; a drop lands wherever the
 * pointer was, which is neither. The index is clamped rather than rejected —
 * a drop past the last row means the end, which is what it looks like.
 */
export function insertAt(tracks, at) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  if (!ids.length) return 0;
  const where = Math.max(0, Math.min(state.queue.length, at | 0));
  state.queue.splice(where, 0, ...ids);
  baseOrder.push(...ids);
  noteOrigin(ids, 'Added');
  // A track inserted before the playhead moves the playhead with it, so the
  // song that is playing carries on being the song that is playing.
  if (where <= state.index) state.index += ids.length;
  if (state.index < 0 && state.queue.length) jumpTo(0);
  else { events.emit('queue'); warmNext(); }
  return ids.length;
}

export function enqueue(tracks) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  state.queue.push(...ids);
  baseOrder.push(...ids);
  noteOrigin(ids, 'Added');
  if (state.index < 0 && state.queue.length) jumpTo(0);
  else { events.emit('queue'); warmNext(); }
}

/**
 * Removing the track that is playing hands the slot to whatever moved into it,
 * so the queue closes over the gap instead of jumping backwards — and playback
 * keeps its state: paused stays paused, playing keeps playing.
 */
export function removeAt(i) {
  if (i < 0 || i >= state.queue.length) return;
  const [removed] = state.queue.splice(i, 1);
  const b = baseOrder.indexOf(removed);
  if (b >= 0) baseOrder.splice(b, 1);

  if (i < state.index) {
    state.index--;
  } else if (i === state.index) {
    if (!state.queue.length) {
      pause();
      state.index = -1;
    } else {
      const resume = state.playing;
      state.index = Math.min(i, state.queue.length - 1);
      const t = lib.getTrack(state.queue[state.index]);
      if (t) load(t, resume);
    }
  }
  events.emit('queue');
  warmNext();
}

/**
 * Moves a queued track. The panel used to splice `state.queue` itself, which
 * left `baseOrder` describing an order the queue no longer had — so turning
 * shuffle off afterwards restored the wrong sequence. Reordering belongs to
 * whoever owns both arrays, which is here.
 */
export function moveInQueue(from, to) {
  const n = state.queue.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
  const [moved] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, moved);

  if (from === state.index) state.index = to;
  else if (from < state.index && to >= state.index) state.index--;
  else if (from > state.index && to <= state.index) state.index++;

  // Keep the un-shuffled order describing the same set in the same relative
  // order, so switching shuffle off lands somewhere sensible.
  const b = baseOrder.indexOf(moved);
  if (b >= 0) {
    baseOrder.splice(b, 1);
    baseOrder.splice(Math.min(to, baseOrder.length), 0, moved);
  }
  events.emit('queue');
  warmNext();
}

export function clearQueue() {
  const kept = new Set(state.queue.slice(0, state.index + 1));
  state.queue = state.queue.slice(0, state.index + 1);
  baseOrder = baseOrder.filter((id) => kept.has(id));
  events.emit('queue');
}

/**
 * Which queue position is `offset` away, honouring repeat-all's wraparound,
 * or -1 if there is nothing there.
 *
 * Split out from `peek` because the handover needs the *position* and not only
 * the track. It used to assume the answer was always `index + 1`, which is
 * true everywhere except the one place it matters: at the end of a queue on
 * repeat-all, `peek` wraps to 0 while `index + 1` runs off the end.
 */
function peekIndex(offset) {
  const i = state.index + offset;
  if (i >= 0 && i < state.queue.length) return i;
  if (state.repeat === 'all' && state.queue.length) {
    return (i % state.queue.length + state.queue.length) % state.queue.length;
  }
  return -1;
}

function peek(offset) {
  const i = peekIndex(offset);
  return i < 0 ? null : lib.getTrack(state.queue[i]);
}

export function jumpTo(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  const t = lib.getTrack(state.queue[index]);
  events.emit('queue');
  if (t) load(t, true);
}

/** Move past a track we cannot play, without ever looping back onto it. */
function skipForward() {
  if (state.index + 1 < state.queue.length) return jumpTo(state.index + 1);
  pause();
}

export function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { seek(0); play(); return; }
  if (state.index + 1 < state.queue.length) return jumpTo(state.index + 1);
  if (state.repeat === 'all') return jumpTo(0);
  // End of queue: stop cleanly but keep the track loaded for replay.
  pause();
  seek(0);
}

export function prev() {
  if (state.time > 3 || state.index <= 0) { seek(0); return; }
  jumpTo(state.index - 1);
}

/**
 * Restores a queue without touching playback — used when a previous session is
 * being put back together and the track is cued separately.
 */
export function setQueueSilently(ids, index = 0, origin = null) {
  if (!Array.isArray(ids) || !ids.length) return;
  state.queue = ids.slice();
  baseOrder = ids.slice();
  state.index = clamp(index, 0, ids.length - 1);
  state.origin = origin;
  events.emit('queue');
}

/**
 * Loads a track, seeks to a position and tries to start it.
 *
 * Returns whether playback actually began. It very often has not: browsers
 * refuse `play()` until the origin has seen a gesture, and a resume on a fresh
 * tab has seen none. The caller is expected to offer a button rather than
 * pretend — which is why this reports the truth instead of throwing.
 */
export async function cue(track, position = 0) {
  if (!track) return false;
  await load(track, false, { count: false });
  if (state.current !== track) return false;          // superseded mid-load

  if (position > 0) {
    if (!(isFinite(audio.duration) && audio.duration > 0)) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); audio.removeEventListener('loadedmetadata', done); resolve(); };
        const timer = setTimeout(done, 1500);
        audio.addEventListener('loadedmetadata', done);
      });
    }
    seek(position);
  }

  await play();
  return state.playing;
}

/** Convenience used by every "play" button in the UI. */
export function playTracks(tracks, startIndex = 0, origin = null) {
  if (!tracks || !tracks.length) return;
  setQueue(tracks, startIndex, origin);
}

/* ------------------------------------------------------------------ element */

/* Both decks are wired identically and every handler asks the same first
   question: are you the deck being heard? The idle deck loads, buffers, ends
   and errors all the time, and none of that is the transport's business —
   before the decks existed there was one element and the question did not need
   asking, which is exactly why forgetting it here would be so quiet. */
for (const d of [deckA, deckB]) {
  const mine = () => d === deck;

  d.el.addEventListener('loadedmetadata', () => {
    if (!mine()) return;
    const real = d.el.duration;
    state.loading = false;
    // `preservesPitch` is reset by some engines when a new source loads, and a
    // speed setting that silently stops preserving pitch between tracks is worse
    // than one that never worked.
    rack.apply();
    if (isFinite(real) && real > 0) {
      const t = state.current;
      /* L15: the decoder is reporting the length of the *file*, and a piece
         cut out of a cue sheet is not the file. Its length is the distance
         between two indexes, which the sheet already said exactly — and the
         last piece's end is the file's own duration, which is the one case
         where the decoder has something to add. */
      if (t && t.cueStart !== undefined) {
        const end = t.cueEnd === null || t.cueEnd === undefined ? real : t.cueEnd;
        state.duration = Math.max(0, end - (t.cueStart || 0));
      } else {
        state.duration = real;
        // Container-derived durations can be estimates; trust the decoder.
        if (t && Math.abs((t.duration || 0) - real) > 1.2) {
          t.duration = Math.round(real * 10) / 10;
          db.putTracks([t]).catch(() => {});
          lib.events.emit('change');
        }
      }
    }
    events.emit('state');
  });

  d.el.addEventListener('timeupdate', () => {
    if (!mine()) return;
    const cur = state.current;
    /* L15: a piece of a side ends where the next one begins, and the file
       plays straight through it. Checked on the clock rather than by an
       `ended` event, because there is no `ended` in the middle of a file —
       this *is* the end of the track as far as everything above is concerned.

       A quarter-second of slack, because `timeupdate` fires about four times
       a second and waiting for an exact crossing would overrun. */
    if (cur && cur.cueEnd > 0 && d.el.currentTime >= cur.cueEnd - 0.02) {
      state.time = cur.duration || 0;
      events.emit('time', state.time);
      next(true);
      return;
    }
    state.time = cur && cur.cueStart > 0
      ? Math.max(0, d.el.currentTime - cur.cueStart)
      : d.el.currentTime;
    events.emit('time', state.time);
  });

  d.el.addEventListener('ended', () => {
    if (!mine()) return;
    // A handover already moved everything onto the other deck; this is just
    // the old one running out behind the fade.
    if (handover) return;
    if (state.sleepUntil === 'track') {
      pause();
      seek(0);
      setSleep(null);
      return;
    }
    next(true);
  });

  d.el.addEventListener('play', () => { if (mine()) { state.playing = true; syncMeter(); events.emit('state'); } });
  d.el.addEventListener('pause', () => {
    // A deck paused *by* a handover is not the transport stopping.
    if (!mine() || handover) return;
    state.playing = false; syncMeter(); events.emit('state');
  });
  d.el.addEventListener('waiting', () => { if (mine()) { state.loading = true; events.emit('state'); } });
  d.el.addEventListener('playing', () => { if (mine()) { state.loading = false; events.emit('state'); } });

  d.el.addEventListener('error', () => {
    // An idle deck that cannot open the next file simply is not offered for a
    // handover; the ordinary path will report it when it gets there.
    if (!mine()) { releaseDeck(d); return; }
    state.loading = false;
    if (!state.current) return;
    // The decoder is the authority on what it can decode, so a failure here is
    // what teaches the library that this format is out of reach; the row picks
    // the flag up the next time it renders.
    const err = d.el.error;
    if (err && (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
                err.code === MediaError.MEDIA_ERR_DECODE)) {
      state.current.undecodable = true;
    }
    events.emit('error', state.current);
    // next(true) would honour repeat-one and retry the same unreadable file for
    // as long as anyone was willing to watch it.
    skipForward();
  });
}

/* The handover is checked against the audio clock once a frame, and only while
   something is playing. A timer would be wrong: `setTimeout` is clamped to a
   second or more in a background tab, which is an eternity for something whose
   whole job is to be seamless. */
let stopHandoverWatch = null;
function syncHandoverWatch() {
  const wanted = state.playing && state.seamless;
  if (wanted && !stopHandoverWatch) stopHandoverWatch = tick(maybeHandover);
  else if (!wanted && stopHandoverWatch) { stopHandoverWatch(); stopHandoverWatch = null; }
}
events.on('state', syncHandoverWatch);

/** Live playhead. audio's own timeupdate only fires ~4x/second. */
export const currentTime = () =>
  (state.playing ? Math.max(0, audio.currentTime - cueOffset()) : state.time);
export const buffered = () => {
  try {
    const b = audio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  } catch { return 0; }
};

/* ------------------------------------------------------------------ OS media */

async function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const art = await lib.loadArt(track.albumKey);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: art ? [{ src: art, sizes: '448x448', type: 'image/webp' }] : [],
  });
}

if ('mediaSession' in navigator) {
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  set('play', play);
  set('pause', pause);
  set('previoustrack', prev);
  set('nexttrack', () => next(false));
  set('seekbackward', (d) => seek(state.time - (d?.seekOffset || 10)));
  set('seekforward', (d) => seek(state.time + (d?.seekOffset || 10)));
  set('seekto', (d) => { if (d?.seekTime != null) seek(d.seekTime); });
  events.on('state', () => {
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    pushPosition();
  });
  events.on('time', pushPosition);
}

/*
 * Where in the track we are, told to the operating system.
 *
 * Everything else about Media Session was here — metadata, artwork, play,
 * pause, next, previous, seek — and this one call was not, so every OS-level
 * scrubber showed a track with no progress at all: the lock screen, macOS Now
 * Playing, the Android notification, a car head unit. Three lines for the
 * single most visible thing in this file outside the app's own window.
 *
 * Throttled to about twice a second. The `time` event fires on every frame the
 * playhead moves and the platform does its own interpolation between updates,
 * so pushing it sixty times a second is sixty times the work for a readout
 * nobody can see move that fast.
 */
/*
 * Where you had got to in something long.
 *
 * Session restore puts back the track and the playhead you left — but only for
 * the one that was playing. Come back to a two-hour DJ mix, a live set or a
 * radio show a week later and it starts at zero, which for that kind of
 * recording is the whole of the problem: nobody wants to scrub for four
 * minutes to find where they were.
 *
 * Only for things long enough that the position is worth keeping, and only
 * past the first couple of minutes — a mark at 0:30 in a two-hour file is not
 * a place anybody was, it is a track that got started and abandoned. Cleared
 * when the end is reached, because a finished thing should start again.
 */
const LONG_TRACK = 20 * 60;        // seconds; below this the mark is noise
const LONG_MIN_IN = 120;           // and this far in before it counts
const LONG_MIN_LEFT = 60;          // near enough to the end is finished
const longMarks = new Map();       // track id -> seconds

function noteLongPosition() {
  const t = state.current;
  if (!t) return;
  const d = state.duration || 0;
  if (d < LONG_TRACK) return;
  const at = state.time || 0;
  if (at < LONG_MIN_IN || d - at < LONG_MIN_LEFT) longMarks.delete(t.id);
  else longMarks.set(t.id, Math.round(at));
  db.setKV('marks', Object.fromEntries(longMarks)).catch(() => {});
}

/** Where a long track should start, or 0. Read by the player and by the UI. */
export const longMarkFor = (id) => longMarks.get(id) || 0;
export function clearLongMark(id) {
  if (!longMarks.delete(id)) return;
  db.setKV('marks', Object.fromEntries(longMarks)).catch(() => {});
}

let positionAt = 0;
function pushPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = performance.now();
  if (now - positionAt < 450) return;
  positionAt = now;
  const duration = state.duration || 0;
  if (!duration || !isFinite(duration)) {
    // A live stream or a file whose length is not known yet: clearing is the
    // honest answer, and passing a bad duration throws.
    try { navigator.mediaSession.setPositionState(); } catch { /* not supported */ }
    return;
  }
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: clamp(state.time || 0, 0, duration),
    });
  } catch { /* a rate of zero, or a position past the end mid-handover */ }
}

/* ------------------------------------------------------------------ restore */

export async function init() {
  const [vol, shuffle, repeat, crossfade, seamless, levelling, shuffleMode, trimSilence, beatMatch,
         fadeCurve, sink, marks] = await Promise.all([
    db.getKV('volume').catch(() => null),
    db.getKV('shuffle').catch(() => null),
    db.getKV('repeat').catch(() => null),
    db.getKV('crossfade').catch(() => null),
    db.getKV('seamless').catch(() => null),
    db.getKV('levelling').catch(() => null),
    db.getKV('shuffleMode').catch(() => null),
    db.getKV('trimSilence').catch(() => null),
    db.getKV('beatMatch').catch(() => null),
    db.getKV('fadeCurve').catch(() => null),
    db.getKV('sink').catch(() => null),
    db.getKV('marks').catch(() => null),
  ]);
  if (typeof vol === 'number') state.volume = clamp(vol, 0, 1);
  if (typeof shuffle === 'boolean') state.shuffle = shuffle;
  if (repeat === 'all' || repeat === 'one') state.repeat = repeat;
  if (typeof crossfade === 'number') state.crossfade = clamp(crossfade, 0, MAX_CROSSFADE);
  if (typeof seamless === 'boolean') state.seamless = seamless;
  if (levelling === 'off' || levelling === 'album' || levelling === 'track') state.levelling = levelling;
  if (shuffleMode === 'weighted' || shuffleMode === 'even') state.shuffleMode = shuffleMode;
  if (typeof trimSilence === 'boolean') state.trimSilence = trimSilence;
  if (typeof beatMatch === 'boolean') state.beatMatch = beatMatch;
  if (fadeCurve === 'linear' || fadeCurve === 'equal') state.fadeCurve = fadeCurve;
  if (marks && typeof marks === 'object') for (const [k, v] of Object.entries(marks)) longMarks.set(k, v);
  /* The device may not be there any more — a headset unplugged, an interface
     powered off — so this is attempted rather than assumed, and `setSink`
     falls back to the default when it is gone. */
  if (typeof sink === 'string' && sink) setSink(sink).catch(() => {});
  applyVolume();
  // The rack owns playback speed, which is a property of the element and works
  // with or without a Web Audio graph — and the graph does not exist until the
  // first play.
  rack.bindElement(audio);
  rack.preload();
  events.emit('volume');
  events.emit('state');
}

window.addEventListener('pagehide', () => {
  // A listen that ends because the tab did is still a listen.
  commitMeter();
  noteLongPosition();
  releaseDeck(deckA); releaseDeck(deckB);
});
