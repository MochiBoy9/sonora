/* band.js — the one part of Sonora that talks to the internet.
 *
 * Everything else in this app is local by construction, so this module is
 * built to be the exception that proves it:
 *
 *   · off until switched on, and switching it on requires reading what leaves
 *     the device (an artist name, an album title — nothing else, ever)
 *   · one request per second, because that is what MusicBrainz asks for
 *   · every answer cached in IndexedDB for a month, so the second look at an
 *     artist costs nothing and works on a plane
 *   · no key, no account, no third-party script: MusicBrainz and Wikipedia's
 *     REST endpoints, both CORS-enabled and both public
 *
 * If the network is missing, slow, or says no, the panel says so and the rest
 * of the app carries on exactly as before.
 */

import * as db from './db.js';
import { Emitter } from './util.js';

export const events = new Emitter();

const CONSENT_KEY = 'sonora:online';
const TTL = 30 * 24 * 60 * 60 * 1000;             // a month
const MB = 'https://musicbrainz.org/ws/2';
const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const TIMEOUT = 9000;

export const isEnabled = () => {
  try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
};

export function setEnabled(on) {
  try { localStorage.setItem(CONSENT_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  events.emit('consent', !!on);
}

export const isOnline = () => (typeof navigator.onLine === 'boolean' ? navigator.onLine : true);

/* ------------------------------------------------------------------ plumbing */

/**
 * One request at a time, at most one per second.
 *
 * MusicBrainz publishes a rate limit and enforces it with 503s; a burst of
 * lookups from a library page would earn a block for everyone behind the same
 * address. The queue is the polite version and costs nothing that matters,
 * because results are cached.
 *
 * It wraps single requests only. A queued task that awaits another queued task
 * waits for a link in a chain it is itself holding up, and the whole thing
 * stops forever — so orchestration stays outside, and only leaves go in.
 */
let chain = Promise.resolve();
let lastCall = 0;

function queued(fn) {
  const run = async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  };
  chain = chain.then(run, run);
  return chain;
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      cache: 'default',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ cache */

async function cached(key, produce) {
  const hit = await db.getBand(key).catch(() => null);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await produce();
  db.putBand({ key, data, at: Date.now() }).catch(() => {});
  return data;
}

/** Anything we know already, without touching the network. */
export const peek = (key) => db.getBand(key).catch(() => null);

export const clearCache = () => db.clearBands().catch(() => {});

/* ------------------------------------------------------------------ lookups */

/**
 * Everything the Band Overview shows, in one object:
 *
 *   { name, mbid, disambiguation, area, began, ended, tags[],
 *     bio: { extract, url }, releases: [{ title, year, type, mbid }],
 *     members: [{ name, mbid }], links: [{ label, url }] }
 */
export async function analyseArtist(name) {
  if (!isEnabled()) throw new Error('consent');
  if (!isOnline()) throw new Error('offline');
  const key = 'artist:' + name.toLowerCase();

  return cached(key, async () => {
    const found = await queued(() => getJSON(
      `${MB}/artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`));
    const hit = found?.artists?.[0];
    if (!hit) throw new Error('not-found');

    const full = await queued(() => getJSON(
      `${MB}/artist/${hit.id}?inc=url-rels+tags+artist-rels&fmt=json`));

    const groups = await queued(() => getJSON(
      `${MB}/release-group?artist=${hit.id}&type=album|ep&fmt=json&limit=25`)).catch(() => null);

    const links = (full['relations'] || [])
      .filter((r) => r.url?.resource)
      .map((r) => ({ label: r.type, url: r.url.resource }));

    const wikiURL = links.find((l) => /wikipedia/.test(l.url))?.url;
    const bio = wikiURL ? await wikipedia(wikiURL).catch(() => null) : null;

    const members = (full['relations'] || [])
      .filter((r) => r.type === 'member of band' && r.artist)
      .map((r) => ({ name: r.artist.name, mbid: r.artist.id, ended: !!r.ended }));

    return {
      name: full.name || hit.name,
      mbid: hit.id,
      disambiguation: full.disambiguation || '',
      type: full.type || '',
      area: full.area?.name || full['begin-area']?.name || '',
      began: full['life-span']?.begin || '',
      ended: full['life-span']?.end || '',
      active: full['life-span']?.ended === false,
      tags: (full.tags || []).sort((a, b) => b.count - a.count).slice(0, 8).map((t) => t.name),
      bio,
      releases: (groups?.['release-groups'] || [])
        .map((g) => ({
          title: g.title,
          year: (g['first-release-date'] || '').slice(0, 4),
          type: g['primary-type'] || 'Album',
          mbid: g.id,
        }))
        .sort((a, b) => (b.year || '').localeCompare(a.year || ''))
        .slice(0, 12),
      members: members.slice(0, 12),
      links: links.filter((l) => !/wikidata/.test(l.url)).slice(0, 8),
      fetchedAt: Date.now(),
    };
  });
}

/** A closer look at one record, on request rather than on principle. */
export async function analyseRelease(artistName, title) {
  if (!isEnabled()) throw new Error('consent');
  if (!isOnline()) throw new Error('offline');
  const key = `release:${artistName.toLowerCase()}::${title.toLowerCase()}`;

  return cached(key, async () => {
    const q = `releasegroup:"${title}" AND artist:"${artistName}"`;
    const found = await queued(() => getJSON(
      `${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=1`));
    const g = found?.['release-groups']?.[0];
    if (!g) throw new Error('not-found');
    return {
      title: g.title,
      year: (g['first-release-date'] || '').slice(0, 4),
      type: g['primary-type'] || '',
      secondary: g['secondary-types'] || [],
      rating: g.rating?.value || null,
      mbid: g.id,
      artist: g['artist-credit']?.map((a) => a.name).join(', ') || artistName,
    };
  });
}

async function wikipedia(pageURL) {
  const title = decodeURIComponent(String(pageURL).split('/wiki/')[1] || '').split('#')[0];
  if (!title) return null;
  const data = await queued(() => getJSON(WIKI + encodeURIComponent(title)));
  if (!data || data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') return null;
  return {
    extract: data.extract || '',
    url: data.content_urls?.desktop?.page || pageURL,
    thumb: data.thumbnail?.source || '',
  };
}
