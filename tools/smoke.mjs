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

/* ---------------------------------------------------------------- boot */

log('\n> boot');
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
  page.locator('.side-foot .add-btn').click(),
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
const vizPainted = await page.evaluate(async () => {
  const c = document.querySelector('.np-viz');
  if (!c || !c.width) return 0;
  await new Promise((r) => setTimeout(r, 700));
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
  return lit;
});
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
const stagePainted = await page.evaluate(() => {
  const c = document.querySelector('.stage-viz');
  if (!c || !c.width) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
  return lit;
});
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
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 15000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 15000 });
await page.locator('.nav-item[data-route="home"]').click();
await page.waitForTimeout(1400);
const afterReload = await page.locator('.page-sub').first().textContent();
log(`  library after reload: ${afterReload}`);
ok('library persisted', /\d+ tracks/.test(afterReload || ''), afterReload || '');
ok('artwork persisted', await page.locator('.rail .card .art-img.is-loaded').first().isVisible());
await shot('16-reload');

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
