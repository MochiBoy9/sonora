/* views/album.js — one record: the sleeve, its back, its gatefold, its
 * artwork, the rack bound to it, and what the analysis measured. */

import * as rack from '../audio.js';
import * as lib from '../library.js';
import * as looks from '../looks.js';
import { enter, tilt3d } from '../motion.js';
import * as player from '../player.js';
import { dialog, lightbox, menu, paintArt, playFab, sectionHead, sleeve, toast, trackMenu, trackRowFactory } from '../ui.js';
import { el, fmtBytes, fmtCount, fmtTime, fmtTotal, formatName, ico } from '../util.js';
import { albumOf, decode, markTransition, notFound, playAll, shelf, shuffleAll } from './shared.js';

/* ------------------------------------------------------------------ ALBUM */

export function viewAlbum(host, key) {
  const album = albumOf(key);
  if (!album) return notFound(host, 'Album not found');

  const origin = { type: 'album', key, label: album.title };
  const hero = el('header', { class: 'hero hero-show' });
  // The album page is the one place worth putting the record on a stand: it is
  // a page about a single object, so the object gets a floor, an edge and a
  // reflection, and it turns to follow the pointer.
  const art = sleeve(key, 'hero-art', { reflect: true, back: backCover(album), record: true });
  const meta = el('div', { class: 'hero-meta' },
    el('p', { class: 'eyebrow', text: 'Album' }),
    el('h1', { class: 'hero-title', text: album.title }),
    el('p', { class: 'hero-sub' },
      el('a', { class: 'hero-link', href: '#/artist/' + album.artistKey, text: album.artist }),
      /* One unit, so a narrow hero breaks after the artist rather than
         between a fact and the separator that belongs to it. */
      el('span', { class: 'hero-facts' },
        el('span', { class: 'dot' }),
        album.year ? el('span', { text: String(album.year) }) : null,
        album.year ? el('span', { class: 'dot' }) : null,
        el('span', { text: fmtCount(album.tracks.length, 'track') }),
        el('span', { class: 'dot' }),
        el('span', { text: fmtTotal(album.duration) }))));

  const actions = el('div', { class: 'hero-actions' },
    playFab(() => playAll(album.tracks, 0, origin)),
    el('button', { class: 'btn ghost', html: ico('shuffle') + '<span>Shuffle</span>', onclick: () => shuffleAll(album.tracks, origin) }),
    el('button', { class: 'icon-btn', html: ico('queue'), title: 'Add to queue', onclick: () => { player.enqueue(album.tracks); toast('Added to queue'); } }),
    el('button', { class: 'icon-btn', html: ico('more'), title: 'More',
      onclick: (e) => menu(coverMenu(key, album).concat(trackMenu(album.tracks, { origin })), { anchor: e.currentTarget }) }));
  meta.appendChild(actions);

  hero.append(art, meta);
  host.appendChild(hero);
  applyHeroTint(hero, key);
  decode(hero.querySelector('.hero-title'), album.title, { duration: 620 });
  markTransition(art.querySelector('.sleeve'));
  const untilt = tilt3d(art.querySelector('.sleeve'), { max: 11, lift: 30, scale: 1.012 });

  /* Turning the record over.
   *
   * A real button rather than a click on the artwork: the sleeve is 232px of
   * inviting target that people will click expecting it to play, and a page
   * whose largest element does something unguessable is a page that has
   * traded discoverability for a trick. The button says what it does, takes
   * focus, and answers Enter and Space for free. */
  const flip = art.querySelector('.sleeve');
  const gate = isGatefold(album);
  const flipBtn = el('button', {
    class: 'flip-btn', 'aria-pressed': 'false',
    title: gate ? 'Open the gatefold' : 'Turn the sleeve over',
    'aria-label': gate ? 'Open the gatefold' : 'Show the back of the sleeve',
    html: ico('refresh') + `<span>${gate ? 'Open' : 'Back'}</span>`,
    onclick: () => {
      const on = !flip.classList.contains('is-flipped');
      flip.classList.toggle('is-flipped', on);
      flipBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      flipBtn.setAttribute('aria-label', on ? 'Show the front of the sleeve' : 'Show the back of the sleeve');
      flipBtn.querySelector('span').textContent = on
        ? (gate ? 'Close' : 'Front')
        : (gate ? 'Open' : 'Back');
      // A gatefold opens rather than turning over, so the hero widens to make
      // room for the spread and puts itself back when it closes.
      hero.classList.toggle('is-open', gate && on);
      // The back is real content, not decoration, so it stops being hidden
      // from a screen reader the moment it is the side facing out.
      art.querySelector('.sleeve-back').setAttribute('aria-hidden', on ? 'false' : 'true');
    },
  });
  art.appendChild(flipBtn);

  /* R6: a button to look at the picture, beside the one that turns it over.
   *
   * A button rather than a click on the sleeve, for the same reason the flip
   * is a button: the largest element on the page doing something unguessable
   * is a page that has traded discoverability for a trick — and the sleeve
   * already tilts, turns and accepts a dropped cover. */
  const zoomBtn = el('button', {
    class: 'flip-btn zoom-btn', title: 'Look at the cover',
    'aria-label': 'Look at the cover, full size',
    html: ico('expand') + '<span>Look</span>',
    onclick: () => lightbox(key, { title: album.title, artist: album.artist }),
  });
  art.appendChild(zoomBtn);

  /* T2: dynamic range where you are looking at one record.
   *
   * DR is a column in the Songs table and a row in the back cover's spec
   * block — which is the block that gives way when the card runs out of room —
   * and on the album page itself it was nowhere. It costs no new analysis:
   * every figure here is already on the track.
   *
   * Honest about coverage: a figure is only ever known for a track that has
   * actually been listened to, so "DR11 · 4 of 9 measured" is a partial
   * reading said out loud, and a bare "DR11" over nine tracks would be a
   * claim about five of them nobody has made. */
  const columns = isGatefold(album) || album.tracks.some((t) => t.dr > 0)
    ? ['index', 'title', 'dr', 'duration']
    : ['index', 'title', 'duration'];
  const oneArtist = album.tracks.every((t) => t.artist === album.artist);
  const list = el('div', { class: 'plain-list' + (oneArtist ? ' no-sub' : '') });
  const factory = trackRowFactory({
    columns,
    onPlay: (i) => playAll(album.tracks, i, origin),
    onMenu: (i, anchor, event) => menu(trackMenu([album.tracks[i]], { origin }), { anchor, event }),
  });

  // Asked once, not once per track: `some` inside the loop made this quadratic.
  const multiDisc = album.tracks.some((t) => t.disc > 1);
  let discNo = 0;
  album.tracks.forEach((t, i) => {
    if (multiDisc && t.disc !== discNo) {
      discNo = t.disc;
      list.appendChild(el('div', { class: 'disc-head', text: `Disc ${discNo}` }));
    }
    const row = factory.create();
    row.dataset.index = i;
    row.classList.add('static-row');
    factory.render(row, t, i);
    list.appendChild(row);
  });

  host.appendChild(list);

  /* T3: what the analysis found, where the record is.
   *
   * Tempo with a confidence figure, spectral centroid, and the encoder shelf
   * that catches a lossless container made from a lossy source — all of it
   * measured on first listen, all of it kept, and the only door to any of it
   * was the artist overview. This is a panel about *this* record, which is
   * where somebody who has just noticed something wants to look.
   *
   * Everything here is read from the tracks; nothing is decoded to draw it.
   * Where nothing has been measured the panel does not appear, because an
   * empty analysis panel teaches somebody that the feature is broken. */
  const analysis = analysisPanel(album);
  if (analysis) host.appendChild(analysis);

  enter([hero], { y: 16, z: -90, wipe: true });
  enter(list.children, { each: 13, y: 8, delay: 80 });

  const refresh = () => {
    for (const row of list.children) {
      const i = parseInt(row.dataset.index, 10);
      if (!isNaN(i)) factory.render(row, album.tracks[i], i);
    }
    // The record comes out of the sleeve for this album and no other, and it
    // stops turning rather than disappearing when playback pauses — which is
    // what a paused turntable looks like.
    const mine = player.state.current && player.state.current.albumKey === key;
    flip.classList.toggle('is-playing', !!mine);
    flip.classList.toggle('is-paused', !!mine && !player.state.playing);
  };
  refresh();
  const off = player.events.on('track', refresh);
  const offState = player.events.on('state', refresh);
  const undrop = acceptCover(art, key);
  const offArt = lib.events.on('art', (keys) => {
    if (keys && !keys.includes(key)) return;
    /* Everything the cover feeds, repainted from one event: the face, the
       reflection standing on the floor beneath it, and the page tint — which
       is read off the accent colour the new picture was sampled for. */
    const img = art.querySelector('.art-img');
    if (img) { img.dataset.key = ''; paintArt(img, key); }
    const echo = art.querySelector('.art-echo-img');
    // Through loadArt rather than off the face's src: reverting to the
    // original empties the cache, so the face is still waiting at this point.
    if (echo) {
      lib.loadArt(key).then((url) => {
        if (url) echo.setAttribute('src', url); else echo.removeAttribute('src');
      });
    }
    applyHeroTint(hero, key);
  });
  return () => { off(); offState(); untilt(); undrop(); offArt(); };
}

