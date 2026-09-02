/* keys.js — one table of shortcuts, read by both the hands and the help.
 *
 * There were two lists. A `switch` on a keystroke did the work, and a separate
 * hand-written array drew the `?` overlay, and the README said so plainly:
 * "It is a second list rather than a projection of the key handler — this
 * README claimed otherwise until recently and it was not true." Two lists drift
 * the moment one of them is edited, and this pair had: ⌘Y ran redo in the
 * handler and appeared in neither the overlay nor the documentation.
 *
 * So the table is the truth. `bind()` registers one, the handler dispatches
 * from it and the overlay renders from it, and a shortcut that is not in here
 * does not exist.
 *
 * WHAT A BINDING IS
 *
 *   id      stable, and never displayed — it is the name an override is stored
 *           under, so renaming one silently drops somebody's remapping.
 *   combo   'Space', 'ArrowRight', 'Mod+K', 'Mod+Shift+Z'. `Mod` is ⌘ on a Mac
 *           and Ctrl everywhere else, which is the only difference between the
 *           two that anybody wants to think about. An array offers alternatives:
 *           "?" arrives as itself on some layouts and as Shift+/ on others.
 *   group   the heading it sits under in the overlay.
 *   label   what it does, in the words the overlay will use.
 *   run     what to do. Returns false to decline, and the next match is tried.
 *   active  optional: whether this binding applies at all right now. The stage's
 *           own keys are registered by the stage and are inert while it is shut,
 *           which is what lets them live in the same table as everything else.
 *   note    optional documentation-only row printed beneath — Shift and an
 *           arrow is not a second binding, it is the same one told to go
 *           further, and the overlay should still say so.
 *   passive optional: documented but not dispatched here, for keys the platform
 *           or a component already owns. Escape is the whole of that category.
 *   release optional: what to do when the key comes back up. A binding with one
 *           is a *hold*, which is a different instrument from a toggle — the
 *           mono check exists to be held, because the question it answers is
 *           "what does this sound like folded down", and the answer is only
 *           useful for as long as you are listening to it. `run` is called once
 *           on the way down however long the key is held, never repeatedly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * There is no chord support and no per-route scoping beyond `active`. Both are
 * easy to add and neither is needed by anything here, and a dispatcher with
 * features nothing uses is a dispatcher nobody can read.
 */

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const OVERRIDES = 'sonora:keys';

const bindings = [];
let overrides = read();

function read() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES) || '{}') || {}; } catch { return {}; }
}
function write() {
  try { localStorage.setItem(OVERRIDES, JSON.stringify(overrides)); } catch { /* private */ }
}

/** Registers a binding. Order is priority: the first match wins. */
export function bind(spec) {
  bindings.push(spec);
  return () => {
    const i = bindings.indexOf(spec);
    if (i >= 0) bindings.splice(i, 1);
  };
}

/** Every binding, with its override applied — for the overlay and for remapping. */
export function all() {
  return bindings.map((b) => ({ ...b, combo: comboOf(b), custom: !!overrides[b.id] }));
}

/* The order the overlay reads in, declared rather than inherited from whichever
   module happened to be imported first — the stage registers its two at module
   load, which would otherwise put the visualiser above Playback. A group not
   named here still appears, at the end. */
const GROUP_ORDER = ['Playback', 'Getting around', 'The library', 'Sound', 'In the visualiser'];

export function groups() {
  const out = new Map();
  for (const b of all()) {
    if (b.hidden) continue;
    if (!out.has(b.group)) out.set(b.group, []);
    out.get(b.group).push(b);
  }
  const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  return [...out].sort((a, b) => rank(a[0]) - rank(b[0]));
}

const comboOf = (b) => overrides[b.id] || b.combo;

/** Point a binding at a different combo, or `null` to put it back. */
export function remap(id, combo) {
  if (combo) overrides[id] = combo; else delete overrides[id];
  write();
}
export function resetAll() { overrides = {}; write(); }

/** What else is already on this combo — so a remapping UI can say so.
 *
 * Against what each binding *currently* answers to, not against what it was
 * declared with: once one shortcut has been moved, the combo it was moved to
 * is the one a second remapping would collide with, and the one it vacated is
 * free. Reading `b.combo` here reported the opposite of both. */
export function conflicts(id, combo) {
  return all().filter((b) => b.id !== id && !b.passive &&
    [].concat(comboOf(b)).some((c) => sameCombo(c, combo)));
}

