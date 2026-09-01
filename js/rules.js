/* rules.js — playlists that describe themselves instead of listing themselves.
 *
 * "Favourited, under four minutes, added this year, not heard since March."
 *
 * Every field a rule like that needs was already indexed. Nothing had to be
 * collected, migrated or computed for this — the library has carried play
 * counts, seconds actually heard, favourites, import dates, years, durations,
 * formats, bitrates and now tempo and dynamic range since long before there
 * was any way to ask about them. The only thing missing was a way to say so.
 *
 * A rule set is evaluated live against the in-memory index rather than
 * materialised, so a smart playlist is never stale: favourite a track and it
 * appears, play one and it drops out of "never played" the moment the count
 * changes. On forty thousand tracks that is a few milliseconds — the index is
 * an array of plain objects and every comparator below is a field read.
 *
 * The vocabulary is deliberately small. Every operator here is one somebody
 * would say out loud about music; there is no regular expression, no nesting
 * and no boolean algebra beyond "all of these" or "any of these", because the
 * point is to describe a shelf rather than to write a query.
 */

import * as lib from './library.js';
import * as stats from './stats.js';

/* ------------------------------------------------------------------ fields */

const days = (n) => n * 86400000;

/**
 * What can be asked about, and how each one is read.
 *
 * `get` returns a comparable value; `kind` decides which operators are offered
 * and how the value is edited. Anything whose reading is genuinely unknown —
 * a tempo on a track that has never been played, a dynamic range on one that
 * has not been measured — returns null, and every comparator treats null as
 * "does not match" rather than as zero. A track with no measurement should
 * never be swept up by `dr < 8`.
 */
export const FIELDS = {
  title:    { label: 'Title',        kind: 'text',   get: (t) => t.title },
  artist:   { label: 'Artist',       kind: 'text',   get: (t) => t.artist },
  album:    { label: 'Album',        kind: 'text',   get: (t) => t.album },
  genre:    { label: 'Genre',        kind: 'text',   get: (t) => t.genre },
  format:   { label: 'Format',       kind: 'text',   get: (t) => (t.name || '').split('.').pop().toLowerCase() },

  year:     { label: 'Year',         kind: 'number', get: (t) => t.year || null },
  duration: { label: 'Length',       kind: 'time',   get: (t) => t.duration || null },
  bitrate:  { label: 'Bitrate',      kind: 'number', get: (t) => t.bitrate || null, unit: 'kbps' },
  dr:       { label: 'Dynamic range', kind: 'number', get: (t) => (t.dr > 0 ? t.dr : null), unit: 'dB' },
  bpm:      { label: 'Tempo',        kind: 'number', get: (t) => t.bpm || null, unit: 'BPM' },

  plays:    { label: 'Play count',   kind: 'number', get: (t) => t.playCount || 0 },
  /* Seconds actually heard, not plays. The Analysis page has made this
     argument since 2.2 — a track skipped at four seconds counts the same as
     one played to the end, so a play count rewards indecision — and a rule
     language that offers only the worse of the two numbers would be undoing
     that on purpose. */
  seconds:  { label: 'Time listened', kind: 'time',  get: (t) => stats.forTrack(t.id) || 0 },

  favourite: { label: 'Favourite',   kind: 'flag',   get: (t) => lib.isFavourite(t.id) },
  guessed:   { label: 'Tags guessed', kind: 'flag',  get: (t) => !!(t.guessed && t.guessed.length) },
  edited:    { label: 'Tags corrected', kind: 'flag', get: (t) => lib.isEdited(t) },

  added:    { label: 'Added',        kind: 'date',   get: (t) => t.addedAt || null },
  played:   { label: 'Last played',  kind: 'date',   get: (t) => t.lastPlayed || null },
};

/* ------------------------------------------------------------------ operators */

const norm = (v) => String(v == null ? '' : v).toLowerCase();