/* ---------------------------------------------------------------- covers
 *
 * Some albums arrive with no picture, and some arrive with the wrong one —
 * a scan of a CD-R, a placeholder from a rip, the same generic square across
 * forty bootlegs. Sonora will not write to the files, so the fix is the same
 * shape as a tag correction: your picture goes into Sonora's index, the
 * album's own cover stays where it was, and "use the original" is one click.
 *
 * Three ways in, because the right one depends on where the picture is:
 * dropped from a folder, pasted from wherever you just copied it, or picked
 * through the file dialog when neither of those is convenient.
 */

function coverMenu(key, album) {
  const bound = rack.bindingOf('album', key);
  const choose = async (file) => {
    if (!file) return;
    toast('Fitting the cover…');
    const ok = await lib.setArtwork(key, file);
    toast(ok ? `New cover for “${album.title}”` : 'That file could not be read as a picture');
  };
  return [
    {
      label: 'Choose a cover…', icon: 'image', hint: 'or drop one on the sleeve',
      onSelect: () => {
        /* An <input type=file> rather than showOpenFilePicker: this one needs
           no handle afterwards, works in every browser, and does not have to
           be reconnected on the next launch the way a music folder does. */
        const pick = el('input', { type: 'file', accept: 'image/*' });
        pick.style.display = 'none';
        pick.addEventListener('change', () => { choose(pick.files[0]); pick.remove(); });
        document.body.appendChild(pick);
        pick.click();
      },
    },
    lib.hasOwnArt(key) ? {
      label: 'Use the original cover', icon: 'refresh',
      onSelect: async () => {
        await lib.clearArtwork(key);
        toast(`“${album.title}” is back to its own cover`);
      },
    } : null,
    {
      label: 'Rack for this album…', icon: 'sliders',
      hint: bound || '',
      onSelect: () => rackPicker('album', key, album.title),
    },
    { separator: true },
  ].filter(Boolean);
}

