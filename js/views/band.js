/* views/band.js — the Analysis route, the Sound route, and the artist
 * overview that looks a band up. */

import * as band from '../band.js';
import { mountCircles } from '../circles.js';
import * as lib from '../library.js';
import { enter } from '../motion.js';
import * as offline from '../offline.js';
import { mountSound } from '../sound.js';
import * as stats from '../stats.js';
import { dialog, sectionHead, toast } from '../ui.js';
import { el, ico } from '../util.js';
import { playAll } from './shared.js';

export function viewCircles(host) {
  const api = mountCircles(host);

  const onReset = () => dialog({
    title: 'Reset listening data?',
    body: el('p', { class: 'muted', text: 'Every second counted so far is discarded. Your library, playlists and files are untouched — only the analytics are cleared.' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Reset', danger: true, onSelect: async () => { await stats.reset(); api.refresh(); toast('Listening data cleared'); } },
    ],
  });
  host.addEventListener('circles:reset', onReset);

  enter(host.children, { each: 60, y: 12 });
  return () => { host.removeEventListener('circles:reset', onReset); api.destroy(); };
}

/* ------------------------------------------------------------------ SOUND */

export const viewSound = (host) => mountSound(host);

/* ------------------------------------------------------------------ BAND */

/**
 * The Band Overview: four cards of context about whoever you are listening to,
 * fetched only when the feature is on, only when asked, and cached for a month.
 */
export function bandOverview(artistName) {
  const wrap = el('section', { class: 'block band' });
  const body = el('div', { class: 'band-body' });
  const status = el('div', { class: 'band-status' });

  const runBtn = el('button', {
    class: 'btn ghost sm', html: ico('globe') + '<span>Analyse online</span>',
    onclick: () => start(),
  });
  wrap.append(sectionHead('Band overview', null, null), status, body);
  wrap.querySelector('.section-head').appendChild(runBtn);

  const say = (text, kind = '') => {
    status.textContent = '';
    status.className = 'band-status' + (kind ? ' is-' + kind : '');
    status.appendChild(el('span', { text }));
  };

  function consentDialog() {
    return new Promise((resolve) => {
      dialog({
        title: 'Look this artist up online?',
        width: 520,
        body: el('div', {},
          el('p', { class: 'muted', text: 'Sonora is offline by design. Turning this on sends one thing to two public services, and only when you ask for it:' }),
          el('ul', { class: 'band-consent' },
            el('li', { text: 'The artist name — to MusicBrainz, for biography, line-up and discography.' }),
            el('li', { text: 'The matching page title — to Wikipedia, for the summary paragraph.' }),
            el('li', { text: 'Nothing else. Not your library, not your listening history, not a file name.' })),
          el('p', { class: 'muted small', text: 'Answers are cached on this device for 30 days, and you can clear them or switch this off again in Settings.' })),
        actions: [
          { label: 'Not now', onSelect: () => resolve(false) },
          { label: 'Enable lookups', primary: true, onSelect: () => resolve(true) },
        ],
      });
    });
  }

  async function start() {
    if (!band.isEnabled()) {
      const ok = await consentDialog();
      if (!ok) return;
      band.setEnabled(true);
    }
    if (!band.isOnline()) { say('No connection — this needs the internet.', 'warn'); return; }

    runBtn.disabled = true;
    say('Looking up ' + artistName + '…');
    try {
      const data = await band.analyseArtist(artistName);
      status.textContent = '';
      paint(data);
    } catch (err) {
      const why = {
        offline: 'No connection — this needs the internet.',
        'not-found': `Nothing found online for “${artistName}”.`,
        consent: 'Online lookups are switched off.',
      }[err.message] || 'Lookup failed — the service may be busy. Try again in a moment.';
      say(why, 'warn');
    } finally {
      runBtn.disabled = false;
    }
  }

  function paint(data) {
    body.textContent = '';
    runBtn.innerHTML = ico('refresh') + '<span>Refresh</span>';

    const card = (title, ...kids) => {
      const c = el('article', { class: 'band-card' },
        el('h3', { class: 'band-card-title label', text: title }));
      c.append(...kids.filter(Boolean));
      return c;
    };

    /* --- biography ---------------------------------------------------- */
    const bio = data.bio?.extract
      ? el('p', { class: 'band-text', text: data.bio.extract })
      : el('p', { class: 'band-text muted', text: 'No summary available for this artist.' });
    const bioCard = card('Biography', bio,
      data.bio?.url ? el('a', { class: 'link-btn', href: data.bio.url, target: '_blank', rel: 'noreferrer noopener', text: 'Read on Wikipedia' }) : null);

    /* --- activity ----------------------------------------------------- */
    const facts = el('dl', { class: 'info-grid band-facts' });
    const fact = (k, v) => { if (!v) return; facts.append(el('dt', { text: k }), el('dd', { text: String(v) })); };
    fact('Type', data.type);
    fact('From', data.area);
    fact('Began', data.began);
    fact(data.ended ? 'Ended' : 'Status', data.ended || (data.active ? 'Active' : 'Unknown'));
    fact('Tags', data.tags.join(', '));
    const activityCard = card('Activity', facts);

    /* --- discography -------------------------------------------------- */
    const list = el('div', { class: 'band-list' });
    const owned = new Map(lib.state.albums.map((a) => [a.title.toLowerCase(), a]));
    for (const rel of data.releases) {
      const mine = owned.get(rel.title.toLowerCase());
      const row = el('div', { class: 'band-row' + (mine ? ' is-owned' : '') },
        el('span', { class: 'band-row-year mono', text: rel.year || '—' }),
        el('span', { class: 'band-row-title', text: rel.title }),
        el('span', { class: 'chip', text: rel.type }),
        mine
          ? el('button', {
              class: 'icon-btn sm', title: 'Play from your library', 'aria-label': `Play ${rel.title}`,
              html: ico('play'), onclick: () => playAll(mine.tracks, 0, { type: 'album', key: mine.key, label: mine.title }),
            })
          : el('button', {
              class: 'icon-btn sm', title: 'Analyse this record', 'aria-label': `Analyse ${rel.title}`,
              html: ico('info'), onclick: (e) => deepen(e.currentTarget, rel),
            }));
      if (mine) row.addEventListener('dblclick', () => (location.hash = '#/album/' + mine.key));
      list.appendChild(row);
    }
    const discCard = card('Discography', data.releases.length ? list
      : el('p', { class: 'band-text muted', text: 'No releases listed.' }));

    /* --- people and links --------------------------------------------- */
    const people = el('div', { class: 'band-chips' });
    for (const m of data.members) people.appendChild(el('span', { class: 'chip', text: m.name + (m.ended ? ' (past)' : '') }));
    for (const l of data.links) {
      people.appendChild(el('a', {
        class: 'chip band-link', href: l.url, target: '_blank', rel: 'noreferrer noopener',
        text: l.label,
      }));
    }
    const peopleCard = card('Line-up and links',
      people.children.length ? people : el('p', { class: 'band-text muted', text: 'Nothing listed.' }));

    body.append(bioCard, activityCard, discCard, peopleCard);
    body.appendChild(el('p', { class: 'band-source small faint',
      text: 'Data from MusicBrainz and Wikipedia · cached on this device' }));
    enter(body.children, { each: 60, y: 12 });
  }

  /** One record, looked at more closely, on demand. */
  async function deepen(btn, rel) {
    btn.disabled = true;
    try {
      const detail = await band.analyseRelease(artistName, rel.title);
      const bits = [detail.type, ...(detail.secondary || []), detail.year && 'First released ' + detail.year]
        .filter(Boolean).join(' · ');
      const row = btn.closest('.band-row');
      row.appendChild(el('span', { class: 'band-row-detail small faint', text: bits || 'No further detail' }));
      btn.remove();
    } catch {
      toast('Could not analyse that record');
      btn.disabled = false;
    }
  }

  // Anything already cached appears without a request being made.
  band.peek('artist:' + artistName.toLowerCase()).then((hit) => {
    if (hit?.data) paint(hit.data);
    else if (!band.isEnabled()) say('Off by default. Nothing is fetched until you ask.');
    else if (!band.isOnline()) say('Offline — connect to look this artist up.');
    else say('Not looked up yet.');
  });

  return wrap;
}

/* ------------------------------------------------------------------ SETTINGS */
