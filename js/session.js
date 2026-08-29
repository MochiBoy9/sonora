/* session.js — picking up where you left off.
 *
 * Two jobs, both about the moment the app opens:
 *
 *   reconnect   folders that were linked last time are re-opened without being
 *               asked for again, when the browser still holds the permission
 *   resume      the queue, the track and the playhead come back exactly where
 *               they were, cued and ready
 *
 * Autoplay is not ours to decide. Browsers refuse `play()` without a prior
 * gesture on the origin, so the honest behaviour is: restore everything, try
 * to start, and if the browser says no, say so with one button that starts it.
 * Pretending to have resumed and sitting silent would be worse.
 *
 * An explicit disconnect is remembered and respected: nothing reconnects until
 * the listener turns it back on.
 */

import * as db from './db.js';
import * as lib from './library.js';
import * as player from './player.js';
import { Emitter } from './util.js';

export const events = new Emitter();

const KEY = 'session:v1';
const POS_KEY = 'sonora:playhead';           // the last second, kept synchronously
const PREF_AUTO = 'sonora:autoconnect';      // '0' disables the whole feature
const PREF_OFF = 'sonora:disconnected';      // set by an explicit disconnect
const SAVE_DEBOUNCE = 1500;

export const state = {
  phase: 'idle',        // idle | connecting | ready | resumed | failed | off
  message: '',
  restored: null,       // the record we came back to, if any
  ms: 0,                // how long the reconnect took
};

const pref = (k, fallback = true) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : v !== '0';
  } catch { return fallback; }
};

export const autoConnectEnabled = () => pref(PREF_AUTO, true);
export const isDisconnected = () => {
  try { return localStorage.getItem(PREF_OFF) === '1'; } catch { return false; }
};

function setPhase(phase, message = '') {
  state.phase = phase;
  state.message = message;
  events.emit('phase', state);
}

/* ------------------------------------------------------------------ saving */

let saveTimer = 0;

/** What the next launch needs in order to look like this one. */
function snapshot() {
  const t = player.state.current;
  if (!t) return null;
  return {
    trackId: t.id,
    position: Math.max(0, Math.floor(player.currentTime() || 0)),
    duration: player.state.duration || t.duration || 0,
    // A whole shuffled queue of 40,000 ids is not worth carrying; the head of
    // it is what "where I was" actually means.
    queue: player.state.queue.slice(0, 500),
    index: player.state.index,
    origin: player.state.origin,
    shuffle: player.state.shuffle,
    repeat: player.state.repeat,
    savedAt: Date.now(),
  };
}

function save() {
  const snap = snapshot();
  if (!snap) return;
  db.setKV(KEY, snap).catch(() => {});
}

/**
 * The playhead, mirrored into localStorage.
 *
 * The session itself lives in IndexedDB, which is the right store for it — but
 * IndexedDB is asynchronous, and a write started while the page is being torn
 * down does not land. So the one field that is stale the instant it is written
 * gets a second home in localStorage, which is synchronous and therefore
 * survives `pagehide`. It is two numbers; the cost is nothing and it is the
 * difference between coming back at 0:02 and coming back at 0:00.
 */
function markPlayhead() {
  const t = player.state.current;
  if (!t) return;
  try {
    localStorage.setItem(POS_KEY, `${Math.max(0, Math.floor(player.currentTime() || 0))}|${t.id}`);
  } catch { /* private mode: the IndexedDB snapshot still carries a position */ }
}

/** The mirrored playhead, if it belongs to the track we are restoring. */
function readPlayhead(trackId) {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const cut = raw.indexOf('|');
    if (cut < 0 || raw.slice(cut + 1) !== trackId) return null;
    const at = parseInt(raw.slice(0, cut), 10);
    return isFinite(at) && at >= 0 ? at : null;
  } catch { return null; }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE);
}