/**
 * Picks the rack a record should arrive with.
 *
 * A dialog rather than a submenu because the list is long — eleven presets
 * plus however many racks you have saved — and because the row that matters
 * most is the one at the top saying there is no rack, which a submenu buries.
 */
async function rackPicker(scope, key, label) {
  const current = rack.bindingOf(scope, key);
  const saved = await rack.savedRacks();
  const list = el('div', { class: 'rack-pick' });

  const row = (id, name, note) => {
    const on = (id || null) === (current || null);
    return el('button', {
      class: 'rack-pick-row' + (on ? ' is-on' : ''),
      onclick: async () => {
        await rack.bindTo(scope, key, id);
        closeDialog();
        /* Takes effect on the next track that asks for it. Saying so is the
           honest thing: the change is real but you will not hear it until the
           record comes round, and silence here reads as a control that did
           nothing. */
        const now = player.state.current;
        const mine = now && (scope === 'album' ? now.albumKey : now.artistKey) === key;
        if (mine) await rack.followTrack(now);
        toast(id
          ? (mine ? `“${label}” is on the ${name} rack` : `“${label}” will arrive on the ${name} rack`)
          : `“${label}” goes back to your rack`);
      },
    },
      el('span', { class: 'rack-pick-name', text: name }),
      note ? el('span', { class: 'rack-pick-note', text: note }) : null,
      el('span', { class: 'rack-pick-mark', html: on ? ico('star-fill') : '' }));
  };

  list.appendChild(row(null, 'Your rack', 'whatever the Sound page says'));
  if (saved.length) {
    list.appendChild(el('p', { class: 'rack-pick-head', text: 'Saved' }));
    for (const r of saved) list.appendChild(row(r.name, r.name));
  }
  list.appendChild(el('p', { class: 'rack-pick-head', text: 'Presets' }));
  for (const p of rack.PRESETS) list.appendChild(row(p.id, p.label));

  let closeDialog = () => {};
  const d = dialog({
    title: 'A rack for this record',
    body: el('div', {},
      el('p', { class: 'dialog-note', text:
        `Sonora puts this chain in circuit whenever ${scope === 'album' ? 'this album' : 'this artist'} plays, ` +
        'and takes it out again afterwards. Your own rack is never overwritten.' }),
      list),
    width: 460,
    actions: [{ label: 'Done' }],
  });
  closeDialog = () => d.close();
}

