/* similar.js — "records that sound like this one", from numbers already on disk.
 *
 * D2. The analysis worker measures tempo, dynamic range, spectral centroid and
 * the encoder shelf for every track that gets played, and all four were stored
 * and then used for exactly one thing each: a row in a panel. Between them they
 * describe a record well enough to say which four others sit near it, which is
 * a question people ask constantly and Sonora could not answer at all.
 *
 * What this is not: a recommendation engine. There is no lookup, no service, no
 * model and no taste. It is a distance in four dimensions plus two tiebreakers,
 * and it says out loud which of them it is leaning on — "similar tempo and
 * brightness" is a claim you can check, where "you might like" is not.
 *
 * Everything here runs over `lib.state.albums`, which for a large library is a
 * few thousand entries: one pass, no allocation per candidate beyond the score,
 * and a cache keyed by album so opening the same page twice costs nothing.
 */

import * as lib from './library.js';

/* The axes, with the range each one is normalised against.
 *
 * The spans are what actually varies across recorded music rather than what is
 * theoretically possible: tempo lives between about 60 and 180, dynamic range
 * between 4 and 18, and the centroid between 800 Hz and 5 kHz. Dividing by a
 * true full-scale range would make every distance vanishingly small and every
 * record equally near every other, which is the failure mode this table exists
 * to avoid.
 *
 * `weight` is how much each is allowed to matter. Tempo and brightness lead
 * because they are what people mean by "sounds like"; the shelf is in at a
 * quarter weight because it is really a fact about the encoder, and two records
 * ripped by the same person at the same settings are not thereby similar. */
const AXES = [
  { key: 'bpm',      span: 120,  weight: 1,    label: 'tempo' },
  { key: 'centroid', span: 4200, weight: 1,    label: 'brightness' },
  { key: 'dr',       span: 14,   weight: 0.8,  label: 'dynamics' },
  { key: 'shelfHz',  span: 12000, weight: 0.25, label: 'the way it was cut' },
];

/** Averages an album's measured tracks onto one point. Null where nothing was. */
export function profileOf(album) {
  if (!album || !album.tracks || !album.tracks.length) return null;
  const out = { n: 0 };
  let axes = 0;
  for (const { key } of AXES) {
    let sum = 0, n = 0;
    for (const t of album.tracks) {
      const v = t[key];
      if (v > 0) { sum += v; n++; }
    }
    if (n) { out[key] = sum / n; axes++; }
  }
  // One axis is not a profile: it would put every unmeasured record next to
  // every other on the strength of a single number they happen to share.
  if (axes < 2) return null;
  out.n = axes;
  return out;
}

/**
 * How near two profiles are, 0..1, plus which axes carried the verdict.
 *
 * Only the axes both records actually have are compared, and the total weight
 * is divided by what was used — otherwise a record measured on two axes is
 * penalised for the two it is missing, which is a fact about how much it has
 * been played rather than about how it sounds.
 */
function nearness(a, b) {
  let total = 0, used = 0;
  const agreed = [];
  for (const { key, span, weight, label } of AXES) {
    if (!(a[key] > 0) || !(b[key] > 0)) continue;
    const d = Math.min(1, Math.abs(a[key] - b[key]) / span);
    total += (1 - d) * weight;
    used += weight;
    if (d < 0.12) agreed.push(label);
  }
  if (!used) return null;
  return { score: total / used, agreed };
}

/* Cached per album key and thrown away whenever the library changes, which is
   also whenever a track finishes being analysed — so a shelf that was thin
   this morning fills in as the record gets played. */
let cache = new Map();
lib.events.on('change', () => { cache = new Map(); });

/**
 * The albums nearest this one.
 *
 * Same-artist records are held out. They are near by construction and the shelf
 * would be four more albums by the band whose page you are already on, which is
 * the one answer the listener did not need.
 */
export function nearAlbum(key, limit = 6) {
  const hit = cache.get(key);
  if (hit) return hit.slice(0, limit);

  const album = lib.state.albumBy.get(key);
  const mine = profileOf(album);
  if (!mine) { cache.set(key, []); return []; }

  const out = [];
  for (const other of lib.state.albums) {
    if (other.key === key) continue;
    if (other.artistKey && other.artistKey === album.artistKey) continue;
    const theirs = profileOf(other);
    if (!theirs) continue;
    const near = nearness(mine, theirs);
    if (!near || near.score < 0.72) continue;

    /* Two nudges rather than two axes, because neither is a sound.
       A shared genre is a claim somebody's tagger made, and a decade is a
       proxy for production style — both are worth a thumb on the scale and
       neither should be able to put an unrelated record at the top. */
    let score = near.score;
    if (sharesGenre(album, other)) score += 0.04;
    if (album.year && other.year && Math.abs(album.year - other.year) <= 10) score += 0.02;
    out.push({ album: other, score, agreed: near.agreed });
  }

  out.sort((x, y) => y.score - x.score);
  const top = out.slice(0, 12);
  cache.set(key, top);
  return top.slice(0, limit);
}

function sharesGenre(a, b) {
  const mine = new Set(a.tracks.map((t) => (t.genre || '').toLowerCase()).filter(Boolean));
  if (!mine.size) return false;
  return b.tracks.some((t) => mine.has((t.genre || '').toLowerCase()));
}

/** The printed reason, in the terms the axes are named in. */
export function reasonFor(hit) {
  const list = hit && hit.agreed ? hit.agreed : [];
  if (!list.length) return 'measures out nearby';
  if (list.length === 1) return 'similar ' + list[0];
  return 'similar ' + list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}