export const OPS = {
  is:          { label: 'is',            kinds: ['text'],   test: (a, b) => norm(a) === norm(b) },
  isNot:       { label: 'is not',        kinds: ['text'],   test: (a, b) => norm(a) !== norm(b) },
  contains:    { label: 'contains',      kinds: ['text'],   test: (a, b) => norm(a).includes(norm(b)) },
  notContains: { label: 'excludes',      kinds: ['text'],   test: (a, b) => !norm(a).includes(norm(b)) },

  eq: { label: 'is',           kinds: ['number', 'time'], test: (a, b) => a != null && +a === +b },
  gt: { label: 'is more than', kinds: ['number', 'time'], test: (a, b) => a != null && +a > +b },
  lt: { label: 'is less than', kinds: ['number', 'time'], test: (a, b) => a != null && +a < +b },

  yes: { label: 'yes', kinds: ['flag'], test: (a) => !!a, noValue: true },
  no:  { label: 'no',  kinds: ['flag'], test: (a) => !a,  noValue: true },

  /* Dates are asked about the way people ask about them: not "before this
     timestamp" but "in the last thirty days". The value is a number of days,
     which is the unit anybody would say out loud. */
  inLast:  { label: 'in the last', kinds: ['date'], unit: 'days',
             test: (a, b) => a != null && Date.now() - a <= days(+b) },
  notIn:   { label: 'not in the last', kinds: ['date'], unit: 'days',
             test: (a, b) => a == null || Date.now() - a > days(+b) },
  before:  { label: 'before year', kinds: ['date'],
             test: (a, b) => a != null && new Date(a).getFullYear() < +b },
  never:   { label: 'never', kinds: ['date'], noValue: true, test: (a) => a == null },
};

/** Which operators suit a field. */
export const opsFor = (field) => {
  const kind = FIELDS[field] ? FIELDS[field].kind : 'text';
  return Object.entries(OPS).filter(([, op]) => op.kinds.includes(kind)).map(([id, op]) => ({ id, ...op }));
};

/* ------------------------------------------------------------------ evaluate */

/** Does one track satisfy one rule? */
function matches(track, rule) {
  const field = FIELDS[rule.field];
  const op = OPS[rule.op];
  if (!field || !op) return false;
  return !!op.test(field.get(track), rule.value);
}

/**
 * Every track a rule set describes, in the order it asks for.
 *
 * `match` is 'all' or 'any' and nothing else. Real query languages nest, and
 * every nested query builder ever shipped is a thing people learn once and
 * then avoid — two flat modes cover what anybody actually wants from a shelf.
 */
export function evaluate(set, tracks = lib.allTracks()) {
  const rules = (set && set.rules) || [];
  const all = set.match !== 'any';

  let out = rules.length
    ? tracks.filter((t) => (all ? rules.every((r) => matches(t, r)) : rules.some((r) => matches(t, r))))
    : tracks.slice();

  if (set.sort && set.sort !== 'none') {
    const dir = set.sortDir === -1 ? -1 : 1;
    const field = FIELDS[set.sort];
    if (field) {
      out.sort((a, b) => {
        const x = field.get(a), y = field.get(b);
        // Unknown sorts last whichever way the list is pointing: a track with
        // no reading is not "the smallest", it is absent.
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'string') return dir * x.localeCompare(y);
        return dir * (x - y);
      });
    }
  }

  if (set.limit > 0) out = out.slice(0, set.limit);
  return out;
}

/** A readable one-line summary, for the sidebar and the page header. */
export function describe(set) {
  const rules = (set && set.rules) || [];
  if (!rules.length) return 'Everything';
  const joiner = set.match === 'any' ? ' or ' : ' and ';
  return rules.map((r) => {
    const f = FIELDS[r.field], o = OPS[r.op];
    if (!f || !o) return '?';
    if (o.noValue) return `${f.label.toLowerCase()} ${o.label}`;
    const unit = o.unit || f.unit || '';
    return `${f.label.toLowerCase()} ${o.label} ${r.value}${unit ? ' ' + unit : ''}`;
  }).join(joiner);
}

/** A fresh rule for a field, with a sensible operator and value. */
export function blankRule(field = 'favourite') {
  const ops = opsFor(field);
  const op = ops[0];
  return { field, op: op.id, value: op.noValue ? '' : (FIELDS[field].kind === 'text' ? '' : 0) };
}

/* Handed to the library so `playlistTracks` can resolve a smart playlist
   without importing this module — see the note there for why the ring has to
   be closed at run time rather than at load time. */
lib.useRuleEngine(evaluate);