/**
 * Lets an album's sleeve take a picture by drag or by paste.
 *
 * The paste listener is on the document rather than the sleeve because a
 * sleeve cannot hold focus and ⌘V has to work the moment the page is open;
 * it is filtered on the clipboard actually carrying an image, so pasting
 * text into the search box while an album page is behind it does nothing.
 */
function acceptCover(art, key) {
  const album = albumOf(key);
  let depth = 0;                 // dragenter/dragleave fire per child element

  const take = async (file) => {
    art.classList.remove('is-dropping');
    if (!file) return;
    art.classList.add('is-fitting');
    const ok = await lib.setArtwork(key, file);
    art.classList.remove('is-fitting');
    toast(ok ? `New cover for “${album ? album.title : 'the album'}”`
             : 'That file could not be read as a picture');
  };

  const hasImage = (dt) => !!dt && [...(dt.items || [])].some((i) => i.kind === 'file' && /^image\//.test(i.type));

  const onEnter = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    art.classList.add('is-dropping');
  };
  const onOver = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = () => { if (--depth <= 0) { depth = 0; art.classList.remove('is-dropping'); } };
  const onDrop = (e) => {
    if (!hasImage(e.dataTransfer)) return;
    /* Stopped here, not just prevented: the window-level handler treats a drop
       as "add this music to the library", and an image dropped on a sleeve is
       a different instruction that happens to use the same gesture. */
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    take([...e.dataTransfer.files].find((f) => /^image\//.test(f.type)));
  };
  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!img) return;
    e.preventDefault();
    take(img.getAsFile());
  };

  art.addEventListener('dragenter', onEnter);
  art.addEventListener('dragover', onOver);
  art.addEventListener('dragleave', onLeave);
  art.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);

  return () => {
    art.removeEventListener('dragenter', onEnter);
    art.removeEventListener('dragover', onOver);
    art.removeEventListener('dragleave', onLeave);
    art.removeEventListener('drop', onDrop);
    document.removeEventListener('paste', onPaste);
  };
}

