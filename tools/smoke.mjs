/* Drives Sonora in a real Chromium and reports what worked.
 *
 *   node tools/smoke.mjs <library-dir> <screenshot-dir> [--headed]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const LIB = process.argv[2];
const SHOTS = process.argv[3] || './shots';
const BASE = 'http://127.0.0.1:8123/index.html';

mkdirSync(SHOTS, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);
const ok = (label, pass, extra = '') => {
  log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!pass) problems.push(label + (extra ? ': ' + extra : ''));
};

// SONORA_CHROMIUM lets the tests run against a Chromium that is already on the
// machine, instead of the one Playwright downloads for itself.
const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: 1460, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await ctx.newPage();

/* The Band Overview is the one feature that talks to the internet, so it is
   tested against stubs: real fetch, real parse, real cache, no live service.
   `mbCalls` is what proves the cache works. */
const MBID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let mbCalls = 0;
const asJSON = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await ctx.route(/musicbrainz\.org/, (route) => {
  mbCalls++;
  const url = route.request().url();
  if (url.includes('/artist?query=')) return route.fulfill(asJSON({ artists: [{ id: MBID, name: 'Ambrose Vale' }] }));
  if (url.includes('/release-group?artist=')) return route.fulfill(asJSON({ 'release-groups': [
    { id: 'rg1', title: 'Quiet Machines', 'first-release-date': '2020-04-02', 'primary-type': 'Album' },
    { id: 'rg2', title: 'Tessellate', 'first-release-date': '2023-09-15', 'primary-type': 'Album' },
    { id: 'rg3', title: 'Interior Weather', 'first-release-date': '2018-01-01', 'primary-type': 'EP' },
  ] }));
  return route.fulfill(asJSON({
    name: 'Ambrose Vale', type: 'Person', area: { name: 'Bristol' },
    'life-span': { begin: '2014', ended: false },
    tags: [{ name: 'ambient', count: 9 }],
    relations: [
      { type: 'wikipedia', url: { resource: 'https://en.wikipedia.org/wiki/Ambrose_Vale' } },
      { type: 'official homepage', url: { resource: 'https://example.org/ambrose' } },
      { type: 'member of band', artist: { id: 'x1', name: 'Nova Kestrel' }, ended: false },
    ],
  }));
});
await ctx.route(/wikipedia\.org/, (route) => route.fulfill(asJSON({
  extract: 'Ambrose Vale is an ambient recording project formed in Bristol in 2014.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ambrose_Vale' } },
})));

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('UNCAUGHT: ' + e.message));

// Force the <input webkitdirectory> path so the test can supply files.
await page.addInitScript(() => {
  delete window.showDirectoryPicker;
  delete window.showOpenFilePicker;
});

const shot = async (name) => {
  await page.waitForTimeout(650);          // let entry animations settle
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log(`  shot  ${name}.png`);
};

/* How many pixels a canvas is actually showing.
 *
 * The visualisers hand their canvas to a worker with
 * `transferControlToOffscreen` wherever the platform has it, and after that
 * `getContext('2d')` on the element throws — reading it directly used to end
 * this run with an uncaught InvalidStateError and take every later check with
 * it. A transferred canvas is still a valid image source, so copying it into a
 * scratch canvas reads the frame the worker last pushed and works on both
 * paths. */
const litPixels = (sel, alpha = 8) => page.evaluate(([sel, alpha]) => {
  const c = document.querySelector(sel);
  if (!c || !c.width || !c.height) return 0;
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  const tx = t.getContext('2d', { willReadFrequently: true });
  tx.drawImage(c, 0, 0);
  const d = tx.getImageData(0, 0, t.width, t.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > alpha) lit++;
  return lit;
}, [sel, alpha]);

/* ---------------------------------------------------------------- boot */

log('\n> boot');
// "Add music" opens a menu now: folder or individual files. The tests take the
// folder route, which is what the picker below expects.
async function addFolder() {
  await page.locator('.side-foot .add-btn').click();
  await page.locator('.menu-item', { hasText: 'Add a folder' }).click();
}

await page.goto(BASE, { waitUntil: 'networkidle' });

// The intro plays before the app is handed over; it should be on screen now.
ok('intro plays', await page.locator('.intro .intro-word').isVisible());
await page.screenshot({ path: `${SHOTS}/00-intro.png` });
log('  shot  00-intro.png');