/** Starts watching playback so the session is always one debounce out of date. */
export function watch() {
  player.events.on('track', scheduleSave);
  player.events.on('queue', scheduleSave);
  player.events.on('state', scheduleSave);
  // The playhead moves constantly; once every few seconds is enough to make a
  // resume land within a couple of seconds of where you stopped.
  let last = 0;
  let mark = 0;
  player.events.on('time', (t) => {
    if (Math.abs(t - mark) >= 1) { mark = t; markPlayhead(); }
    if (Math.abs(t - last) < 4) return;
    last = t;
    scheduleSave();
  });
  player.events.on('track', markPlayhead);
  addEventListener('pagehide', () => { clearTimeout(saveTimer); markPlayhead(); save(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { markPlayhead(); save(); }
  });
}

export const forget = () => {
  try { localStorage.removeItem(POS_KEY); } catch { /* private mode */ }
  return db.setKV(KEY, null).catch(() => {});
};

/* ------------------------------------------------------------------ restore */

/**
 * Reconnects and resumes. Called once, after the library has painted.
 *
 * @param  {(msg: string, opts?: object) => void} notify  toast
 * @returns {Promise<'resumed'|'ready'|'failed'|'off'|'none'>}
 */
export async function restore(notify) {
  if (!autoConnectEnabled() || isDisconnected()) {
    setPhase('off');
    return 'off';
  }

  const started = performance.now();
  setPhase('connecting', 'Reconnecting');

  const snap = await db.getKV(KEY).catch(() => null);
  if (!snap || !snap.trackId) {
    state.ms = Math.round(performance.now() - started);
    setPhase('ready');
    return 'none';
  }

  // The library is already in memory by now; what may not be is the file. The
  // roots reconnect themselves in the background, so wait briefly for the one
  // file we actually need rather than for the whole scan.
  const track = lib.getTrack(snap.trackId);
  if (!track) {
    state.ms = Math.round(performance.now() - started);
    setPhase('ready');
    return 'none';
  }

  // The debounced snapshot is a second or two behind by construction; the
  // mirrored playhead is not, so it wins whenever it is about the same track.
  const mirrored = readPlayhead(snap.trackId);
  if (mirrored !== null) snap.position = mirrored;

  const available = await waitForFile(snap.trackId, 2500);
  state.restored = snap;
  state.ms = Math.round(performance.now() - started);

  // Rebuild the queue exactly. This happens either way: even when the audio
  // itself is out of reach, the list of what was playing is still true, and
  // having it there is what makes reconnecting a single click instead of a
  // reconstruction.
  const ids = (snap.queue || []).filter((id) => lib.getTrack(id));
  if (ids.length) player.setQueueSilently(ids, Math.max(0, Math.min(snap.index, ids.length - 1)), snap.origin);

  if (!available) {
    // A folder opened through a file input cannot be re-opened by script —
    // the browser hands over files once, on a gesture, and forgets. So say so
    // plainly, and arm the resume to finish itself the moment the folder is
    // back, rather than making the listener do it twice.
    setPhase('failed', 'Folder not connected');
    armResume(snap, notify);
    notify?.(`“${track.title}” is waiting — reconnect its folder to play it`, {
      duration: 5000,
      action: { label: 'Settings', onSelect: () => (location.hash = '#/settings') },
    });
    return 'failed';
  }

  // Cue the track without starting it: `cue` loads and seeks, and returns
  // whether the browser allowed playback.
  const playing = await player.cue(track, snap.position || 0);

  if (playing) {
    setPhase('resumed', 'Resumed');
    return 'resumed';
  }

  setPhase('ready', 'Ready to resume');
  notify?.(`Picked up “${track.title}” where you left off`, {
    duration: 6000,
    action: { label: 'Resume', onSelect: () => player.play() },
  });
  return 'ready';
}

/**
 * Waits for the folder to come back, then finishes the resume on its own.
 *
 * The listener reconnects a folder for their own reasons — to play something
 * else, to add more music — and should not then have to remember what they
 * were listening to an hour ago. One shot: if they start playing something in
 * the meantime, the old session has been answered and this stands down.
 */
function armResume(snap, notify) {
  let done = false;
  const offs = [];
  const stop = () => {
    done = true;
    while (offs.length) offs.pop()();
  };
  const stand = () => { if (!done) stop(); };

  async function check() {
    if (done || !lib.isAvailable(snap.trackId)) return;
    const track = lib.getTrack(snap.trackId);
    if (!track) return stop();
    stop();
    const playing = await player.cue(track, snap.position || 0);
    setPhase(playing ? 'resumed' : 'ready', playing ? 'Resumed' : 'Ready to resume');
    if (!playing) {
      notify?.(`Picked up “${track.title}” where you left off`, {
        duration: 6000,
        action: { label: 'Resume', onSelect: () => player.play() },
      });
    }
  }

  offs.push(lib.events.on('roots', check));
  offs.push(lib.events.on('change', check));
  offs.push(player.events.on('track', stand));
}

/** Polls for the file becoming reachable while background rescans run. */
function waitForFile(id, budgetMs) {
  const deadline = performance.now() + budgetMs;
  return new Promise((resolve) => {
    const attempt = async () => {
      if (lib.isAvailable(id)) return resolve(true);
      if (performance.now() >= deadline) return resolve(false);
      setTimeout(attempt, 180);
    };
    attempt();
  });
}

/* ------------------------------------------------------------------ toggles */

/** Explicit disconnect: stop, forget the session, and stay disconnected. */
export function disconnect() {
  try { localStorage.setItem(PREF_OFF, '1'); } catch { /* private mode */ }
  player.pause();
  forget();
  setPhase('off', 'Disconnected');
}

export function reconnect(notify) {
  try { localStorage.removeItem(PREF_OFF); } catch { /* private mode */ }
  return restore(notify);
}