/* ------------------------------------------------------------------ back cover */

/**
 * The back of the sleeve: the tracklist as it is printed on a record, and
 * under it the spec block for what the files actually are.
 *
 * Everything here was already in the index. The tag reader worked the
 * technical fields out on its way to the duration and the worker now keeps
 * them, so this is a printing job rather than a parsing one.
 *
 * A library imported before those fields existed simply has fewer rows — the
 * block prints what is known and says nothing about what is not, which is the
 * only honest thing to do with a record that predates the question.
 */
/* R7: a gatefold.
 *
 * Thickness already follows track count, a multi-disc release already draws as
 * more than one sleeve, and the back already turns — a double album that opens
 * is the obvious next member of that family and the most characteristic object
 * in the whole subject.
 *
 * The inner spread is two panels on one hinge: the tracklist runs across both,
 * broken at the disc, which is exactly how a real gatefold sets it. It appears
 * in place of the plain back cover, so a record has either one or the other
 * and never both — the back of a gatefold sleeve is its own outer panel, and
 * that is what the single-sleeve back already is.
 */
/** T2 and T3: what has been measured about this record, or null. */
function analysisPanel(album) {
  const drs = album.tracks.filter((t) => t.dr > 0);
  const bpms = album.tracks.filter((t) => t.bpm > 0 && (t.bpmConfidence || 0) >= 0.4);
  const cents = album.tracks.filter((t) => t.centroid > 0);
  const suspect = album.tracks.filter((t) => t.truncated === true);
  const shelves = album.tracks.filter((t) => t.shelfHz > 0);
  if (!drs.length && !bpms.length && !cents.length) return null;

  const mean = (list, get) => list.reduce((n, t) => n + get(t), 0) / list.length;
  const n = album.tracks.length;
  const facts = [];

  if (drs.length) {
    const avg = mean(drs, (t) => t.dr);
    const lo = Math.min(...drs.map((t) => t.dr));
    const hi = Math.max(...drs.map((t) => t.dr));
    facts.push({
      label: 'Dynamic range',
      value: 'DR' + avg.toFixed(1),
      note: (lo === hi ? '' : `${lo.toFixed(0)} to ${hi.toFixed(0)} across the record · `) +
        (drs.length < n ? `${drs.length} of ${n} measured` : 'every track measured'),
      /* The number people argue about, so it says what it means rather than
         leaving somebody to guess whether more is better. */
      hint: 'Peak against average level, in decibels. Above about 12 is a record that breathes; below 8 has been squashed in mastering.',
    });
  }

  if (bpms.length) {
    const avg = mean(bpms, (t) => t.bpm);
    const spread = Math.max(...bpms.map((t) => t.bpm)) - Math.min(...bpms.map((t) => t.bpm));
    facts.push({
      label: 'Tempo',
      value: Math.round(avg) + ' bpm',
      note: (spread > 8 ? `${Math.round(spread)} bpm apart at the extremes · ` : 'consistent across the record · ') +
        `${bpms.length} of ${n} confident`,
      hint: 'Only tracks the analysis was sure about are counted. An unsure reading is left out rather than averaged in.',
    });
  }

  if (cents.length) {
    const avg = mean(cents, (t) => t.centroid);
    facts.push({
      label: 'Brightness',
      value: (avg / 1000).toFixed(1) + ' kHz',
      note: `spectral centroid · ${cents.length} of ${n} measured`,
      hint: 'Where the weight of the sound sits. A dark record is around 1 kHz; anything above 4 is bright, and above 6 is usually a mastering choice.',
    });
  }

  if (suspect.length) {
    const hz = shelves.length ? Math.round(mean(shelves, (t) => t.shelfHz) / 100) / 10 : 0;
    facts.push({
      label: 'Encoder shelf',
      value: hz ? hz.toFixed(1) + ' kHz' : 'found',
      note: `${suspect.length} of ${n} look like transcodes`,
      warn: true,
      hint: 'A lossless container with nothing above a sharp cut-off — the signature of a file that was lossy before it was made lossless.',
    });
  }

  const grid = el('div', { class: 'analysis-grid' });
  for (const f of facts) {
    grid.appendChild(el('div', { class: 'analysis-cell' + (f.warn ? ' is-warn' : ''), title: f.hint },
      el('div', { class: 'analysis-label', text: f.label }),
      el('div', { class: 'analysis-value', text: f.value }),
      el('div', { class: 'analysis-note', text: f.note })));
  }

  return el('section', { class: 'block analysis' },
    sectionHead('What this record measures'),
    grid,
    el('p', { class: 'analysis-foot muted',
      text: 'Measured on first listen and kept. Tracks you have not played yet are not counted.' }));
}

