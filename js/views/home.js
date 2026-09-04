/* views/home.js — the front page: shelves cut from what the library knows. */

import * as rack from '../audio.js';
import * as lib from '../library.js';
import { enter, reveal } from '../motion.js';
import * as stats from '../stats.js';
import { emptyState } from '../ui.js';
import { el, fmtTotal, ico } from '../util.js';
import { albumCard, artistCard, decode, playAll, readout, shelf, shuffleAll, soundBloom } from './shared.js';

/* ------------------------------------------------------------------ HOME */

export function viewHome(host) {
  const frag = document.createDocumentFragment();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const total = lib.trackCount();
  if (!total) {
    host.appendChild(emptyState({
      icon: 'folder',
      title: 'Your library is empty',
      note: 'Point Sonora at a folder of music on this computer. Nothing is uploaded — files are read straight off your disk.',
      action: { label: 'Add music folder', onSelect: () => document.dispatchEvent(new CustomEvent('sonora:add')) },
    }));
    return () => {};
  }

  const all = lib.allTracks();
  const recentTrack = lib.recentTracks()[0];

  const title = el('h1', { class: 'page-title grad-text', text: 'Your library' });
  /* Not named `stats`: this function also reads the listening stats module,
     and an element by that name shadowed the import — `stats.forTrack` then
     resolved to an HTMLElement and threw on every Home render. */
  const countLine = el('p', { class: 'page-sub' });
  const head = el('header', { class: 'home-hero' },
    el('div', { class: 'home-hero-text' },
      el('p', { class: 'eyebrow', text: greeting }),
      title,
      countLine,
      el('div', { class: 'hero-actions' },
        el('button', {
          class: 'btn primary', html: ico('shuffle') + '<span>Shuffle everything</span>',
          onclick: () => shuffleAll(all, { type: 'all', label: 'Your library' }),
        }),
        recentTrack ? el('button', {
          class: 'btn ghost', html: ico('play') + '<span>Resume</span>',
          title: recentTrack.title,
          onclick: () => playAll(lib.recentTracks(), 0, { type: 'recent', label: 'Recently played' }),
        }) : null,
        el('button', {
          class: 'btn ghost', html: ico('expand') + '<span>Visualiser</span>',
          onclick: () => document.dispatchEvent(new CustomEvent('sonora:stage')),
        }))),
    soundBloom());
  frag.appendChild(head);

  // The count rolls up rather than appearing: a readout settling on a value.
  const counted = el('span');
  countLine.append(counted, ' tracks \u00b7 ',
    `${lib.state.albums.length} albums \u00b7 ${lib.state.artists.length} artists \u00b7 ` +
    // The small caps are the `.page-sub` rule's job, not this string's — applied
    // here it survived into `.is-note` prose and shouted one figure of five.
    fmtTotal(all.reduce((n, t) => n + (t.duration || 0), 0)));
  readout(counted, total, { duration: 1100 });
  decode(title, 'Your library', { duration: 700 });

  const recent = lib.recentAlbums(10);
  const shelfRecent = shelf('Jump back in', recent, (a) => albumCard(a));
  if (shelfRecent) frag.appendChild(shelfRecent);

  const added = lib.state.albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 10);
  const shelfAdded = shelf('Recently added', added, (a) => albumCard(a), { seeAll: '#/albums' });
  if (shelfAdded) frag.appendChild(shelfAdded);

  const topArtists = lib.state.artists.slice()
    .sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 10);
  const shelfArtists = shelf('Artists', topArtists, (a) => artistCard(a), { seeAll: '#/artists' });
  if (shelfArtists) frag.appendChild(shelfArtists);

  /* This day, other years.
   *
   * Every play has been stamped since the history existed, and nothing has
   * ever read those stamps for anything but ordering. A shelf of what you were
   * playing a year ago today costs one filter and gives a local library the
   * one thing no streaming service can honestly offer: a memory that belongs
   * to you, computed on your machine, from a log nobody else has a copy of.
   *
   * Only shown when there is genuinely something there. A shelf that says
   * "nothing yet" every day for a year is worse than no shelf. */
  const today = new Date();
  const anniversaries = [];
  const seenAlbums = new Set();
  for (const t of lib.allTracks()) {
    if (!t.lastPlayed) continue;
    const d = new Date(t.lastPlayed);
    if (d.getFullYear() >= today.getFullYear()) continue;      // this year is not a memory
    if (d.getMonth() !== today.getMonth() || d.getDate() !== today.getDate()) continue;
    const al = lib.state.albumBy.get(t.albumKey);
    if (al && !seenAlbums.has(al.key)) { seenAlbums.add(al.key); anniversaries.push(al); }
  }
  const shelfThen = shelf('On this day', anniversaries.slice(0, 10), (a) => albumCard(a));
  if (shelfThen) frag.appendChild(shelfThen);

  /* Records where one track has all the listening.
   *
   * Sonora counts seconds rather than plays, so it can tell the difference
   * between a record you have listened to and a record you own. An album where
   * one track has most of the time and the rest have almost none is a specific
   * and common situation — either you love one song, or you never gave the
   * thing a chance — and it is the most interesting page a local library can
   * show you about itself.
   */
  const lopsided = [];
  for (const al of lib.state.albums) {
    if (!al.tracks || al.tracks.length < 4) continue;
    const secs = al.tracks.map((t) => stats.forTrack(t.id) || 0);
    const total = secs.reduce((s, v) => s + v, 0);
    if (total < 120) continue;                                  // barely touched either way
    const top = Math.max(...secs);
    // Most of the listening in one track, and the rest of the record cold.
    const share = top / total;
    if (share > 0.7) lopsided.push({ album: al, share });
  }
  lopsided.sort((a, b) => b.share - a.share);
  const shelfOne = shelf('You only play one song from these', lopsided.slice(0, 10).map((x) => x.album),
    (a) => albumCard(a));
  if (shelfOne) frag.appendChild(shelfOne);

  /* Records you have never once played.
   *
   * `playCount` has been counted since the first release and nothing had ever
   * asked it this question, which is a shame, because on a large collection it
   * is the most useful one there is: not "what do you like" — every other shelf
   * on this page answers that — but "what is in here that you have never
   * heard". A local library accumulates records the way a shelf accumulates
   * books, and the unplayed ones are invisible precisely because nothing ever
   * surfaces them.
   *
   * Oldest first, so the ones that have been waiting longest come up.
   */
  const untouched = lib.state.albums
    .filter((al) => !al.plays && al.tracks.length)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const shelfNew = shelf('Never played', untouched.slice(0, 10), (a) => albumCard(a));
  if (shelfNew) frag.appendChild(shelfNew);

  /* And records you used to play and have not been back to.
   *
   * The other half of the same idea, and the one that reads as a suggestion
   * rather than as an accusation: something you played enough to mean it and
   * have not touched in a year. A record with two plays a year ago is a record
   * you tried; one with twenty is one you loved and forgot.
   */
  const YEAR = 365 * 24 * 3600 * 1000;
  const lapsed = lib.state.albums
    .filter((al) => al.plays >= 5 && al.lastPlayed && Date.now() - al.lastPlayed > YEAR)
    .sort((a, b) => b.plays - a.plays);
  const shelfBack = shelf('You used to play these', lapsed.slice(0, 10), (a) => albumCard(a));
  if (shelfBack) frag.appendChild(shelfBack);

  /* A3: one thing the day log noticed about you.
   *
   * Placed here, near the bottom, on purpose. It is an aside — the kind of
   * thing a shop owner who knows you says on the way out, not the first thing
   * the page tells you about yourself. One line, never a list: three
   * observations at once stops being an observation and becomes a dossier.
   *
   * The particular line is chosen by the date rather than at random, so it is
   * the same all day and changes tomorrow. A note that reshuffles every time
   * you press Home is a slot machine.
   */
  const seen = stats.habits();
  if (seen.length) {
    const pick = seen[Math.floor(Date.now() / 86400000) % seen.length];
    frag.appendChild(el('section', { class: 'block home-noticed' },
      el('a', { class: 'noticed', href: pick.href },
        el('span', { class: 'noticed-mark', html: ico('sparkle') }),
        el('span', { class: 'noticed-text', text: pick.text }))));
  }

  // A compact "surprise me" strip: random albums, reshuffled on every visit.
  const pool = lib.state.albums.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const shelfRandom = shelf('From the shelf', pool.slice(0, 10), (a) => albumCard(a));
  if (shelfRandom) frag.appendChild(shelfRandom);

  host.appendChild(frag);
  enter([head], { y: 12, z: -60 });

  // Each shelf arrives as it is scrolled to, and its records come up out of
  // depth rather than sliding in from the side. Observers, not a scroll
  // handler: the crossing is computed off the main thread, which is the only
  // version of this that a virtualised list further down the page can afford.
  // Each shelf arrives as one thing rather than as a stagger of cards, and the
  // observer is pointed at the shelf itself. Both follow from
  // `content-visibility: auto`: a skipped subtree has no boxes, so an observer
  // watching the cards inside it would be watching nothing — while the shelf
  // is exactly the element the browser is already deciding about. The cards
  // get their own motion from the rack as you flip through them.
  const offShelves = reveal(host.querySelectorAll('.shelf'), { y: 26, z: -110, rotate: 3, each: 0, duration: 700 });
  return () => offShelves();
}
