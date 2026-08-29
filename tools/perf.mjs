/* Measures Sonora against a large library.
 *
 *   node tools/perf.mjs <library-dir>
 *
 * Reports import throughput, first-paint cost per view, scroll frame times and
 * search latency. Frame times come from requestAnimationFrame deltas while a
 * scripted scroll runs, which is the number that decides whether a list feels
 * smooth.
 */

import { chromium } from 'playwright';

const LIB = process.argv[2];
const BASE = 'http://127.0.0.1:8123/index.html';

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1460, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  UNCAUGHT', e.message));

await page.addInitScript(() => { delete window.showDirectoryPicker; });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 20000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 20000 });

/* ---------------------------------------------------------------- import */

const t0 = Date.now();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.locator('.side-foot .add-btn').click(),
]);
await chooser.setFiles(LIB);
// Wait for the scan to start, then for it to finish — checking only for "hidden"
// would pass instantly, before the first file is read.
await page.waitForFunction(() => document.querySelector('.scan')?.hidden === false,
                           null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelector('.scan')?.hidden === true,
                           null, { timeout: 600000 });
const importMs = Date.now() - t0;

await page.locator('.nav-item[data-route="home"]').click();
await page.waitForTimeout(400);
const count = await page.evaluate(() =>
  document.querySelector('.page-sub')?.textContent || '');
console.log(`\nimport      ${(importMs / 1000).toFixed(1)}s   (${count.trim()})`);
const tracks = parseInt((count.match(/([\d,]+) tracks/) || [0, '0'])[1].replace(/,/g, ''), 10);
if (tracks) console.log(`            ${Math.round(tracks / (importMs / 1000))} files/second`);

/* ---------------------------------------------------------------- view cost */

async function timeRoute(label, selector, click) {
  const ms = await page.evaluate(async ({ selector, click }) => {
    const t = performance.now();
    document.querySelector(click).click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let waited = 0;
    while (!document.querySelector(selector) && waited < 4000) {
      await new Promise((r) => setTimeout(r, 8));
      waited += 8;
    }
    return performance.now() - t;
  }, { selector, click });
  console.log(`${label.padEnd(12)}${ms.toFixed(0)}ms to first paint`);
  await page.waitForTimeout(250);
}

console.log('');
await timeRoute('songs', '.v-layer .trow', '.nav-item[data-route="songs"]');
await timeRoute('albums', '.v-grid-row .card', '.nav-item[data-route="albums"]');
await timeRoute('artists', '.v-grid-row .card', '.nav-item[data-route="artists"]');

/* ---------------------------------------------------------------- scrolling */

async function scrollTest(label, route) {
  await page.locator(`.nav-item[data-route="${route}"]`).click();
  await page.waitForTimeout(600);

  const result = await page.evaluate(async () => {
    const view = document.getElementById('view');
    const frames = [];
    let last = performance.now();
    let stop = false;

    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Scroll in 60 steps, one per frame, like a fast flick.
    const max = view.scrollHeight - view.clientHeight;
    for (let i = 0; i < 60; i++) {
      view.scrollTop = (max * i) / 60;
      await new Promise(requestAnimationFrame);
    }
    stop = true;
    await new Promise((r) => setTimeout(r, 60));

    const sorted = frames.slice(3).sort((a, b) => a - b);
    const at = (p) => sorted[Math.floor(sorted.length * p)] || 0;
    return {
      frames: sorted.length,
      median: at(0.5),
      p95: at(0.95),
      worst: sorted[sorted.length - 1],
      nodes: document.querySelectorAll('#view .trow, #view .card').length,
    };
  });

  console.log(`${label.padEnd(16)}median ${result.median.toFixed(1)}ms · p95 ${result.p95.toFixed(1)}ms · worst ` +
              `${result.worst.toFixed(1)}ms · ${result.nodes} live nodes`);
}

console.log('');
await scrollTest('scroll songs', 'songs');
await scrollTest('scroll albums', 'albums');

/* ---------------------------------------------------------------- search */

console.log('');
const search = await page.evaluate(async () => {
  const input = document.getElementById('search');
  const runs = [];
  for (const q of ['a', 'am', 'amb', 'amber', 'harbour static', 'zzz']) {
    const t = performance.now();
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    runs.push({ q, ms: +(performance.now() - t - 400).toFixed(1),
                hits: document.querySelectorAll('.plain-list .trow, .block .card').length,
                route: location.hash.slice(0, 24) });
  }
  return runs;
});
for (const r of search) console.log(`search "${r.q}"`.padEnd(24) + `${r.ms}ms · ${r.hits} results shown · ${r.route}`);

/* ---------------------------------------------------------------- memory */

const mem = await page.evaluate(() => performance.memory
  ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
if (mem) console.log(`\nJS heap     ${mem} MB`);

/* ---------------------------------------------------------------- reload */

await page.evaluate(() => { location.hash = '#/home'; });
await page.waitForTimeout(200);
const t1 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });
// Deliberately not waiting on body.is-ready: the library is painted behind the
// intro, and this is meant to measure the library, not the welcome sequence.
await page.waitForFunction(() => (document.querySelector('.page-sub')?.textContent || '').includes('track'),
                           null, { timeout: 30000 });
console.log(`cold start  ${Date.now() - t1}ms to a painted library from IndexedDB`);

await browser.close();