/**
 * The combo a keydown event represents, in this module's own notation.
 *
 * For a remapping UI: the user presses the keys they want and this is what
 * gets stored, so a binding made by pressing keys and one written by hand in
 * `registerKeys` are the same kind of thing.
 */
export function comboFor(e) {
  const key = e.key === ' ' ? 'Space' : e.key;
  // A modifier on its own is somebody still reaching for the other key.
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return null;
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  // Shift is only worth recording where it is not already implied by the
  // character: "?" is Shift and "/" on most layouts, and storing "Shift+?"
  // would be a combo nobody can type.
  if (e.shiftKey && (key.length > 1 || key === key.toLowerCase())) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

/* ------------------------------------------------------------------ parsing */

/*
 * A combo is parsed rather than pattern-matched, so that a remapping stored as
 * a string is exactly as good as one written here by hand.
 *
 * Letters compare case-insensitively and printable keys compare by what the
 * layout produced, which is the difference between a shortcut that works on an
 * AZERTY keyboard and one that does not.
 */
function parse(combo) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  return {
    key,
    mod: mods.includes('mod'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
  };
}

const sameKey = (a, b) => a === b ||
  (a.length === 1 && b.length === 1 && a.toLowerCase() === b.toLowerCase());

function sameCombo(a, b) {
  const x = parse(a), y = parse(b);
  return sameKey(x.key, y.key) && x.mod === y.mod && x.shift === y.shift && x.alt === y.alt;
}

function matches(combo, e) {
  const c = parse(combo);
  const key = e.key === ' ' ? 'Space' : e.key;
  if (!sameKey(c.key, key)) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (c.mod !== mod) return false;
  if (c.alt !== e.altKey) return false;
  /* Shift is only required to be *absent* where the binding says nothing about
     it and the key is one Shift does not change. Demanding it be absent for
     "?" would reject the layouts that need Shift to type a "?" at all. */
  if (c.shift && !e.shiftKey) return false;
  if (!c.shift && e.shiftKey && c.key.length > 1) return false;
  return true;
}

/* ------------------------------------------------------------------ display */

const GLYPH = {
  Mod: MAC ? '⌘' : 'Ctrl',
  Shift: '⇧',
  Alt: MAC ? '⌥' : 'Alt',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Escape: 'Esc',
};

/** A combo as a list of keycap strings, or whatever the binding says instead.
 *  Seek is one binding that reads Shift to decide how far — printing only "→"
 *  for it is accurate and useless, so it may say "← →" and mean it. */
export function caps(combo) {
  const first = [].concat(combo)[0];
  return String(first).split('+').map((p) => {
    const k = p === 'Mod' || p === 'Shift' || p === 'Alt' ? p : p;
    return GLYPH[k] || (k.length === 1 ? k.toUpperCase() : k);
  });
}

/* ----------------------------------------------------------------- dispatch */

/**
 * Runs the first binding that matches. Returns true if one did, so the caller
 * owns the decision to preventDefault — the handler here should not be deciding
 * whether the browser gets to keep a keystroke.
 */
/* Which holds are currently down.
 *
 * Keyed by binding rather than by key, because a hold has to be released by
 * exactly the binding that took it: the modifier state can change between the
 * press and the release (letting go of Shift first is normal), so matching the
 * keyup against the combo would strand a held binding in the down state with
 * no way back. Holding the *binding* means the release always finds its
 * partner. */
const held = new Set();

export function dispatch(e, { typing }) {
  for (const b of bindings) {
    if (b.passive) continue;
    if (typing && !b.allowTyping) continue;
    if (b.active && !b.active()) continue;
    if (![].concat(comboOf(b)).some((c) => matches(c, e))) continue;
    // Auto-repeat is one press, not fifty. A hold that re-ran on every repeat
    // would restart whatever it started, several times a second.
    if (b.release) {
      if (held.has(b)) return b;
      held.add(b);
    }
    if (b.run(e) === false) { held.delete(b); continue; }
    return b;
  }
  return null;
}

/**
 * Ends any hold whose key has come up.
 *
 * Matched on the key itself rather than on the whole combo, for the reason
 * given above `held`: by the time the letter is released the modifiers may
 * already be gone.
 */
export function dispatchUp(e) {
  for (const b of [...held]) {
    const up = e.key === ' ' ? 'Space' : e.key;
    if (![].concat(comboOf(b)).some((c) => sameKey(parse(c).key, up))) continue;
    held.delete(b);
    b.release(e);
  }
}

/** Ends every hold at once — for a blur, where no keyup is ever delivered. */
export function releaseAll() {
  for (const b of [...held]) { held.delete(b); b.release(); }
}
