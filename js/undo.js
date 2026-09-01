/* undo.js — a way back from everything the library lets you change.
 *
 * Sonora never writes to your files, and that is exactly what makes undo
 * tractable here. Every mutation this stack covers is an overlay in Sonora's
 * own index — a tag correction, a playlist, a favourite, a piece of artwork
 * you dropped on an album — so the inverse of an operation is always a write
 * to the same index, never a write to a file that might have moved, changed
 * or gone read-only underneath us. There is no case where undo can half-apply
 * against the disk, because it never touches the disk.
 *
 * The design is a stack of closures rather than a log of diffs. Each entry
 * carries `undo` and `redo` as functions the recording site wrote, at the
 * moment it had the before and after values in hand. That is more memory than
 * a diff and much less cleverness: no replay engine, no operation registry, no
 * chance of an inverse being derived wrongly six months from now by somebody
 * adding a field to `editTracks` and not noticing there was a second place
 * that had to learn about it.
 *
 *
 * On staleness
 *
 * An entry can outlive the thing it describes: correct a track, then remove
 * the folder it came from, and the correction has nothing left to apply to.
 * Rather than pretend, every inverse returns how many things it actually
 * touched, and an inverse that touches nothing reports that instead of a
 * cheerful "Undone". A stack that lies about what it did is worse than no
 * stack, because it teaches you to stop reading the confirmation.
 */

import { Emitter } from './util.js';

export const events = new Emitter();

const LIMIT = 60;

const past = [];
const future = [];

/* Set while an inverse is running. Every mutator in library.js pushes onto
   this stack, including the ones an inverse calls — so without this, undoing
   an edit would record the undo as a new undoable edit and the stack would
   never drain. The alternative is a private "quiet" variant of each mutator,
   which is the same flag with more surface area. */
let running = false;

export const isRunning = () => running;

/**
 * Records something that can be taken back.
 *
 * `label` is written from the user's side and reads after the word "Undo" —
 * "the rename", "3 corrections" — because that is the only place it is shown.
 */
export function push(entry) {
  if (running) return;
  if (!entry || typeof entry.undo !== 'function') return;
  past.push(entry);
  if (past.length > LIMIT) past.shift();
  // Anything that was undone and then built on top of is unreachable now.
  future.length = 0;
  events.emit('change');
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export const nextUndo = () => (past.length ? past[past.length - 1].label : null);
export const nextRedo = () => (future.length ? future[future.length - 1].label : null);

/** Empties both stacks. Used when the library underneath them is rebuilt. */
export function clear() {
  past.length = 0;
  future.length = 0;
  events.emit('change');
}

async function run(from, to, key) {
  if (running || !from.length) return null;
  const entry = from.pop();
  running = true;
  let touched;
  try {
    touched = await entry[key]();
  } catch (err) {
    // A failed inverse is not put back on the stack: whatever went wrong will
    // go wrong again, and an entry that cannot be applied is just a trap.
    running = false;
    events.emit('change');
    return { label: entry.label, touched: 0, error: err };
  }
  running = false;
  to.push(entry);
  events.emit('change');
  return { label: entry.label, touched: touched === undefined ? 1 : touched };
}

/** Takes back the most recent change. Resolves to what happened, or null. */
export const undo = () => run(past, future, 'undo');

/** Puts back the most recently undone change. */
export const redo = () => run(future, past, 'redo');