function isGatefold(album) {
  return new Set(album.tracks.map((t) => t.disc || 1)).size > 1;
}

function gatefold(album) {
  const spread = el('div', { class: 'sleeve-back is-gate', 'aria-hidden': 'true' });
  const discs = [...new Set(album.tracks.map((t) => t.disc || 1))].sort((a, b) => a - b);

  const left = el('div', { class: 'gate-panel gate-left' });
  const right = el('div', { class: 'gate-panel gate-right' });

  left.appendChild(el('div', { class: 'back-head' },
    el('span', { class: 'back-artist', text: album.compilation ? 'Various Artists' : album.artist }),
    el('span', { class: 'back-title', text: album.title })));

  /* Split by disc rather than by track count: a gatefold that put side one's
     last two tracks on the right-hand page would be a gatefold nobody has ever
     seen. With more than two discs the break is at the halfway disc, which is
     what a triple in a gatefold does. */
  const half = Math.ceil(discs.length / 2);
  const leftDiscs = new Set(discs.slice(0, half));

  const listFor = (which) => {
    const list = el('ol', { class: 'back-list gate-list' });
    let printed = 0;
    for (const t of album.tracks) {
      const d = t.disc || 1;
      if (leftDiscs.has(d) !== which) continue;
      if (d !== printed) {
        printed = d;
        list.appendChild(el('li', { class: 'back-disc' },
          el('span', { class: 'back-t', text: 'Disc ' + d })));
      }
      list.appendChild(el('li', {},
        el('span', { class: 'back-n', text: String(t.track || '') }),
        el('span', { class: 'back-t', text: t.title }),
        el('span', { class: 'back-d', text: t.duration ? fmtTime(t.duration) : '' })));
    }
    return list;
  };

  left.appendChild(listFor(true));
  right.appendChild(listFor(false));

  // The catalogue number sits at the foot of the right-hand page, where a
  // pressing plant puts it.
  right.appendChild(el('div', { class: 'back-cat' },
    el('span', { text: 'SNR-' + String(album.key).toUpperCase() }),
    album.year ? el('span', { text: String(album.year) }) : null));

  spread.append(left, right);
  return spread;
}

