/* player.js — playback, queue, and the Web Audio graph.
 *
 * One <audio> element does the decoding; a second, silent one warms the next
 * track's object URL so track changes are instant. Volume runs through a
 * GainNode on a perceptual curve rather than the element's linear property,
 * and an AnalyserNode feeds the visualiser — banded onto a logarithmic scale
 * once per frame, because that is how hearing is arranged and how a spectrum
 * has to be drawn for the bars to line up with what you can hear.
 */

import * as lib from './library.js';
import * as db from './db.js';
import { Emitter, clamp, canDecode } from './util.js';

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
};

const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous';

const preloader = new Audio();
preloader.preload = 'auto';
preloader.muted = true;

let currentURL = null;
let preloadURL = null;
let preloadId = null;
let loadToken = 0;

/* ------------------------------------------------------------------ graph */

let ctx = null, gain = null, analyser = null, source = null;
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

function ensureGraph() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    source = ctx.createMediaElementSource(audio);
    gain = ctx.createGain();
    analyser = ctx.createAnalyser();
    // 2048 buys ~23 Hz of resolution at 48 kHz: enough to separate the bass
    // bands, cheap enough to read every frame.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.62;
    analyser.minDecibels = -84;
    analyser.maxDecibels = -18;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.frequencyBinCount);
    source.connect(gain).connect(analyser).connect(ctx.destination);
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

/** Loudness is perceived roughly logarithmically, so square the slider. */
function applyVolume() {
  const v = state.muted ? 0 : state.volume * state.volume;
  if (gain) gain.gain.value = v;
  else audio.volume = state.muted ? 0 : state.volume;
}

/**
 * One reading of the spectrum per frame, shared by every visualiser on screen.
 *
 * Bands are logarithmic, tilted to undo the natural roll-off of recorded music
 * so the top end is visible at all, smoothed asymmetrically (fast attack, slow
 * release — the shape of a real VU meter) and capped by peaks that fall under
 * their own weight. Nothing here allocates.
 */
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

async function load(track, autoplay) {
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
  state.loading = true;
  state.current = track;
  state.time = 0;
  state.duration = track.duration || 0;
  events.emit('track', track);
  events.emit('state');

  let url = null;
  if (preloadId === track.id && preloadURL) {         // already warmed
    url = preloadURL;
    preloadURL = null; preloadId = null;
  } else {
    const file = await lib.fileFor(track.id);
    if (token !== loadToken) return;
    if (!file) {
      state.loading = false;
      events.emit('unavailable', track);
      events.emit('state');
      return skipForward();
    }
    url = URL.createObjectURL(file);
  }

  revoke(currentURL);
  currentURL = url;
  audio.src = url;

  try {
    audio.load();
    if (autoplay) await play();
  } catch (err) {
    if (token === loadToken) { state.loading = false; events.emit('state'); }
  }
  updateMediaSession(track);
  lib.notePlay(track);
  warmNext();
}

/** Pre-opens the next file so pressing "next" doesn't wait on the disk. */
async function warmNext() {
  const nextTrack = peek(1);
  if (!nextTrack || nextTrack.id === preloadId) return;
  revoke(preloadURL);
  preloadURL = null; preloadId = null;
  const file = await lib.fileFor(nextTrack.id);
  if (!file) return;
  preloadURL = URL.createObjectURL(file);
  preloadId = nextTrack.id;
  preloader.src = preloadURL;                          // nudges the disk cache
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
  audio.pause();
  state.playing = false;
  events.emit('state');
}

export function toggle() { state.playing ? pause() : play(); }

export function seek(seconds) {
  if (!state.current) return;
  const d = state.duration || audio.duration || 0;
  audio.currentTime = clamp(seconds, 0, Math.max(0, d - 0.05));
  state.time = audio.currentTime;
  events.emit('time', state.time);
}

export const seekRatio = (r) => seek(r * (state.duration || 0));

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
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function playNext(tracks) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  state.queue.splice(state.index + 1, 0, ...ids);
  baseOrder.push(...ids);                    // so unshuffling keeps them
  events.emit('queue');
  warmNext();
}

export function enqueue(tracks) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  state.queue.push(...ids);
  baseOrder.push(...ids);
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

function peek(offset) {
  const i = state.index + offset;
  if (i >= 0 && i < state.queue.length) return lib.getTrack(state.queue[i]);
  if (state.repeat === 'all' && state.queue.length) {
    return lib.getTrack(state.queue[(i % state.queue.length + state.queue.length) % state.queue.length]);
  }
  return null;
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

/** Convenience used by every "play" button in the UI. */
export function playTracks(tracks, startIndex = 0, origin = null) {
  if (!tracks || !tracks.length) return;
  setQueue(tracks, startIndex, origin);
}

/* ------------------------------------------------------------------ element */

audio.addEventListener('loadedmetadata', () => {
  const real = audio.duration;
  state.loading = false;
  if (isFinite(real) && real > 0) {
    state.duration = real;
    const t = state.current;
    // Container-derived durations can be estimates; trust the decoder instead.
    if (t && Math.abs((t.duration || 0) - real) > 1.2) {
      t.duration = Math.round(real * 10) / 10;
      db.putTracks([t]).catch(() => {});
      lib.events.emit('change');
    }
  }
  events.emit('state');
});

audio.addEventListener('timeupdate', () => {
  state.time = audio.currentTime;
  events.emit('time', state.time);
});

audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => { state.playing = true; events.emit('state'); });
audio.addEventListener('pause', () => { state.playing = false; events.emit('state'); });
audio.addEventListener('waiting', () => { state.loading = true; events.emit('state'); });
audio.addEventListener('playing', () => { state.loading = false; events.emit('state'); });
audio.addEventListener('error', () => {
  state.loading = false;
  if (!state.current) return;
  // The decoder is the authority on what it can decode, so a failure here is
  // what teaches the library that this format is out of reach; the row picks
  // the flag up the next time it renders.
  const err = audio.error;
  if (err && (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
              err.code === MediaError.MEDIA_ERR_DECODE)) {
    state.current.undecodable = true;
  }
  events.emit('error', state.current);
  // next(true) would honour repeat-one and retry the same unreadable file for
  // as long as anyone was willing to watch it.
  skipForward();
});

/** Live playhead. audio's own timeupdate only fires ~4x/second. */
export const currentTime = () => (state.playing ? audio.currentTime : state.time);
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
  });
}

/* ------------------------------------------------------------------ restore */

export async function init() {
  const [vol, shuffle, repeat] = await Promise.all([
    db.getKV('volume').catch(() => null),
    db.getKV('shuffle').catch(() => null),
    db.getKV('repeat').catch(() => null),
  ]);
  if (typeof vol === 'number') state.volume = clamp(vol, 0, 1);
  if (typeof shuffle === 'boolean') state.shuffle = shuffle;
  if (repeat === 'all' || repeat === 'one') state.repeat = repeat;
  applyVolume();
  events.emit('volume');
  events.emit('state');
}

window.addEventListener('pagehide', () => { revoke(currentURL); revoke(preloadURL); });