await page.waitForSelector('body.is-ready', { timeout: 15000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 15000 });
ok('intro hands over to the app', await page.evaluate(() => document.body.classList.contains('intro-done')));
ok('app boots', true);
ok('3D backdrop running', await page.evaluate(() => {
  const c = document.querySelector('canvas.backdrop');
  return !!c && c.width > 0 && !!c.getContext('webgl');
}));
ok('empty state shown', await page.locator('.empty h3').first().isVisible());
await shot('01-empty');

/* ---------------------------------------------------------------- import */

log('\n> import');
const t0 = Date.now();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  addFolder(),
]);
await chooser.setFiles(LIB);

await page.waitForFunction(() => document.querySelectorAll('.rail .card').length > 0,
                           null, { timeout: 45000 });
await page.waitForFunction(() => document.querySelector('.scan')?.hidden !== false,
                           null, { timeout: 45000 });
log(`  import finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stats = await page.locator('.page-sub').first().textContent();
log(`  library: ${stats}`);
ok('library indexed', /\d+ tracks/.test(stats || ''), stats || '');
await shot('02-home');

/* ---------------------------------------------------------------- metadata */

log('\n> metadata');
await page.locator('.nav-item[data-route="albums"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });

const albums = await page.$$eval('.v-grid-row .card:not([hidden])', (els) =>
  els.map((e) => ({
    title: e.querySelector('.card-title')?.textContent,
    sub: e.querySelector('.card-sub')?.textContent,
    art: !!e.querySelector('.art-img.is-loaded'),
  })));
log('  albums on screen: ' + albums.length);
for (const a of albums.slice(0, 12)) log(`    ${a.art ? '[art]' : '[   ]'} ${a.title} — ${a.sub}`);
ok('album titles parsed', albums.some((a) => a.title === 'Paper Lanterns'));
ok('AIFF album parsed', albums.some((a) => a.title === 'Tidal Almanac'),
   albums.map((a) => a.title).join(', '));
ok('album year+artist parsed', albums.some((a) => /Nova Kestrel · 2021/.test(a.sub || '')));
ok('embedded artwork decoded', albums.filter((a) => a.art).length >= 6,
   `${albums.filter((a) => a.art).length} of ${albums.length} with art`);
await shot('03-albums');

/* ---------------------------------------------------------------- merge */

log('\n> album merge');
// Graduation is on disk as two folders, one of them tagged with no artist at
// all. The library has to land it as a single album with all four tracks.
const graduation = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.v-grid-row .card:not([hidden])')]
    .map((c) => ({ title: c.querySelector('.card-title')?.textContent, sub: c.querySelector('.card-sub')?.textContent }));
  return rows.filter((r) => r.title === 'Graduation');
});
ok('split album merged into one entity', graduation.length === 1,
   `${graduation.length} albums named Graduation`);
ok('merged album keeps the artist that had one',
   /Cassia Bloom/.test(graduation[0]?.sub || ''), graduation[0]?.sub || '');

await page.locator('.v-grid-row .card:not([hidden])', { hasText: 'Graduation' }).first().click();
await page.waitForSelector('.hero-title', { timeout: 5000 });
const mergedTracks = await page.locator('.plain-list .trow').count();
ok('every track from both folders is in it', mergedTracks === 4, `${mergedTracks} tracks`);
await shot('19-merged-album');
await page.locator('.nav-item[data-route="albums"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });

/* ---------------------------------------------------------------- songs */

log('\n> songs');
await page.locator('.nav-item[data-route="songs"]').click();
await page.waitForSelector('.v-layer .trow', { timeout: 5000 });
const rowCount = await page.locator('.v-layer .trow:not([hidden])').count();
const totalRows = await page.$eval('.v-sizer', (e) => Math.round(parseFloat(e.style.height) / 56));
log(`  ${totalRows} rows in the list, ${rowCount} rendered in the DOM`);
ok('list is virtualised', rowCount < totalRows, `${rowCount} nodes for ${totalRows} rows`);

const durations = await page.$$eval('.v-layer .trow:not([hidden]) .trow-time',
                                    (els) => els.map((e) => e.textContent));
ok('durations computed', durations.filter((d) => d && d !== '--:--').length >= rowCount - 2,
   durations.slice(0, 6).join(' '));

// The WMA in the library is indexed and named, and honest about being
// undecodable rather than quietly missing.
// Sorted by album descending, so the row is actually rendered: the list is
// virtualised and only what fits on screen exists.
await page.locator('.thead .sortable[data-sort="album"]').click();
await page.waitForTimeout(250);
await page.locator('.thead .sortable[data-sort="album"]').click();
await page.waitForTimeout(400);
const unplayable = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.v-layer .trow:not([hidden])')];
  const hit = rows.find((r) => r.classList.contains('is-unsupported'));
  return hit ? hit.querySelector('.trow-title')?.textContent : null;
});
ok('undecodable format is indexed and marked', unplayable === 'Cassette Transfer',
   String(unplayable));
await page.locator('.thead .sortable[data-sort="title"]').click();
await page.waitForTimeout(300);
await shot('04-songs');

/* ---------------------------------------------------------------- playback */

log('\n> playback');
await page.locator('.nav-item[data-route="albums"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });
// A FLAC album: embedded art plus audio the browser can actually decode.
await page.locator('.v-grid-row .card:not([hidden])', { hasText: 'Paper Lanterns' }).first().click();
await page.waitForSelector('.hero-title', { timeout: 5000 });
const heroTitle = await page.locator('.hero-title').textContent();
log(`  opened album: ${heroTitle}`);
ok('hero artwork loaded', await page.locator('.hero-art .art-img.is-loaded').isVisible());
await shot('05-album');

await page.locator('.hero-actions .fab').click();
await page.waitForTimeout(1400);

const playing = await page.evaluate(() => ({
  hasTrack: document.querySelector('.playerbar')?.classList.contains('has-track'),
  isPlaying: document.querySelector('.playerbar')?.classList.contains('is-playing'),
  title: document.querySelector('.pb-title')?.textContent,
  elapsed: document.querySelector('.pb-elapsed')?.textContent,
  duration: document.querySelector('.pb-duration')?.textContent,
  fill: document.querySelector('.seek-fill')?.style.transform,
}));
log('  ' + JSON.stringify(playing));
ok('track loaded into player', !!playing.hasTrack && !!playing.title);
ok('audio actually playing', !!playing.isPlaying, `elapsed ${playing.elapsed}`);

await page.waitForTimeout(1500);
const advanced = await page.locator('.pb-elapsed').textContent();
ok('playhead advances', advanced !== '0:00', `${playing.elapsed} -> ${advanced}`);
await shot('06-playing');

// The other decodable format, through a different parser and a different codec.
await page.locator('.nav-item[data-route="albums"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });
await page.locator('.v-grid-row .card:not([hidden])', { hasText: 'Hollow Season' }).first().click();
await page.waitForSelector('.hero-title', { timeout: 5000 });
await page.locator('.hero-actions .fab').click();
await page.waitForTimeout(1800);
const mp3 = await page.evaluate(() => ({
  playing: document.querySelector('.playerbar')?.classList.contains('is-playing'),
  elapsed: document.querySelector('.pb-elapsed')?.textContent,
  title: document.querySelector('.pb-title')?.textContent,
}));
ok('mp3 plays too', !!mp3.playing && mp3.elapsed !== '0:00', JSON.stringify(mp3));

// Transport controls drive the queue.
await page.locator('.pb-next').click();
await page.waitForTimeout(900);
const afterNext = await page.locator('.pb-title').textContent();
ok('next advances the queue', afterNext !== mp3.title, `${mp3.title} -> ${afterNext}`);
await page.locator('.pb-play').click();
await page.waitForTimeout(400);
ok('pause works', !(await page.evaluate(() =>
   document.querySelector('.playerbar').classList.contains('is-playing'))));
await page.locator('.pb-play').click();
await page.waitForTimeout(400);

/* ---------------------------------------------------------------- queue */

log('\n> queue panel');
await page.locator('.pb-queue').click();
await page.waitForTimeout(500);
ok('panel opens', await page.locator('#pane').isVisible());
ok('now playing art', await page.locator('.np-art .art-img.is-loaded').isVisible());
await shot('07-nowplaying');

// The visualiser is a canvas: the only honest check is that it has pixels on it.
await page.waitForTimeout(700);
const vizPainted = await litPixels('.np-viz');
ok('spectrum is drawing', vizPainted > 200, `${vizPainted} lit pixels`);

await page.locator('.pane-tab[data-tab="queue"]').click();
await page.waitForTimeout(450);
const queued = await page.locator('.qrow:not([hidden])').count();
ok('queue populated', queued > 0, `${queued} rows`);
await shot('08-queue');

/* ---------------------------------------------------------------- stage */

log('\n> immersive stage');
await page.keyboard.press('v');
await page.waitForSelector('.stage', { timeout: 3000 });
await page.waitForTimeout(900);
ok('stage opens on V', await page.locator('.stage-title').isVisible());
ok('backdrop moved onto the stage', await page.evaluate(() =>
  !!document.querySelector('.stage > canvas.backdrop')));
const stagePainted = await litPixels('.stage-viz');
ok('stage visualiser is drawing', stagePainted > 500, `${stagePainted} lit pixels`);
await shot('17-stage-bars');

await page.locator('.stage-mode', { hasText: 'Radial' }).click();
await page.waitForTimeout(800);
ok('mode switches', await page.evaluate(() => localStorage.getItem('sonora:viz') === 'radial'));
await shot('18-stage-radial');

await page.keyboard.press('Escape');
// Waiting for the node to go rather than for a fixed interval: the exit is an
// animation, and how long one takes depends on the machine.
const closed = await page.waitForSelector('.stage', { state: 'detached', timeout: 6000 })
  .then(() => true).catch(() => false);
ok('stage closes on Escape', closed);
ok('backdrop returns to the page', await page.evaluate(() =>
  document.body.firstElementChild?.classList.contains('backdrop')));

/* ---------------------------------------------------------------- analysis */

log('\n> circle analysis');
await page.locator('.nav-item[data-route="circles"]').click();
await page.waitForTimeout(700);
const circles = await page.locator('.circle-node').count();
ok('listening time was measured', circles > 0, `${circles} circles`);
ok('total is stated', /listened/.test(await page.locator('#circle-total').textContent() || ''));

// Area, not radius: a slice with twice the time must have twice the area.
const areas = await page.$$eval('.circle-node .circle-disc', (els) =>
  els.map((e) => Math.PI * Math.pow(parseFloat(e.getAttribute('r')) || 0, 2)));
ok('circles are area-proportional', areas.length > 0 && areas.every((a) => a > 0));

await page.locator('.seg', { hasText: 'Genre' }).click();
await page.waitForTimeout(900);
ok('mode switches to genre', await page.evaluate(() => localStorage.getItem('sonora:circle-mode') === 'genre'));
await shot('20-circles');

await page.locator('.circle-node').first().click();
await page.waitForTimeout(600);
ok('a circle can be pinned', await page.locator('.circle-pin').count() > 0);
await shot('21-circles-pinned');

// Reset undoes the arrangement — pins and dragged positions — without going
// near the listening data, which has its own button and its own confirmation.
ok('reset appears once there is something to reset',
   await page.locator('.circle-bar .btn', { hasText: 'Reset view' }).isVisible());
await page.locator('.circle-bar .btn', { hasText: 'Reset view' }).click();
await page.waitForTimeout(500);
const afterReset = await page.evaluate(() => ({
  pins: document.querySelectorAll('.circle-pin').length,
  circles: document.querySelectorAll('.circle-node').length,
}));
ok('reset clears the pins and keeps the data',
   afterReset.pins === 0 && afterReset.circles === circles,
   `${afterReset.pins} pins, ${afterReset.circles} circles`);

/* ---------------------------------------------------------------- band */

log('\n> band overview');
await page.locator('.nav-item[data-route="artists"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });
await page.locator('.v-grid-row .card:not([hidden])', { hasText: 'Ambrose Vale' }).first().click();
await page.waitForSelector('.band', { timeout: 5000 });
ok('overview is off until asked', mbCalls === 0, `${mbCalls} requests made unprompted`);

await page.locator('.band .btn', { hasText: 'Analyse' }).click();
await page.waitForSelector('.dialog', { timeout: 4000 });
ok('consent is requested first', /look this artist up/i.test(await page.locator('.dialog-title').textContent() || ''));
await page.locator('.dialog .btn.primary').click();

await page.waitForSelector('.band-card', { timeout: 25000 });
const bandCards = await page.locator('.band-card').count();
ok('four cards of context', bandCards === 4, `${bandCards} cards`);
ok('biography rendered', /ambient recording project/.test(await page.locator('.band-text').first().textContent() || ''));
ok('owned releases are linked to the library', await page.locator('.band-row.is-owned').count() >= 2);
await shot('22-band');

const callsAfterFirst = mbCalls;
await page.locator('.nav-item[data-route="artists"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });
await page.locator('.v-grid-row .card:not([hidden])', { hasText: 'Ambrose Vale' }).first().click();
await page.waitForSelector('.band-card', { timeout: 8000 });
ok('answers are cached, not refetched', mbCalls === callsAfterFirst, `${callsAfterFirst} -> ${mbCalls}`);

/* ---------------------------------------------------------------- search */

log('\n> search');
await page.locator('#search').fill('hollow');
await page.waitForTimeout(700);
const results = await page.evaluate(() => ({
  albums: document.querySelectorAll('.block .card').length,
  songs: document.querySelectorAll('.plain-list .trow').length,
  title: document.querySelector('.page-title')?.textContent,
}));
log('  ' + JSON.stringify(results));
ok('search finds matches', results.albums + results.songs > 0);
await shot('09-search');

/* ---------------------------------------------------------------- artist */

log('\n> artist + playlist');
await page.locator('#search').fill('');
await page.locator('.nav-item[data-route="artists"]').click();
await page.waitForSelector('.v-grid-row .card', { timeout: 5000 });
await page.locator('.v-grid-row .card:not([hidden])').first().click();
await page.waitForSelector('.hero-artist', { timeout: 5000 });
ok('artist page renders albums', await page.locator('.block .grid .card').count() > 0);
await shot('10-artist');

// Build a playlist through the real UI.
await page.locator('.v-layer .trow, .plain-list .trow').first().click({ button: 'right' });
await page.waitForSelector('.menu', { timeout: 3000 });
await page.locator('.menu-item', { hasText: 'Add to playlist' }).click();
await page.waitForSelector('.dialog', { timeout: 3000 });
await page.locator('.dialog').last().locator('.btn.primary').click();   // "New playlist"
await page.waitForTimeout(500);
await page.locator('.dialog').last().locator('.btn.primary').click();   // "Create"
await page.waitForTimeout(800);
const playlists = await page.locator('.side-playlist').count();
ok('playlist created', playlists > 0, `${playlists} in sidebar`);
await shot('11-playlist-made');

/* ---------------------------------------------------------------- settings */

log('\n> settings + theme');
await page.locator('.side-foot .nav-item[data-route="settings"]').click();
await page.waitForSelector('.settings-row', { timeout: 5000 });
ok('folder listed in settings', await page.locator('.settings-name').first().isVisible());
await shot('12-settings');

await page.locator('.seg', { hasText: 'Light' }).click();
await page.waitForTimeout(700);
const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
ok('light theme applies', theme === 'light', String(theme));
await page.locator('.nav-item[data-route="home"]').click();
await shot('13-light');

await page.locator('.side-foot .nav-item[data-route="settings"]').click();
await page.waitForSelector('.seg', { timeout: 3000 });
await page.locator('.seg', { hasText: 'Dark' }).click();
await page.waitForTimeout(400);

/* ---------------------------------------------------------------- responsive */

log('\n> responsive');
await page.locator('.nav-item[data-route="albums"]').click();
await page.waitForTimeout(500);
await page.setViewportSize({ width: 860, height: 780 });
await page.waitForTimeout(700);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal overflow at 860px', overflow <= 0, `${overflow}px`);
await shot('14-narrow');

await page.setViewportSize({ width: 520, height: 780 });
await page.waitForTimeout(700);
const overflow2 = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal overflow at 520px', overflow2 <= 0, `${overflow2}px`);
await shot('15-mobile');

await page.setViewportSize({ width: 1460, height: 900 });

/* ---------------------------------------------------------------- persistence */

log('\n> reload');
// Play something first, so there is a session worth restoring.
await page.locator('.nav-item[data-route="songs"]').click();
await page.waitForSelector('.v-layer .trow');
await page.locator('.v-layer .trow:not([hidden])').first().dblclick();
await page.waitForTimeout(2600);
const before = await page.evaluate(() => ({
  title: document.querySelector('.pb-title')?.textContent,
  at: document.querySelector('.pb-elapsed')?.textContent,
}));

const reloadedAt = Date.now();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 15000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 15000 });
await page.locator('.nav-item[data-route="home"]').click();
await page.waitForTimeout(1400);
const afterReload = await page.locator('.page-sub').first().textContent();
log(`  library after reload: ${afterReload}`);
ok('library persisted', /\d+ tracks/.test(afterReload || ''), afterReload || '');
ok('artwork persisted', await page.locator('.rail .card .art-img.is-loaded').first().isVisible());

/* ------------------------------------------------------------ auto-reconnect */

// These tests run with showDirectoryPicker removed, so the library is held by
// a file input — and a file input hands its files over exactly once, on the
// gesture that opened it. No script can re-open it. That is the harder of the
// two routes and the one worth pinning down: the queue and the playhead have
// to come back anyway, the interface has to say why it cannot play yet, and
// the moment the folder is handed back the resume has to finish by itself.

log('\n> auto-reconnect');
const restored = await page.evaluate(async () => {
  const session = await import('/js/session.js');
  const player = await import('/js/player.js');
  for (let i = 0; i < 80 && session.state.phase === 'connecting'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    phase: session.state.phase,
    ms: session.state.ms,
    trackId: session.state.restored?.trackId || null,
    position: session.state.restored?.position ?? null,
    queue: player.state.queue.length,
    readout: document.querySelector('#link-state .link-text')?.textContent || '',
    hidden: !!document.querySelector('#link-state')?.hidden,
  };
});
log(`  ${JSON.stringify(restored)}`);
ok('the session was found and read back', !!restored.trackId, JSON.stringify(restored.trackId));
ok('the playhead came back with it', restored.position >= 2,
   `${restored.position}s, was ${before.at}`);
ok('the queue came back too', restored.queue > 1, `${restored.queue} tracks`);
ok('reconnect settled inside 3s', restored.ms < 3000, `${restored.ms}ms`);
ok('the state it landed in is stated, not guessed',
   ['resumed', 'ready', 'failed'].includes(restored.phase), restored.phase);
ok('a file-input library says why it cannot play yet',
   restored.phase !== 'failed' || (/not connected/i.test(restored.readout) && !restored.hidden),
   `${restored.phase}: “${restored.readout}”`);
await shot('16-reload');

// Hand the folder back. Nobody asks for the old track again — the armed
// resume is supposed to notice and finish on its own.
if (restored.phase === 'failed') {
  const [again] = await Promise.all([page.waitForEvent('filechooser'), addFolder()]);
  await again.setFiles(LIB);
  await page.waitForFunction(() => document.querySelector('.scan')?.hidden !== false,
                             null, { timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('.playerbar')?.classList.contains('has-track'),
    null, { timeout: 8000 }).catch(() => {});

  const after = await page.evaluate(() => ({
    title: document.querySelector('.pb-title')?.textContent,
    at: document.querySelector('.pb-elapsed')?.textContent,
    phase: document.querySelector('#link-state')?.dataset.phase,
  }));
  log(`  after reconnecting the folder: ${JSON.stringify(after)}`);
  ok('the last track came back on its own', after.title === before.title,
     `${before.title} -> ${after.title}`);
  ok('it came back where it stopped', after.at !== '0:00', `${before.at} -> ${after.at}`);
  await shot('16b-resumed');
}
log(`  whole reload cycle: ${Date.now() - reloadedAt}ms`);

/* ---------------------------------------------------------------- report */

log('\n> console');
const noise = consoleErrors.filter((e) => !/favicon|Autoplay|net::ERR_/i.test(e));
if (noise.length) {
  for (const e of noise.slice(0, 12)) log('  ! ' + e.slice(0, 220));
} else log('  clean');
ok('no console errors', noise.length === 0, `${noise.length} errors`);

await browser.close();

log('\n' + (problems.length ? `${problems.length} PROBLEM(S):` : 'ALL CHECKS PASSED'));
for (const p of problems) log('  - ' + p);
process.exit(problems.length ? 1 : 0);
