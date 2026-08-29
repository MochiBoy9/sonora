/* Exercises the controls a smoke test can't reach: keyboard shortcuts,
 * dragging the scrubber and the volume slider, column sorting, repeat modes,
 * queue editing and folder removal.
 *
 *   node tools/interactions.mjs <library-dir>
 */

import { chromium } from 'playwright';

const LIB = process.argv[2];
const problems = [];
const ok = (label, pass, extra = '') => {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!pass) problems.push(label + (extra ? ': ' + extra : ''));
};

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1460, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript(() => { delete window.showDirectoryPicker; });
// "Add music" opens a menu now: folder or individual files. The tests take the
// folder route, which is what the picker below expects.
async function addFolder() {
  await page.locator('.side-foot .add-btn').click();
  await page.locator('.menu-item', { hasText: 'Add a folder' }).click();
}

await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 15000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 15000 });

const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  addFolder(),
]);
await chooser.setFiles(LIB);
await page.waitForFunction(() => document.querySelector('.scan')?.hidden === false, null, { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.scan')?.hidden === true, null, { timeout: 120000 });
await page.waitForTimeout(600);

const bar = () => page.evaluate(() => {
  const p = document.querySelector('.playerbar');
  return {
    playing: p.classList.contains('is-playing'),
    shuffle: p.classList.contains('shuffle-on'),
    repeat: p.dataset.repeat,
    muted: p.classList.contains('is-muted'),
    title: document.querySelector('.pb-title').textContent,
    elapsed: document.querySelector('.pb-elapsed').textContent,
    duration: document.querySelector('.pb-duration').textContent,
    volume: document.querySelector('.vol').getAttribute('aria-valuenow'),
  };
});

/* ---------------------------------------------------------------- sorting */

console.log('\n> column sorting');
await page.locator('.nav-item[data-route="songs"]').click();
await page.waitForSelector('.v-layer .trow');
/** Rows are recycled nodes positioned by transform, so DOM order says nothing.
 *  Everything below reads them back in data-index order. */
const rowsInOrder = (field) => page.$$eval('.v-layer .trow:not([hidden])', (els, f) =>
  els.map((e) => ({ i: +e.dataset.index, v: e.querySelector(f)?.textContent }))
     .sort((a, b) => a.i - b.i)
     .map((r) => r.v), field);
const firstOf = async () => (await rowsInOrder('.trow-title'))[0];

const ascFirst = await firstOf();
await page.locator('.thead .sortable[data-sort="title"]').click();
await page.waitForTimeout(350);
const descFirst = await firstOf();
ok('title sort reverses', ascFirst !== descFirst, `${ascFirst} -> ${descFirst}`);

await page.locator('.thead .sortable[data-sort="album"]').click();
await page.waitForTimeout(350);
const byAlbum = (await rowsInOrder('.trow-album')).slice(0, 4);
ok('album sort groups albums', new Set(byAlbum).size <= 2, byAlbum.join(' | '));

await page.locator('.thead .sortable[data-sort="duration"]').click();
await page.waitForTimeout(350);
// A container whose length nobody could work out shows "--:--" and sorts to the
// front; it is not part of what this check is about.
const times = (await rowsInOrder('.trow-time')).slice(0, 6).filter((t) => t && t.includes(':') && !t.startsWith('-'));
const secs = times.map((t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; });
ok('duration sort ascends', secs.length >= 4 && secs.every((v, i) => i === 0 || v >= secs[i - 1]), times.join(' '));

/* ---------------------------------------------------------------- keyboard */

console.log('\n> keyboard');
await page.locator('.v-layer .trow').first().dblclick();
await page.waitForTimeout(1400);
let s = await bar();
ok('double-click plays', s.playing, s.title);

await page.locator('#view').click({ position: { x: 700, y: 700 } });   // move focus off the row
await page.keyboard.press('Space');
await page.waitForTimeout(500);
ok('space pauses', !(await bar()).playing);
await page.keyboard.press('Space');
await page.waitForTimeout(600);
ok('space resumes', (await bar()).playing);

const before = await bar();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(400);
const afterSeek = await bar();
ok('right arrow seeks forward', afterSeek.elapsed !== before.elapsed,
   `${before.elapsed} -> ${afterSeek.elapsed}`);

const v0 = +(await bar()).volume;
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(250);
const v1 = +(await bar()).volume;
ok('down arrow lowers volume', v1 < v0, `${v0} -> ${v1}`);

await page.keyboard.press('m');
await page.waitForTimeout(250);
ok('m mutes', (await bar()).muted);
await page.keyboard.press('m');
await page.waitForTimeout(200);

await page.keyboard.press('s');
await page.waitForTimeout(250);
ok('s toggles shuffle', (await bar()).shuffle);
await page.keyboard.press('s');
await page.waitForTimeout(200);

await page.keyboard.press('r');
await page.waitForTimeout(250);
ok('r cycles repeat', (await bar()).repeat === 'all');
await page.keyboard.press('r');
await page.waitForTimeout(200);
ok('r reaches repeat-one', (await bar()).repeat === 'one');
await page.keyboard.press('r');
await page.waitForTimeout(200);

const t1 = (await bar()).title;
await page.keyboard.press('n');
await page.waitForTimeout(900);
ok('n plays next', (await bar()).title !== t1, `${t1} -> ${(await bar()).title}`);
await page.keyboard.press('p');
await page.waitForTimeout(900);

await page.keyboard.press('/');
await page.waitForTimeout(250);
ok('slash focuses search', await page.evaluate(() => document.activeElement?.id === 'search'));
await page.keyboard.press('Escape');
await page.locator('#view').click({ position: { x: 700, y: 700 } });

await page.keyboard.press('q');
await page.waitForTimeout(500);
ok('q toggles the queue panel', await page.evaluate(() =>
   document.getElementById('app').classList.contains('pane-open')));
await page.keyboard.press('q');
await page.waitForTimeout(400);

/* ---------------------------------------------------------------- dragging */

console.log('\n> dragging');
const seek = await page.locator('.seek').boundingBox();
await page.mouse.move(seek.x + seek.width * 0.6, seek.y + seek.height / 2);
await page.mouse.down();
await page.mouse.move(seek.x + seek.width * 0.75, seek.y + seek.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
const scrubbed = await bar();
const [em, es] = scrubbed.elapsed.split(':').map(Number);
const [dm, ds] = scrubbed.duration.split(':').map(Number);
const ratio = (em * 60 + es) / Math.max(1, dm * 60 + ds);
ok('scrubber seeks to the drop point', ratio > 0.6 && ratio < 0.92,
   `${scrubbed.elapsed}/${scrubbed.duration} = ${(ratio * 100).toFixed(0)}%`);

const vol = await page.locator('.vol').boundingBox();
await page.mouse.move(vol.x + vol.width * 0.3, vol.y + vol.height / 2);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(300);
const vNow = +(await bar()).volume;
ok('volume slider sets level', vNow > 20 && vNow < 45, `${vNow}%`);

/* ---------------------------------------------------------------- queue edit */

console.log('\n> queue editing');
await page.locator('.pb-queue').click();
await page.locator('.pane-tab[data-tab="queue"]').click();
await page.waitForTimeout(500);
const queueLen = async () => {
  const text = await page.locator('.queue-summary').textContent();
  return parseInt(text, 10) || 0;
};
// The queue is virtualised, so the last row in the DOM is usually below the
// fold — clicking it would make Playwright scroll first, and the scroll would
// recycle the very node it was about to click. Rows that are actually on
// screen are the honest target.
const onScreen = (nth) => page.locator('.qrow:not([hidden])').nth(nth);

const qBefore = await queueLen();
await onScreen(3).hover();
await onScreen(3).locator('.qrow-remove').click();
await page.waitForTimeout(500);
const qAfter = await queueLen();
ok('remove from queue', qAfter === qBefore - 1, `${qBefore} -> ${qAfter}`);

const jumpTitle = await onScreen(4).locator('.qrow-title').textContent();
await onScreen(4).click();
await page.waitForTimeout(1000);
ok('clicking a queue row jumps to it', (await bar()).title === jumpTitle,
   `${jumpTitle} vs ${(await bar()).title}`);

/* ---------------------------------------------------------------- folders */

console.log('\n> folder removal');
await page.locator('.side-foot .nav-item[data-route="settings"]').click();
await page.waitForSelector('.settings-row');
await page.locator('.settings-actions .icon-btn').first().click();
await page.waitForSelector('.dialog');
await page.locator('.dialog .btn.danger').click();
await page.waitForTimeout(900);
await page.locator('.nav-item[data-route="home"]').click();
await page.waitForTimeout(600);
ok('removing a folder empties the library',
   await page.locator('.empty h3').first().isVisible());

/* ---------------------------------------------------------------- report */

const noise = errors.filter((e) => !/favicon|Autoplay|net::ERR_/i.test(e));
ok('no console errors', noise.length === 0, noise.slice(0, 3).join(' | '));

await browser.close();
console.log('\n' + (problems.length ? `${problems.length} PROBLEM(S)` : 'ALL INTERACTION CHECKS PASSED'));
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
