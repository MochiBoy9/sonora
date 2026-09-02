/* views/settings.js — every switch in the application, and the Look. */

import * as rack from '../audio.js';
import * as backup from '../backup.js';
import * as band from '../band.js';
import * as db from '../db.js';
import * as lib from '../library.js';
import * as looks from '../looks.js';
import { canDeviceTilt, deviceTiltRunning, enter, requestDeviceTilt, reveal, stopDeviceTilt } from '../motion.js';
import * as offline from '../offline.js';
import * as player from '../player.js';
import * as session from '../session.js';
import * as stats from '../stats.js';
import * as shopWindow from '../idle.js';
import { dialog, sectionHead, toast } from '../ui.js';
import { el, fmtAgo, fmtBytes, fmtCount, fmtTotal, ico } from '../util.js';
import { MODES, isMode } from '../visualizer.js';

export function viewSettings(host) {
  const offs = [];
  const head = el('header', { class: 'page-head' },
    el('p', { class: 'eyebrow', text: 'System' }),
    el('h1', { class: 'page-title', text: 'Settings' }),
    el('p', { class: 'page-sub', text: 'Playback · folders · appearance · visualiser · storage' }));
  host.appendChild(head);

  /* --- playback ---
   *
   * One slider for gapless and crossfade, because they are one mechanism: at
   * zero the next track starts the instant the last one ends, and above zero
   * they overlap. Splitting them into two controls would suggest they can
   * disagree, and would leave a listener wondering which one wins. */
  const playback = el('section', { class: 'block' }, sectionHead('Playback'));
  const pbRows = el('div', { class: 'rows' });

  const fadeValue = el('span', { class: 'settings-value' });
  const fadeSlider = el('input', {
    type: 'range', min: '0', max: String(player.MAX_CROSSFADE), step: '0.5',
    class: 'settings-range', 'aria-label': 'Crossfade length in seconds',
    value: String(player.state.crossfade),
  });
  const paintFade = () => {
    const v = player.state.crossfade;
    fadeValue.textContent = v === 0 ? 'Gapless' : v.toFixed(1).replace(/\.0$/, '') + 's';
    fadeSlider.value = String(v);
    fadeSlider.setAttribute('aria-valuetext', fadeValue.textContent);
  };
  fadeSlider.addEventListener('input', () => {
    player.setCrossfade(parseFloat(fadeSlider.value));
    paintFade();
  });
  paintFade();

  const seamlessSwitch = el('button', {
    class: 'switch' + (player.state.seamless ? ' is-on' : ''),
    role: 'switch', 'aria-checked': String(player.state.seamless),
  }, el('span', { class: 'switch-knob' }));
  seamlessSwitch.addEventListener('click', () => {
    player.setSeamless(!player.state.seamless);
    const on = player.state.seamless;
    seamlessSwitch.classList.toggle('is-on', on);
    seamlessSwitch.setAttribute('aria-checked', String(on));
    fadeSlider.disabled = !on;
  });
  fadeSlider.disabled = !player.state.seamless;

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('next') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Run tracks together' }),
      el('div', { class: 'settings-note', text: 'Hand over to the next track without stopping. Off leaves the gap between them.' })),
    el('div', { class: 'settings-actions' }, seamlessSwitch)));

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('shuffle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Crossfade' }),
      el('div', { class: 'settings-note', text: 'How long the two overlap. At zero the next track starts the instant the last one ends — what a live album needs.' })),
    el('div', { class: 'settings-actions settings-slider' }, fadeSlider, fadeValue)));

  /* Q7: which shape the overlap takes. Two ramps that each run 0..1 sum to 1
     in amplitude, which is a dip of about 3dB in the middle where the two
     tracks are uncorrelated — audible on anything with a steady bed under it.
     The equal-power pair sums to 1 in *power* instead and holds the level, at
     the cost of a bump where the two do correlate. Neither is right for every
     pair of records, so it is a choice rather than a constant. */
  const curvePick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Crossfade shape' });
  for (const [mode, label, hint] of [
    ['equal', 'Hold the level', 'Equal power: the overlap stays as loud as either track alone'],
    ['linear', 'Straight lines', 'Equal amplitude: dips slightly in the middle, and never bumps'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.fadeCurve === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.fadeCurve === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setFadeCurve(mode);
      for (const x of curvePick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    curvePick.appendChild(b);
  }

  const curveRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('sliders') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Crossfade shape' }),
      el('div', { class: 'settings-note', text: 'Holding the level suits most records. Straight lines are the safer choice where two tracks share a drone or a room \u2014 there, holding the level can bump.' })),
    el('div', { class: 'settings-actions' }, curvePick));
  curveRow.hidden = player.state.crossfade === 0;
  pbRows.appendChild(curveRow);

  /* The shape only exists while there is an overlap to shape, so the row
     appears with the slider rather than sitting there greyed out. */
  const paintCurveRow = () => { curveRow.hidden = !player.state.seamless || player.state.crossfade === 0; };
  fadeSlider.addEventListener('input', paintCurveRow);
  seamlessSwitch.addEventListener('click', paintCurveRow);
  paintCurveRow();

  const levelPick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Loudness levelling' });
  for (const [mode, label, hint] of [
    ['off', 'Off', 'Play every file at the level it was mastered'],
    ['track', 'Track', 'Even out every song against every other'],
    ['album', 'Album', 'Move each record as a whole, keeping its internal balance'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.levelling === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.levelling === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setLevelling(mode);
      for (const x of levelPick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    levelPick.appendChild(b);
  }

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('volume') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Even out the volume' }),
      el('div', { class: 'settings-note', text: 'Uses the ReplayGain tag where a file has one, and what Sonora measured on the first listen where it does not.' })),
    el('div', { class: 'settings-actions' }, levelPick)));

  const shufPick = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Shuffle style' });
  for (const [mode, label, hint] of [
    ['even', 'Even', 'Every track equally likely'],
    ['weighted', 'Learned', 'Leans towards what you play and away from what you just heard'],
  ]) {
    const b = el('button', {
      class: 'seg' + (player.state.shuffleMode === mode ? ' is-on' : ''),
      role: 'radio', 'aria-checked': String(player.state.shuffleMode === mode),
      text: label, title: hint,
    });
    b.addEventListener('click', () => {
      player.setShuffleMode(mode);
      for (const x of shufPick.children) {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      }
    });
    shufPick.appendChild(b);
  }

  pbRows.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('shuffle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Shuffle style' }),
      el('div', { class: 'settings-note', text: 'Learned leans gently towards what you actually play, and hard away from anything heard in the last hour.' })),
    el('div', { class: 'settings-actions' }, shufPick)));

  /** A plain on/off row driven by a player setter. */
  const toggleRow = (icon, name, note, get, set) => {
    const btn = el('button', {
      class: 'switch' + (get() ? ' is-on' : ''),
      role: 'switch', 'aria-checked': String(get()),
    }, el('span', { class: 'switch-knob' }));
    btn.addEventListener('click', () => {
      set(!get());
      const on = get();
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
    });
    return el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico(icon) }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: name }),
        el('div', { class: 'settings-note', text: note })),
      el('div', { class: 'settings-actions' }, btn));
  };

  pbRows.appendChild(toggleRow('play', 'Skip the silence at the start',
    'Most rips carry a second or two of nothing before the first note. Starts at the music instead, and the scrubber still shows what was skipped.',
    () => player.state.trimSilence, (v) => player.setTrimSilence(v)));

  pbRows.appendChild(toggleRow('sliders', 'Land the crossfade on the beat',
    'Where both tracks have a clear tempo and the two are close, the overlap starts on a beat rather than on a stopwatch.',
    () => player.state.beatMatch, (v) => player.setBeatMatch(v)));

  /* Q8: which output the sound leaves by. The browser will only name devices
     once it has been given permission to look at them, and asking for that
     permission means asking for a microphone \u2014 too steep a price to pay on
     the chance somebody owns two sets of speakers. So the list stays a button
     until it is wanted. */
  if (player.canRouteOutput()) {
    const pick = el('select', { class: 'settings-select', 'aria-label': 'Output device' });
    const note = el('div', { class: 'settings-note', text: 'Sonora plays through whatever the system is using. Choose a different output to send it somewhere else.' });
    let loaded = false;

    const fill = async () => {
      const devices = await player.outputs();
      pick.textContent = '';
      pick.appendChild(el('option', { value: '', text: 'System default' }));
      for (const d of devices) pick.appendChild(el('option', { value: d.deviceId, text: d.label }));
      pick.value = player.state.sink || '';
      loaded = true;
    };

    const reveal = el('button', { class: 'btn sm', text: 'Choose\u2026' });
    reveal.addEventListener('click', async () => {
      reveal.disabled = true;
      const ok = await player.askForOutputs();
      reveal.disabled = false;
      if (!ok) { note.textContent = 'The browser would not list the outputs. Sonora keeps using the system default.'; return; }
      reveal.hidden = true;
      pick.hidden = false;
      await fill();
    });
    pick.hidden = true;
    pick.addEventListener('change', async () => {
      const res = await player.setSink(pick.value);
      if (!res.ok && pick.value) {
        pick.value = '';
        toast('That output is no longer there');
      }
    });
    /* Where permission has already been granted the list can be built without
       asking again, so the button never appears. */
    player.outputsNamed().then((named) => {
      if (!named) return;
      reveal.hidden = true;
      pick.hidden = false;
      if (!loaded) fill();
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (loaded) fill(); });

    pbRows.appendChild(el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico('volume') }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: 'Play through' }), note),
      el('div', { class: 'settings-actions' }, reveal, pick)));
  }

  playback.appendChild(pbRows);
  host.appendChild(playback);

  /* --- folders --- */
  const folders = el('section', { class: 'block' }, sectionHead('Music folders'));
  const list = el('div', { class: 'rows' });

  const onOff = (root) => {
    const btn = el('button', {
      class: 'switch' + (root.off ? '' : ' is-on'),
      role: 'switch', 'aria-checked': String(!root.off),
      title: root.off ? 'Bring this folder back into the library' : 'Hide this folder without forgetting anything about it',
    }, el('span', { class: 'switch-knob' }));
    btn.addEventListener('click', async () => {
      await lib.setRootOff(root.id, !root.off);
      paintRoots();
      toast(root.off ? `“${root.name}” is back` : `“${root.name}” hidden — nothing was forgotten`);
    });
    return btn;
  };

  const paintRoots = () => {
    list.textContent = '';
    if (!lib.state.roots.length) {
      list.appendChild(el('p', { class: 'muted', text: 'No folders added yet.' }));
    }
    for (const root of lib.state.roots) {
      const row = el('div', { class: 'settings-row' + (root.off ? ' is-off' : '') },
        el('div', { class: 'settings-ico', html: ico('folder') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: root.name }),
          el('div', { class: 'settings-note', text:
            root.off ? 'Off — its tracks are out of the library, and everything you have told Sonora about them is kept'
            : root.needsPermission ? 'Permission needed — click Reconnect'
            : root.needsReconnect ? 'Re-add this folder to play its files this session'
            : `${fmtCount(root.count || 0, 'file')} · ${root.kind === 'handle' ? 'linked folder' : 'session only'}` })),
        el('div', { class: 'settings-actions' },
          /* I4: off, not gone. The only two options were keep and remove, and
             removing empties everything that came from the folder —
             corrections and favourites included. A drive that is not plugged
             in today is not a folder you want to forget. */
          onOff(root),
          (root.needsPermission || root.needsReconnect)
            ? el('button', { class: 'btn ghost sm', text: 'Reconnect', onclick: () => document.dispatchEvent(new CustomEvent('sonora:add')) })
            : el('button', { class: 'btn ghost sm', text: 'Rescan', disabled: !!root.off, onclick: () => lib.scanRoot(root) }),
          el('button', {
            class: 'icon-btn', html: ico('trash'), title: 'Remove',
            onclick: () => dialog({
              title: `Remove “${root.name}”?`,
              body: el('p', { class: 'muted', text: 'Tracks from this folder are removed from the library. Nothing on disk is touched.' }),
              actions: [{ label: 'Cancel' }, { label: 'Remove', danger: true, onSelect: () => lib.removeRoot(root.id) }],
            }),
          })));
      list.appendChild(row);
    }
  };
  paintRoots();
  folders.appendChild(list);
  folders.appendChild(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', html: ico('plus') + '<span>Add folder</span>', onclick: () => document.dispatchEvent(new CustomEvent('sonora:add')) }),
    el('button', { class: 'btn ghost', html: ico('refresh') + '<span>Rescan all</span>', onclick: () => lib.rescanAll() })));
  host.appendChild(folders);

  /* --- what the imports did ---
   *
   * I3. "Added 50 tracks · merged Graduation" was a toast: it named the merge,
   * which is exactly right, and then it was gone in four seconds and the merge
   * was unreviewable. I2's failures had nowhere to be read at all. The last few
   * runs are kept and both live here.
   */
  const imports = el('section', { class: 'block' }, sectionHead('Recent imports'));
  const runList = el('div', { class: 'rows' });
  imports.appendChild(runList);
  imports.appendChild(el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn ghost', html: ico('refresh') + '<span>Check for new files</span>',
      title: 'Walk the folders again. Only files that changed are re-read.',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const r = await lib.rescanAll();
        btn.disabled = false;
        if (!r.ok) toast('No folders to check');
      },
    })));

  const paintRuns = () => {
    const runs = lib.importRuns();
    runList.textContent = '';
    if (!runs.length) {
      runList.appendChild(el('p', { class: 'muted', text: 'Nothing imported yet this library. Runs that add, merge or fail on something are listed here.' }));
      return;
    }
    for (const run of runs) {
      const bits = [];
      if (run.added) bits.push(fmtCount(run.added, 'track') + ' added');
      if (run.merged.length) bits.push('merged ' + run.merged.slice(0, 3).map((t) => `“${t}”`).join(', ') +
        (run.merged.length > 3 ? ` and ${run.merged.length - 3} more` : ''));
      if (run.failed) bits.push(`${run.failed} read from the folder name`);
      // B7. Worth its own clause: it is the run where nothing was lost.
      if (run.moved) bits.push(fmtCount(run.moved, 'track') + ' re-filed after a move');

      const row = el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico(run.failed ? 'info' : 'database') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtAgo(run.at) + (run.ms > 1500 ? ` · ${(run.ms / 1000).toFixed(0)}s` : '') }),
          el('div', { class: 'settings-note', text: bits.join(' · ') || 'Nothing changed' })),
        el('div', { class: 'settings-actions' },
          run.failures.length
            ? el('button', {
              class: 'btn ghost sm', text: 'Which ones',
              onclick: () => dialog({
                title: `${fmtCount(run.failed, 'file')} Sonora learned nothing from`,
                width: 520,
                body: el('div', {},
                  el('p', { class: 'muted', text: 'Everything about these came from the folder they are in rather than from the files themselves. They were imported all the same, and they play — but the artist and album are a guess, and this is the list to check when the library has come out wrong. Sonora never writes to your files.' }),
                  el('ul', { class: 'fail-list' }, run.failures.map((f) =>
                    el('li', {},
                      el('span', { class: 'fail-name', text: f.name }),
                      el('span', { class: 'fail-why', text: f.reason })))),
                  run.failed > run.failures.length
                    ? el('p', { class: 'muted', text: `and ${run.failed - run.failures.length} more` })
                    : null),
                actions: [{ label: 'Close', primary: true }],
              }),
            })
            : null));
      runList.appendChild(row);
    }
  };
  paintRuns();
  offs.push(lib.events.on('runs', paintRuns));
  host.appendChild(imports);

  /* --- what you have overridden ---
   *
   * L17. A chosen cover and a bound rack are invisible until you walk into the
   * record that has one, which makes them overrides you cannot find and
   * therefore cannot undo six months later. Listed, with a way back to each.
   */
  const overrides = el('section', { class: 'block' }, sectionHead('Your overrides'));
  const overRows = el('div', { class: 'rows' });
  overrides.appendChild(overRows);

  const paintOverrides = async () => {
    overRows.textContent = '';
    const covers = lib.chosenCovers();
    const bindings = rack.allBindings();

    if (!covers.length && !bindings.length) {
      overRows.appendChild(el('p', { class: 'muted', text: 'None yet. Drop a picture on a record to give it a cover, or bind a rack to an album from the Sound page.' }));
      return;
    }

    if (covers.length) {
      overRows.appendChild(el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('image') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtCount(covers.length, 'chosen cover') }),
          el('div', { class: 'settings-note' },
            el('span', { class: 'over-list' }, covers.slice(0, 12).map((c) =>
              el('a', { class: 'over-chip', href: '#/album/' + c.key,
                text: c.album ? c.album.title : 'a record that has gone' })),
              covers.length > 12 ? el('span', { class: 'muted', text: ` and ${covers.length - 12} more` }) : null)))));
    }

    if (bindings.length) {
      /* G3/G6: five more scopes than there were, so this is a table rather
         than a chain of ternaries — and every one of them needs a way back to
         the thing it names, or it is an override you cannot find. */
      const named = [];
      for (const b of bindings) {
        let label = b.key, href = '';
        if (b.scope === 'album') {
          label = lib.state.albumBy.get(b.key)?.title || 'a record that has gone';
          href = '#/album/' + b.key;
        } else if (b.scope === 'artist') {
          label = lib.state.artists.find((a) => a.key === b.key)?.name || 'an artist that has gone';
          href = '#/artist/' + b.key;
        } else if (b.scope === 'track') {
          label = lib.getTrack(b.key)?.title || 'a track that has gone';
          const t = lib.getTrack(b.key);
          href = t ? '#/album/' + t.albumKey : '';
        } else if (b.scope === 'genre') {
          label = b.key;
          href = '#/genre/' + encodeURIComponent(b.key);
        } else if (b.scope === 'folder') {
          const parts = b.key.split('/').filter(Boolean);
          label = parts[parts.length - 1] || 'a folder';
          href = '#/files';
        } else if (b.scope === 'output') {
          label = b.key === 'default' || !b.key ? 'the default output' : 'one output device';
          href = '#/settings';
        }
        named.push({ ...b, label, href });
      }
      overRows.appendChild(el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('sliders') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: fmtCount(named.length, 'bound rack') }),
          el('div', { class: 'settings-note' },
            el('span', { class: 'over-list' }, named.slice(0, 12).map((b) =>
              el('a', {
                class: 'over-chip',
                href: b.href || '#/settings',
                title: `${b.scope}: ${b.label} → ${b.id}`,
                text: b.label,
              })))))));
    }
  };
  paintOverrides();
  offs.push(lib.events.on('change', paintOverrides));
  offs.push(rack.events.on('bound', paintOverrides));
  host.appendChild(overrides);

  /* --- older libraries ---
   *
   * L18. `guessed` has only been recorded since 2.6, so a library imported
   * before that gets silently worse album merging than a fresh import would.
   * The row only appears when there is something to do.
   */
  const backfill = el('section', { class: 'block' }, sectionHead('Older imports'));
  const bfNote = el('div', { class: 'settings-note' });
  const bfBtn = el('button', { class: 'btn ghost sm', text: 'Re-read those tags' });
  backfill.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('refresh') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Tracks imported before Sonora recorded what it guessed' }), bfNote),
    el('div', { class: 'settings-actions' }, bfBtn)));

  const paintBackfill = () => {
    const n = lib.needsBackfill();
    backfill.hidden = n === 0;
    bfNote.textContent = n
      ? `${fmtCount(n, 'track')} came in before Sonora kept track of which fields it had to take from the folder name. Until it does, albums merge slightly worse than they should.`
      : '';
  };
  bfBtn.addEventListener('click', async () => {
    bfBtn.disabled = true;
    const res = await lib.backfillGuessed((done, total) => {
      bfBtn.textContent = `${done} of ${total}…`;
    });
    bfBtn.disabled = false;
    bfBtn.textContent = 'Re-read those tags';
    paintBackfill();
    toast(res.ok ? `Re-read ${fmtCount(res.done, 'track')}` : 'Already running');
  });
  paintBackfill();
  offs.push(lib.events.on('change', paintBackfill));
  host.appendChild(backfill);

  /* --- connection --- */
  const conn = el('section', { class: 'block' }, sectionHead('Connection'));
  conn.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('plug') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Reconnect on launch' }),
      el('div', { class: 'settings-note', text: 'Re-open the folders you linked and pick up the track you left, without being asked' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('autoconnect', true))));

  const stateRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('refresh') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Connection state' }),
      el('div', { class: 'settings-note', id: 'conn-note', text: connectionNote() })),
    el('div', { class: 'settings-actions' },
      session.isDisconnected()
        ? el('button', { class: 'btn ghost sm', text: 'Reconnect now', onclick: () => { document.dispatchEvent(new CustomEvent('sonora:reconnect')); setTimeout(() => document.dispatchEvent(new CustomEvent('sonora:refresh')), 400); } })
        : el('button', { class: 'btn ghost sm', text: 'Disconnect', onclick: () => { document.dispatchEvent(new CustomEvent('sonora:disconnect')); document.dispatchEvent(new CustomEvent('sonora:refresh')); } })));
  conn.appendChild(stateRow);
  host.appendChild(conn);

  /* --- looks --- */
  host.appendChild(looksPanel());

  /* --- appearance --- */
  const appearance = el('section', { class: 'block' }, sectionHead('Appearance'));

  /* Device tilt. Only offered where the platform can actually report it —
     a switch that does nothing on a desktop is worse than no switch. */
  if (canDeviceTilt()) {
    const tiltBtn = el('button', {
      class: 'switch' + (deviceTiltRunning() ? ' is-on' : ''),
      role: 'switch', 'aria-checked': String(deviceTiltRunning()),
    }, el('span', { class: 'switch-knob' }));
    tiltBtn.addEventListener('click', async () => {
      if (deviceTiltRunning()) {
        stopDeviceTilt();
        try { localStorage.setItem('sonora:tilt', '0'); } catch { /* private mode */ }
      } else {
        // Must happen inside this click: iOS refuses the prompt otherwise.
        const ok = await requestDeviceTilt();
        try { localStorage.setItem('sonora:tilt', ok ? '1' : '0'); } catch { /* private mode */ }
        if (!ok) toast('Your device would not share its orientation');
      }
      const on = deviceTiltRunning();
      tiltBtn.classList.toggle('is-on', on);
      tiltBtn.setAttribute('aria-checked', String(on));
    });

    appearance.appendChild(el('div', { class: 'rows' },
      el('div', { class: 'settings-row' },
        el('div', { class: 'settings-ico', html: ico('cube') }),
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: 'Tilt with the device' }),
          el('div', { class: 'settings-note', text: 'Artwork catches the light from however you are holding it, the way a record held up to a window does.' })),
        el('div', { class: 'settings-actions' }, tiltBtn))));
  }

  const accentRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('palette') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Colour from artwork' }),
      el('div', { class: 'settings-note', text: 'Tint the interface with the current album’s colour' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('accent', true)));
  appearance.appendChild(accentRow);

  const backdropRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('sparkle') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Motion backdrop' }),
      el('div', { class: 'settings-note', text: 'The 3D depth field behind the interface, drawn on the GPU' })),
    el('div', { class: 'settings-actions' }, toggleSwitch('backdrop', true)));
  appearance.appendChild(backdropRow);
  host.appendChild(appearance);

  /* --- visualiser --- */
  const viz = el('section', { class: 'block' }, sectionHead('Visualiser'));
  viz.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('wave') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Style' }),
      el('div', { class: 'settings-note', text: 'How the spectrum is drawn, everywhere it appears' })),
    el('div', { class: 'settings-actions' }, vizSwitch())));
  viz.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('expand') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Immersive view' }),
      el('div', { class: 'settings-note', text: 'Full-screen artwork and spectrum — press V at any time' })),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', html: ico('play') + '<span>Open</span>',
        onclick: () => document.dispatchEvent(new CustomEvent('sonora:stage')),
      }))));
  host.appendChild(viz);

  /* --- online --- */
  const online = el('section', { class: 'block' }, sectionHead('Online'));
  online.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('globe') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Band overview' }),
      el('div', { class: 'settings-note', text: 'Off by default. When on, an artist name (and nothing else) can be sent to MusicBrainz and Wikipedia — only when you press Analyse.' })),
    el('div', { class: 'settings-actions' }, onlineSwitch())));
  online.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('database') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Cached lookups' }),
      el('div', { class: 'settings-note', id: 'band-cache', text: 'Counting…' })),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear cache',
        onclick: async () => { await band.clearCache(); toast('Online cache cleared'); paintCacheCount(); },
      }))));
  host.appendChild(online);
  paintCacheCount();

  /* --- listening --- */
  const listening = el('section', { class: 'block' }, sectionHead('Listening data'));
  listening.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('circles') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Circle Analysis Center' }),
      el('div', { class: 'settings-note', text: `${fmtTotal(stats.total()) || '0 min'} counted across ${fmtCount(stats.trackedCount(), 'track')} — never leaves this device` })),
    el('div', { class: 'settings-actions' },
      el('button', { class: 'btn ghost sm', text: 'Open', onclick: () => (location.hash = '#/circles') }),
      el('button', {
        class: 'btn ghost sm', text: 'Reset',
        onclick: () => dialog({
          title: 'Reset listening data?',
          body: el('p', { class: 'muted', text: 'Every second counted so far is discarded. Your library and files are untouched.' }),
          actions: [{ label: 'Cancel' }, { label: 'Reset', danger: true, onSelect: async () => { await stats.reset(); toast('Listening data cleared'); document.dispatchEvent(new CustomEvent('sonora:refresh')); } }],
        }),
      }))));
  host.appendChild(listening);

  /* --- storage --- */
  const storage = el('section', { class: 'block' }, sectionHead('Storage'));
  const note = el('div', { class: 'settings-note', text: 'Reading…' });
  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('database') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Cached metadata and artwork' }), note),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear library',
        onclick: () => dialog({
          title: 'Clear the library?',
          body: el('p', { class: 'muted', text: 'Removes all cached metadata, artwork and playlists. Your audio files are never touched.' }),
          actions: [{ label: 'Cancel' }, { label: 'Clear everything', danger: true, onSelect: async () => { await db.wipe(); location.reload(); } }],
        }),
      }))));
  db.usage().then((u) => {
    note.textContent = u
      ? `${fmtBytes(u.used)} used${u.quota ? ` of ${fmtBytes(u.quota)} available` : ''}`
      : `${fmtCount(lib.trackCount(), 'track')} indexed`;
    /* Room runs out quietly. An origin at its ceiling stops being able to write
       — a new import half-lands, a playlist does not save — and nothing about
       that failure names the cause unless somebody says so first. */
    if (u && u.quota && u.used / u.quota > 0.8) {
      note.appendChild(el('span', { class: 'settings-warn',
        text: ` · ${Math.round(100 * u.used / u.quota)}% of what this browser allows` }));
    }
  });

  /*
   * Whether the browser has promised to keep any of it.
   *
   * This is the row that matters most on this page and it is the one that did
   * not exist. Everything Sonora lets you change lives in IndexedDB and nowhere
   * else — playlists, favourites, tag corrections, chosen covers, bound racks,
   * every hour of listening. Without a persistence grant that is *best-effort*
   * storage, which a browser short of room may evict without asking, and there
   * is no server copy to come back from, because there is no server.
   */
  /* D3 and D4: the copy that lives somewhere else.
   *
   * The row above is honest about destroying the overlays and there was no way
   * to take a copy first — which, in an application with no account and no
   * server, means there was no other copy of months of corrections anywhere.
   * Written and read as one JSON file. */
  const backupNote = el('div', { class: 'settings-note',
    text: 'Playlists, favourites, corrections, chosen covers, racks, listening totals and settings. Not the audio.' });
  const withArt = el('button', {
    class: 'switch', role: 'switch', 'aria-checked': 'false',
    title: 'Include the artwork thumbnails. Much larger, and they can be rebuilt from your files in seconds.',
  }, el('span', { class: 'switch-knob' }));
  let artIn = false;
  withArt.addEventListener('click', () => {
    artIn = !artIn;
    withArt.classList.toggle('is-on', artIn);
    withArt.setAttribute('aria-checked', String(artIn));
  });

  const saveBackup = el('button', {
    class: 'btn ghost sm', text: 'Save a backup',
    onclick: async () => {
      saveBackup.disabled = true;
      saveBackup.textContent = 'Collecting…';
      try {
        const doc = await backup.build({ art: artIn });
        const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `sonora-backup-${doc.saved.slice(0, 10)}.json` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast(`Saved ${fmtCount(doc.counts.overlays, 'correction')} · ${fmtCount(doc.counts.playlists, 'playlist')} · ${fmtCount(doc.counts.favourites, 'favourite')}`);
      } finally {
        saveBackup.disabled = false;
        saveBackup.textContent = 'Save a backup';
      }
    },
  });

  const restorePicker = el('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async () => {
      const file = restorePicker.files && restorePicker.files[0];
      restorePicker.value = '';
      if (file) offerBackup(await file.text());
    },
  });
  const restoreBtn = el('button', {
    class: 'btn ghost sm', text: 'Read one back',
    onclick: () => restorePicker.click(),
  });

  /** Shows what merging a backup would do, and merges only if asked. */
  function offerBackup(text) {
    const read = backup.inspect(text);
    if (!read.ok) { toast(read.reason); return; }
    const s = read.summary;
    const lines = [];
    if (s.overlays) lines.push(`${fmtCount(s.overlays, 'correction')}, ${s.matched} of which match tracks you have`);
    if (s.favourites) lines.push(`${fmtCount(s.favourites, 'favourite')}, ${s.favMatched} matched`);
    if (s.playlists) lines.push(`${fmtCount(s.playlists, 'playlist')}, ${s.newPlaylists} new to this library`);
    if (s.art) lines.push(`${fmtCount(s.art, 'cover')}`);

    /* Settings are off by default and stated separately. The common case is a
       fresh browser that has just rescanned the same folder, where what is
       wanted back is the work — and quietly replacing the crossfade, the Look
       and the output device with a six-month-old machine's is a surprise. */
    let bringSettings = false;
    const settingsSwitch = el('button', {
      class: 'switch', role: 'switch', 'aria-checked': 'false',
    }, el('span', { class: 'switch-knob' }));
    settingsSwitch.addEventListener('click', () => {
      bringSettings = !bringSettings;
      settingsSwitch.classList.toggle('is-on', bringSettings);
      settingsSwitch.setAttribute('aria-checked', String(bringSettings));
    });

    const body = el('div', {},
      el('p', { text: read.saved ? `Saved ${read.saved.slice(0, 10)}.` : 'A Sonora backup.' }),
      lines.length
        ? el('ul', { class: 'backup-list' }, lines.map((t) => el('li', { text: t })))
        : el('p', { class: 'muted', text: 'There is nothing in it this library does not already have.' }),
      s.roots.length
        ? el('p', { class: 'muted', text: `It came from: ${s.roots.join(', ')}. Folder permissions cannot be carried between browsers, so you will be asked to point at them again.` })
        : null,
      el('div', { class: 'settings-row' },
        el('div', { class: 'settings-text' },
          el('div', { class: 'settings-name', text: 'Also bring the settings and the Look' }),
          el('div', { class: 'settings-note', text: 'Off by default: what you usually want back is the work, not another machine\u2019s crossfade.' })),
        el('div', { class: 'settings-actions' }, settingsSwitch)),
      el('p', { class: 'muted', text: 'Nothing is replaced — this merges, and the whole merge is one undo.' }));

    dialog({
      title: 'Read this backup in?',
      body,
      width: 520,
      actions: [
        { label: 'Cancel' },
        { label: 'Merge it in', primary: true, onSelect: async () => {
          const res = await backup.merge(read, { settings: bringSettings });
          if (!res.ok) { toast('That backup could not be read'); return; }
          const d = res.done;
          toast(`Restored ${fmtCount(d.overlays, 'correction')}, ${fmtCount(d.favourites, 'favourite')}, ${fmtCount(d.playlists, 'playlist')}`);
        } },
      ],
    });
  }

  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('file') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Backup' }), backupNote),
    el('div', { class: 'settings-actions' }, withArt, saveBackup, restoreBtn, restorePicker)));

  /* A5: the listening history, in a shape something else can read.
   *
   * The backup carries it as an opaque blob keyed by track id, which is
   * exactly right for putting it back into Sonora and useless for anything
   * else. A date, a track, an artist and a number of seconds is what a
   * spreadsheet, a scrobble importer or a graph nobody has thought of yet can
   * actually take — the same argument the M3U export won.
   *
   * Written here rather than in a module of its own because it is nine lines
   * of quoting and one anchor; a file for that would be filing. */
  const csvNote = el('div', { class: 'settings-note' });
  const paintCsv = () => {
    const n = stats.dayCount();
    csvNote.textContent = n
      ? `A row per day per track: date, title, artist, album, seconds. ${fmtCount(n, 'day')} recorded.`
      : 'A row per day per track. Nothing recorded yet — it starts as soon as you play something.';
  };
  paintCsv();

  const csvBtn = el('button', {
    class: 'btn ghost sm', text: 'Export CSV',
    onclick: () => {
      const rows = stats.asRows();
      if (!rows.length) return toast('No listening recorded yet');
      // RFC 4180 quoting: everything quoted, and a quote inside doubled. Titles
      // contain commas, quotation marks and the occasional newline, and a CSV
      // that only quotes when it thinks it has to is a CSV that gets it wrong
      // on somebody's library and not on mine.
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const head = ['date', 'title', 'artist', 'album', 'seconds', 'track_id'];
      const body = rows.map((r) => [r.day, r.title, r.artist, r.album, r.seconds, r.id].map(q).join(','));
      // A BOM, because the single most likely destination is a spreadsheet on
      // Windows and without one it reads UTF-8 as Latin-1 and mangles every
      // accented name in the library.
      const blob = new Blob(['\ufeff' + [head.map(q).join(','), ...body].join('\r\n') + '\r\n'],
                            { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `sonora-listening-${stats.dayKey()}.csv` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported ${fmtCount(rows.length, 'row')}`);
    },
  });

  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('clock') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Listening history' }), csvNote),
    el('div', { class: 'settings-actions' }, csvBtn)));

  const keepNote = el('div', { class: 'settings-note', text: 'Checking…' });
  const keepBtn = el('button', { class: 'btn ghost sm', text: 'Ask to keep it', hidden: true });
  storage.appendChild(el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('cube') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Kept when the browser is short of room' }), keepNote),
    el('div', { class: 'settings-actions' }, keepBtn)));

  async function paintKeep() {
    if (!navigator.storage?.persist) {
      keepNote.textContent = 'This browser does not say either way.';
      return;
    }
    const on = await db.persisted();
    keepNote.textContent = on
      ? 'Yes. Your library will not be evicted to make room.'
      : 'Not yet — this browser may clear the library if it runs short of space.';
    keepBtn.hidden = on;
  }
  keepBtn.addEventListener('click', async () => {
    const r = await db.requestPersist();
    // Chromium decides from how the site is used rather than by asking, so a
    // refusal is a "not yet" rather than a no, and saying so is the honest form.
    toast(r.granted ? 'The browser will keep your library'
                    : 'The browser has not granted it yet — it often does once the app has been used a few times');
    paintKeep();
  });
  paintKeep();

  /* Whether the application itself opens without a network.
   *
   * Worth showing rather than leaving implicit: "works offline" is the sort of
   * claim people reasonably want to verify before they get on a plane, and
   * until this row existed there was no way to tell whether the shell had
   * actually been cached or only promised. */
  const offNote = el('div', { class: 'settings-note', text: 'Checking…' });
  const offRow = el('div', { class: 'settings-row' },
    el('div', { class: 'settings-ico', html: ico('plug') }),
    el('div', { class: 'settings-text' },
      el('div', { class: 'settings-name', text: 'Opens without a network' }), offNote),
    el('div', { class: 'settings-actions' },
      el('button', {
        class: 'btn ghost sm', text: 'Clear app cache',
        onclick: async () => {
          const ok = await offline.clearOffline();
          toast(ok ? 'App cache cleared — reload to fetch a fresh copy' : 'Nothing to clear');
          paintOffline();
        },
      })));
  storage.appendChild(offRow);

  async function paintOffline() {
    const s = offline.status();
    if (!s.supported) {
      offNote.textContent = 'Not available here — this needs to be served over http, not opened as a file.';
      return;
    }
    const c = await offline.cachedBytes();
    if (c && c.files) {
      offNote.textContent = `${fmtCount(c.files, 'file')} cached · ${fmtBytes(c.bytes)}` +
        (s.controlled ? ' · serving from cache' : ' · takes effect on next launch');
    } else {
      offNote.textContent = s.registered
        ? 'Caching the app now…'
        : 'Not cached yet — this happens a few seconds after launch.';
    }
  }
  paintOffline();

  host.appendChild(storage);

  /* What the collection is made of. Bars in the mono stack rather than a pie
     chart: these are counts to be read off, not proportions to be admired, and
     a machine that tells you what it is holding is behaving like an
     instrument. */
  const shape = el('section', { class: 'block' }, sectionHead('What is in here'));
  const paintShape = () => {
    for (const n of [...shape.children].slice(1)) n.remove();
    const c = lib.census();
    if (!c.total) {
      shape.appendChild(el('p', { class: 'muted small', text: 'Nothing indexed yet.' }));
      return;
    }

    const bars = (rows, total, label) => {
      const wrap = el('div', { class: 'census' });
      for (const [k, n] of rows.slice(0, 6)) {
        wrap.appendChild(el('div', { class: 'census-row' },
          el('span', { class: 'census-key', text: label(k) }),
          el('span', { class: 'census-bar' },
            el('i', { style: { width: Math.max(1.5, (n / total) * 100) + '%' } })),
          el('span', { class: 'census-n', text: n.toLocaleString() })));
      }
      return wrap;
    };

    const pct = Math.round((c.lossless / c.total) * 100);
    shape.appendChild(el('p', { class: 'muted small', text:
      `${c.total.toLocaleString()} tracks · ${fmtBytes(c.bytes)} on disk · ${pct}% lossless` }));

    shape.appendChild(el('p', { class: 'label census-head', text: 'Container' }));
    shape.appendChild(bars(c.formats, c.total, (k) => k.toUpperCase()));

    if (c.known.rate) {
      shape.appendChild(el('p', { class: 'label census-head', text: 'Sample rate' }));
      shape.appendChild(bars(c.rates, c.known.rate,
        (k) => (k % 1000 === 0 ? k / 1000 : (k / 1000).toFixed(1)) + ' kHz'));
    }
    if (c.known.depth) {
      shape.appendChild(el('p', { class: 'label census-head', text: 'Bit depth' }));
      shape.appendChild(bars(c.depths, c.known.depth, (k) => k + '-bit'));
    }
    // Said plainly rather than folded into the bars: a library imported before
    // the reader kept stream details is not a library of unknown files.
    if (c.known.rate < c.total) {
      shape.appendChild(el('p', { class: 'muted small', text:
        `${(c.total - c.known.rate).toLocaleString()} tracks were indexed before Sonora recorded stream details. Rescan a folder to fill them in.` }));
    }
  };
  paintShape();
  host.appendChild(shape);

  const keys = el('section', { class: 'block' },
    sectionHead('Keyboard'),
    el('div', { class: 'settings-row' },
      el('div', { class: 'settings-ico', html: ico('keys') }),
      el('div', { class: 'settings-text' },
        el('div', { class: 'settings-name', text: 'Shortcuts' }),
        el('div', { class: 'settings-note', text: 'Sonora is meant to be played from the keyboard. Press ? anywhere for the whole list.' })),
      el('div', { class: 'settings-actions' },
        el('button', {
          class: 'btn ghost sm', text: 'Show shortcuts',
          onclick: () => document.dispatchEvent(new CustomEvent('sonora:shortcuts')),
        }))));
  host.appendChild(keys);

  const about = el('section', { class: 'block about' },
    sectionHead('About'),
    el('p', { class: 'muted', text: 'Sonora plays audio files from this computer. Files are read directly by the browser — nothing is uploaded, and the library index lives in local storage on this device.' }),
    el('p', { class: 'muted small', text: 'Every audio container is indexed and tagged — MP3, M4A/AAC, FLAC, Ogg/Opus, WAV, AIFF, WebM/Matroska and the rest. Anything this browser has no decoder for is still catalogued, and says so on its row.' }),
    // The serial: random, generated once, derived from nothing about you.
    el('p', { class: 'muted small mono', text: lib.serial }));
  host.appendChild(about);

  enter([head, folders, imports, overrides, backfill, conn, appearance, viz, online, listening, storage, shape, keys, about], { each: 34, y: 12 });
  offs.push(lib.events.on('roots', paintRoots));
  return () => { while (offs.length) offs.pop()(); };
}

/**
 * The look panel: every visual preference in the app, in one place, drawn
 * from the schema rather than written out.
 *
 * Nothing here knows what any setting *does* — it reads `looks.SCHEMA`, draws
 * the right control for each kind, and writes back. Adding a setting is one
 * line in looks.js and it appears here, correctly grouped, with its hint, its
 * units and its keyboard handling already working.
 */
function looksPanel() {
  const block = el('section', { class: 'block' }, sectionHead('Look'));

  const swatches = el('div', { class: 'look-grid' });
  const paintSwatches = () => {
    const current = looks.currentLook();
    for (const btn of swatches.children) {
      btn.classList.toggle('is-on', btn.dataset.look === current);
    }
  };

  for (const look of looks.LOOKS) {
    // Each card is painted in its own colours, so the choice is visible
    // rather than described.
    const want = { ...looks.defaults(), ...look.patch };
    const btn = el('button', {
      class: 'look-swatch', data: { look: look.id },
      onclick: () => { looks.useLook(look.id); paintAllRows(); paintSwatches(); },
    },
      el('span', { class: 'look-name', text: look.label }),
      el('span', { class: 'look-note', text: look.note }),
      el('span', { class: 'look-bar' }, el('i'), el('i'), el('i')));
    btn.style.setProperty('--sw-a', hueRGB(want.hue, want.chroma, .52));
    btn.style.setProperty('--sw-b', hueRGB(want.hue + want.spread, want.chroma, .60));
    btn.style.setProperty('--sw-c', hueRGB(want.hue + want.spread * 2, want.chroma, .68));
    swatches.appendChild(btn);
  }
  block.appendChild(swatches);

  const rows = [];
  const paintAllRows = () => { for (const r of rows) r(); };

  for (const [group, specs] of looks.groups()) {
    const panel = el('div', { class: 'rack-panel look-group' },
      el('div', { class: 'rack-head' }, el('span', { class: 'label', text: group })));

    for (const spec of specs) {
      const name = spec.label || spec.id;
      let control, sync;

      if (spec.kind === 'range') {
        const val = el('span', { class: 'rack-val' });
        const input = el('input', {
          type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step || 1),
          'aria-label': name,
          oninput: (e) => { looks.set(spec.id, +e.target.value); sync(); paintSwatches(); },
        });
        control = [input, val];
        sync = () => {
          const v = looks.state[spec.id];
          if (document.activeElement !== input) input.value = String(v);
          val.textContent = v + (spec.unit || '');
        };
      } else if (spec.kind === 'toggle') {
        const btn = el('button', {
          class: 'preset',
          onclick: () => { looks.set(spec.id, !looks.state[spec.id]); sync(); paintSwatches(); },
        });
        control = [el('span', {}), btn];
        sync = () => {
          const on = !!looks.state[spec.id];
          btn.textContent = on ? 'On' : 'Off';
          btn.classList.toggle('is-on', on);
        };
      } else {
        const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': name });
        for (const [value, label] of spec.options) {
          seg.appendChild(el('button', {
            class: 'seg', text: label, data: { value },
            onclick: () => { looks.set(spec.id, value); sync(); paintSwatches(); },
          }));
        }
        control = [el('span', {}), seg];
        sync = () => {
          for (const b of seg.children) {
            const on = b.dataset.value === looks.state[spec.id];
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', String(on));
          }
        };
      }

      const row = el('div', { class: 'rack-row look-row' },
        el('span', { class: 'rack-name', text: name, title: spec.hint || name }), ...control);
      /* F6: a setting you can see the effect of.
       *
       * The shop window is on a three-minute timer, so the only way to find
       * out what "Drift after" does was to set it and then not touch anything
       * for three minutes — which is a setting nobody can evaluate. It is also
       * the one thing here somebody might want to start deliberately, when
       * they are putting the machine on a shelf for the evening.
       *
       * Any input takes it away again, including the input that started it —
       * so the button releases the pointer first and lets the click finish
       * before the drift comes up. */
      if (spec.id === 'idle') {
        row.appendChild(el('button', {
          class: 'btn ghost sm look-demo', text: 'Show me',
          title: 'Start the drift now. Move the mouse to stop it.',
          onclick: (e) => {
            e.currentTarget.blur();
            setTimeout(() => {
              if (!shopWindow.show()) toast('Nothing to drift through yet — add some music first');
            }, 260);
          },
        }));
      }
      panel.appendChild(row);
      rows.push(sync);
      sync();
    }
    block.appendChild(panel);
  }

  block.appendChild(el('div', { class: 'settings-actions look-actions' },
    el('button', {
      class: 'btn ghost sm', text: 'Back to the shipped look',
      onclick: () => { looks.reset(); paintAllRows(); paintSwatches(); toast('Look reset'); },
    })));

  paintSwatches();
  return block;
}

/** The same HSL the look engine uses, for painting the swatches. */
function hueRGB(h, chroma, l) {
  h = ((h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1.4, chroma / 100)) * 0.86 + 0.14;
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `${Math.round((r + m) * 255)} ${Math.round((g + m) * 255)} ${Math.round((b + m) * 255)}`;
}

function connectionNote() {
  if (session.isDisconnected()) return 'Disconnected — nothing reconnects until you turn it back on';
  const st = session.state;
  if (st.phase === 'resumed') return `Reconnected and resumed in ${st.ms} ms`;
  if (st.phase === 'ready') return st.ms ? `Ready in ${st.ms} ms` : 'Ready';
  if (st.phase === 'failed') return 'Last launch could not reach the files';
  return 'Connected';
}

function paintCacheCount() {
  const note = document.getElementById('band-cache');
  if (!note) return;
  db.bandCount().then((n) => {
    note.textContent = n
      ? `${fmtCount(n, 'lookup')} stored on this device, expiring after 30 days`
      : 'Nothing cached yet';
  }).catch(() => { note.textContent = 'Nothing cached yet'; });
}

/** Consent, expressed as a switch: turning it on is the consent. */
function onlineSwitch() {
  const btn = el('button', {
    class: 'switch' + (band.isEnabled() ? ' is-on' : ''),
    role: 'switch', 'aria-checked': String(band.isEnabled()),
    'aria-label': 'Allow online band lookups',
  });
  btn.appendChild(el('span', { class: 'switch-knob' }));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', String(next));
    band.setEnabled(next);
    toast(next ? 'Online lookups enabled' : 'Online lookups disabled');
  });
  return btn;
}

/** Picks the visualiser style every canvas in the app reads from. */
function vizSwitch() {
  const wrap = el('div', { class: 'segmented' });
  let current = 'bars';
  try { const v = localStorage.getItem('sonora:viz'); if (isMode(v)) current = v; } catch { /* private mode */ }
  for (const m of MODES) {
    wrap.appendChild(el('button', {
      class: 'seg' + (current === m.id ? ' is-on' : ''),
      text: m.label,
      onclick: (e) => {
        for (const b of wrap.children) b.classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        try { localStorage.setItem('sonora:viz', m.id); } catch { /* private mode */ }
        document.dispatchEvent(new CustomEvent('sonora:viz-mode', { detail: m.id }));
      },
    }));
  }
  return wrap;
}

function toggleSwitch(name, fallback) {
  const stored = localStorage.getItem('sonora:' + name);
  const on = stored === null ? fallback : stored === '1';
  const btn = el('button', { class: 'switch' + (on ? ' is-on' : ''), role: 'switch', 'aria-checked': String(on) });
  btn.appendChild(el('span', { class: 'switch-knob' }));
  btn.addEventListener('click', () => {
    const next = !btn.classList.contains('is-on');
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', String(next));
    localStorage.setItem('sonora:' + name, next ? '1' : '0');
    document.dispatchEvent(new CustomEvent('sonora:setting', { detail: { name, value: next } }));
  });
  return btn;
}
