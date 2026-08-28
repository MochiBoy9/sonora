/* player.js — playback, queue, and the Web Audio graph.
 *
 * One <audio> element does the decoding; a second, silent one warms the next
 * track's object URL so track changes are instant. Volume runs through a
 * GainNode on a perceptual curve rather than the element's linear property,
 * and an AnalyserNode feeds the visualiser.
 */

import * as lib from './library.js';
import * as db from './db.js';
import { Emitter, clamp } from './util.js';

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
let freqData = null;

function ensureGraph() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    source = ctx.createMediaElementSource(audio);
    gain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    source.connect(gain).connect(analyser).connect(ctx.destination);
    applyVolume();
    return true;
  } catch (err) {
    console.warn('[sonora] Web Audio unavailable', err);
    ctx = null;
    return false;
  }
}

/** Loudness is perceived roughly logarithmically, so square the slider. */
function applyVolume() {
  const v = state.muted ? 0 : state.volume * state.volume;
  if (gain) gain.gain.value = v;
  else audio.volume = state.muted ? 0 : state.volume;
}

/** Normalised spectrum for the visualiser, or null when there's nothing to show. */
export function spectrum() {
  if (!analyser || !state.playing) return null;
  analyser.getByteFrequencyData(freqData);
  return freqData;
}

/* ------------------------------------------------------------------ loading */

function revoke(url) { if (url) URL.revokeObjectURL(url); }

async function load(track, autoplay) {
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
      return next(false);
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
  events.emit('queue');
  warmNext();
}

export function enqueue(tracks) {
  const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
  state.queue.push(...ids);
  if (state.index < 0 && state.queue.length) jumpTo(0);
  else events.emit('queue');
}

export function removeAt(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  else if (i === state.index) {
    state.index--;
    next(true);
  }
  events.emit('queue');
}

export function clearQueue() {
  state.queue = state.queue.slice(0, state.index + 1);
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
  if (state.current) events.emit('error', state.current);
  next(true);
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
