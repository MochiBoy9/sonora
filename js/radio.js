/* radio.js — what to play next when nobody has said.
 *
 * E1 and E2. Sonora's playback layer had no "and then?" anywhere in it: the
 * queue ran out and the app went quiet for the rest of the evening. For a
 * player left running on a second screen that is the moment it stops being a
 * player.
 *
 * Two rules shape everything here.
 *
 * It is never automatic. The queue ending offers to keep going and does not
 * keep going — a player that starts playing things you did not choose, on a
 * library that is entirely yours, is a player that has decided it knows
 * better. One button, and silence is a perfectly good answer to it.
 *
 * And it seeds from something you actually did. The seed is the queue's own
 * provenance — the artist page you played, the record you put on, the shelf it
 * came from — which the app has been recording since the "from" tags landed
 * and has never once read back. There is no taste model here, and there is
 * nothing to train: it is the D2 distance plus the weighted shuffle that
 * already exists, pointed at a starting record.
 */

import * as lib from './library.js';
import * as player from './player.js';
import * as similar from './similar.js';

const RUN = 24;              // how many tracks a station hands over at a time

/**
 * What the queue that just ended was, in words, and what to play on from it.
 *
 * Returns `{ label, tracks }` or null when there is nothing sensible to
 * continue — which is a real answer and not a failure. A queue of one track
 * dropped in by hand has no shape to carry on.
 */
export function continuation(origin, played = []) {
  const seed = lib.getTrack(played[played.length - 1]) ||
               lib.getTrack((player.state.queue || [])[player.state.index]);
  const heard = new Set(played);

  if (origin && origin.type === 'artist' && origin.key) {
    const artist = lib.state.artistBy.get(origin.key);
    if (artist) {
      const rest = artist.tracks.filter((t) => !heard.has(t.id));
      if (rest.length) return { label: `more ${artist.name}`, tracks: pick(rest) };
    }
  }

  if (origin && origin.type === 'genre' && origin.key) {
    const g = lib.genreOf(origin.key);
    if (g) {
      const rest = g.tracks.filter((t) => !heard.has(t.id));
      if (rest.length) return { label: `more ${g.label}`, tracks: pick(rest) };
    }
  }

  if (origin && origin.type === 'playlist' && origin.key) {
    const p = lib.state.playlists.find((x) => x.id === origin.key);
    if (p) {
      const rest = lib.playlistTracks(p).filter((t) => !heard.has(t.id));
      if (rest.length) return { label: `the rest of “${p.name}”`, tracks: pick(rest) };
    }
  }

  /* An album that ended, or anything else with a track to reason from: the
     records that measure out nearest it. This is D2 earning its second keep —
     the same four numbers that draw the "Near this one" shelf are what a
     station is made of. */
  const key = (origin && origin.type === 'album' && origin.key) ||
              (seed && seed.albumKey);
  if (key) {
    const near = station(key, heard);
    if (near.length) {
      const al = lib.state.albumBy.get(key);
      return { label: al ? `records near “${al.title}”` : 'records near this one', tracks: near };
    }
  }

  // Nothing to lean on, and the honest fallback is the library — leaning on
  // the weighted shuffle, which at least knows what you have been playing.
  const all = lib.allTracks().filter((t) => !heard.has(t.id));
  if (all.length) return { label: 'something from the shelf', tracks: pick(all) };
  return null;
}

/**
 * E2: a station from one record.
 *
 * The rest of that record first, because a listener who put an album on and
 * heard three tracks of it means the album; then the nearest records by D2's
 * measure, a couple of tracks each rather than whole sides, so a station
 * wanders instead of becoming a queue of albums.
 */
export function station(albumKey, heard = new Set()) {
  const out = [];
  const al = lib.state.albumBy.get(albumKey);
  if (al) for (const t of al.tracks) if (!heard.has(t.id)) out.push(t);

  for (const hit of similar.nearAlbum(albumKey, 8)) {
    const tracks = hit.album.tracks.filter((t) => !heard.has(t.id));
    if (!tracks.length) continue;
    // Two from each: enough to hear what the record is, not so many that one
    // neighbour becomes the whole station.
    for (const t of pick(tracks, 2)) out.push(t);
    if (out.length >= RUN) break;
  }
  return out.slice(0, RUN);
}

/**
 * A run of tracks, ordered the way the shuffle would order them.
 *
 * `player.shuffled` is the weighted shuffle when that mode is on and a plain
 * one otherwise, which means a station inherits whatever the listener has
 * already decided about how random they want their music. Nothing here needed
 * its own opinion.
 */
function pick(tracks, n = RUN) {
  const ids = player.shuffled(tracks.map((t) => t.id));
  const out = [];
  for (const id of ids) {
    const t = lib.getTrack(id);
    if (t) out.push(t);
    if (out.length >= n) break;
  }
  return out;
}