export function backCover(album) {
  if (isGatefold(album)) return gatefold(album);
  const back = el('div', { class: 'sleeve-back', 'aria-hidden': 'true' });

  back.appendChild(el('div', { class: 'back-head' },
    el('span', { class: 'back-artist', text: album.compilation ? 'Various Artists' : album.artist }),
    el('span', { class: 'back-title', text: album.title })));

  /* R8: a set is printed as a set.
   *
   * A multi-disc release already draws as more than one sleeve on the shelf
   * and already gets disc headings in the page's own tracklist, and then the
   * back cover flattened it into one numbered run where track 1 appeared
   * twice. Real sleeves put a rule and a side. */
  const discs = [...new Set(album.tracks.map((t) => t.disc || 1))].sort((a, b) => a - b);
  const list = el('ol', { class: 'back-list' });
  let printed = 0;
  for (const t of album.tracks) {
    if (discs.length > 1 && (t.disc || 1) !== printed) {
      printed = t.disc || 1;
      list.appendChild(el('li', { class: 'back-disc' },
        el('span', { class: 'back-t', text: 'Disc ' + printed })));
    }
    list.appendChild(el('li', {},
      el('span', { class: 'back-n', text: String(t.track || '') }),
      el('span', { class: 'back-t', text: t.title }),
      el('span', { class: 'back-d', text: t.duration ? fmtTime(t.duration) : '' })));
  }
  back.appendChild(list);

  /* One line per fact, and only for facts. A mixed-format album says so rather
     than picking whichever file happened to be first. */
  const uniq = (fn) => [...new Set(album.tracks.map(fn).filter(Boolean))];
  const formats = uniq((t) => formatName(t.name || ''));
  const rates = uniq((t) => t.sampleRate);
  const depths = uniq((t) => t.bitDepth);
  const chans = uniq((t) => t.channels);
  const rateOf = (n) => (n % 1000 === 0 ? n / 1000 + ' kHz' : (n / 1000).toFixed(1) + ' kHz');
  const bitrates = album.tracks.map((t) => t.bitrate).filter((n) => n > 0);
  const avg = bitrates.length ? Math.round(bitrates.reduce((a, b) => a + b, 0) / bitrates.length) : 0;
  const bytes = album.tracks.reduce((n, t) => n + (t.size || 0), 0);

  const spec = el('dl', { class: 'back-spec' });
  const row = (k, v) => { if (v) { spec.appendChild(el('dt', { text: k })); spec.appendChild(el('dd', { text: v })); } };
  row('Format', formats.join(' · '));
  row('Rate', rates.length ? rates.sort((a, b) => a - b).map(rateOf).join(' · ') : '');
  row('Depth', depths.length ? depths.sort((a, b) => a - b).map((d) => d + '-bit').join(' · ') : '');
  row('Channels', chans.length ? chans.map((c) => (c === 1 ? 'Mono' : c === 2 ? 'Stereo' : c + ' ch')).join(' · ') : '');
  row('Bitrate', avg ? '~' + avg + ' kbps' : '');
  // Only the tracks that have actually been listened to have a figure, so the
  // count comes with it: "DR11 · 4 of 9" is a partial reading, and saying so is
  // the difference between a measurement and a claim.
  const drs = album.tracks.map((t) => t.dr).filter((n) => n > 0);
  row('Dynamic range', drs.length
    ? 'DR' + Math.round(drs.reduce((a, b) => a + b, 0) / drs.length) +
      (drs.length < album.tracks.length ? ` · ${drs.length} of ${album.tracks.length}` : '')
    : '');
  row('Discs', discs.length > 1 ? String(discs.length) : '');
  row('On disk', bytes ? fmtBytes(bytes) : '');
  row('Runtime', album.duration ? fmtTotal(album.duration) : '');
  if (spec.children.length) back.appendChild(spec);

  // The album key, which is a hash, set where a catalogue number goes. It is
  // the only stable name this record has inside the app.
  back.appendChild(el('div', { class: 'back-cat' },
    el('span', { text: 'SNR-' + String(album.key).toUpperCase() }),
    album.year ? el('span', { text: String(album.year) }) : null));

  return back;
}

/** Paints a soft wash of the album's own colour behind its header. */
export function applyHeroTint(hero, key) {
  /* Removing, not just setting. This runs again when the cover changes, and
     putting an album back to a picture with no colour of its own has to take
     the old tint away — otherwise the page stays lit by artwork that is no
     longer on it. */
  const paint = (rgb) => {
    if (rgb) hero.style.setProperty('--hero-rgb', rgb.join(' '));
    else hero.style.removeProperty('--hero-rgb');
  };
  const rgb = lib.accentFor(key);
  if (rgb) paint(rgb);
  else lib.loadArt(key).then(() => paint(lib.accentFor(key)));
}
