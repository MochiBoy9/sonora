/* Measures Sonora against a large library — and fails when it gets slower.
 *
 *   node tools/perf.mjs <library-dir> [--report]
 *
 * Reports import throughput, first-paint cost per view, scroll frame times and
 * search latency. Frame times come from requestAnimationFrame deltas while a
 * scripted scroll runs, which is the number that decides whether a list feels
 * smooth.
 *
 * J2: it used to only report, which meant a change that halved the frame rate
 * passed every suite in the repository. Now every measurement has a budget and
 * a run that breaks one exits non-zero.
 *
 * The budgets below are *ceilings, generously set* rather than targets, and
 * that is deliberate. This runs on whatever machine is to hand — a laptop on
 * battery, a CI box sharing a core with three other jobs — so a threshold tight
 * enough to catch a 10% regression would fail half the time for reasons that
 * have nothing to do with the code, and a suite that cries wolf is a suite
 * people pass `--report` to for ever. These are set to catch the change that
 * makes something *qualitatively* worse: a scroll that drops to 30fps, a paint
 * that becomes visible, an import that halves in speed. The numbers next to
 * them are what this machine actually measures, so the headroom is visible.
 *
 * `--report` prints everything and asserts nothing, for when you want a
 * reading rather than a verdict.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report');
const LIB = args.find((a) => !a.startsWith('--'));
const BASE = 'http://127.0.0.1:8123/index.html';

/* Every budget in one table, because the numbers are the interesting part of
   this file and hunting for them among the measurements is how they end up
   quietly diverging from what they are supposed to mean. */
const BUDGET = {
  // A scripted flick through a virtualised list. 16.7ms is one frame at 60Hz;
  // the median has to be a frame or the list is not keeping up at all. The p95
  // allows two dropped frames in a scroll of sixty, and the worst allows one
  // long one — a garbage collection lands somewhere in every run.
  scrollMedian: 18,
  scrollP95: 34,
  scrollWorst: 120,
  // First paint of a route, from the click to the first row existing. Past
  // about 200ms a page transition stops feeling like a transition.
  routePaint: 400,
  // Search runs on every keystroke over the whole library, so it has one
  // frame to finish in or typing stutters.
  searchMs: 16,
  // Files a second through the import pipeline. A floor rather than a ceiling.
  importRate: 6,
  // Painting a stored library back from IndexedDB, which is what a launch is.
  coldStart: 4000,
  // Live DOM nodes in a virtualised list, however many tracks it holds. This
  // one is tight on purpose: it is not a timing, it is the property that makes
  // every timing above hold at fifty thousand tracks, and if it breaks the
  // suite should say so on the smallest library rather than waiting for
  // somebody to try a big one.
  liveNodes: 80,
};

const failures = [];
/** Records a measurement against its budget and prints the comparison. */
function budget(label, value, limit, { floor = false, unit = 'ms' } = {}) {
  const bad = floor ? value < limit : value > limit;
  if (bad) failures.push(`${label}: ${value}${unit} against a budget of ${floor ? 'at least ' : ''}${limit}${unit}`);
  return bad ? ' ✗' : '';
}

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1460, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  UNCAUGHT', e.message));

await page.addInitScript(() => { delete window.showDirectoryPicker; });
// "Add music" opens a menu now: folder or individual files. The tests take the
// folder route, which is what the picker below expects.
async function addFolder() {
  await page.locator('.side-foot .add-btn').click();
  await page.locator('.menu-item', { hasText: 'Add a folder' }).click();
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 20000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 20000 });

/* ---------------------------------------------------------------- import */

const t0 = Date.now();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  addFolder(),
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
if (tracks) {
  const rate = Math.round(tracks / (importMs / 1000));
  console.log(`            ${rate} files/second` +
              budget('import throughput', rate, BUDGET.importRate, { floor: true, unit: '/s' }));
}

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
  console.log(`${label.padEnd(12)}${ms.toFixed(0)}ms to first paint` +
              budget(`${label} first paint`, Math.round(ms), BUDGET.routePaint));
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
              `${result.worst.toFixed(1)}ms · ${result.nodes} live nodes` +
              budget(`${label} median`, +result.median.toFixed(1), BUDGET.scrollMedian) +
              budget(`${label} p95`, +result.p95.toFixed(1), BUDGET.scrollP95) +
              budget(`${label} worst frame`, +result.worst.toFixed(1), BUDGET.scrollWorst) +
              budget(`${label} live nodes`, result.nodes, BUDGET.liveNodes, { unit: '' }));
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
for (const r of search) {
  console.log(`search "${r.q}"`.padEnd(24) + `${r.ms}ms · ${r.hits} results shown · ${r.route}` +
              budget(`search "${r.q}"`, r.ms, BUDGET.searchMs));
}

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
const cold = Date.now() - t1;
console.log(`cold start  ${cold}ms to a painted library from IndexedDB` +
            budget('cold start', cold, BUDGET.coldStart));

await browser.close();

/* ---------------------------------------------------------------- verdict */

if (!failures.length) {
  console.log('\nEVERY BUDGET MET');
} else if (REPORT_ONLY) {
  console.log(`\n${failures.length} OVER BUDGET (reporting only):`);
  for (const f of failures) console.log('  - ' + f);
} else {
  console.log(`\n${failures.length} PERFORMANCE BUDGET(S) BROKEN:`);
  for (const f of failures) console.log('  - ' + f);
  console.log('\nThese are ceilings with a lot of headroom, so one of them going over is');
  console.log('a real change rather than noise — but check the machine is not busy before');
  console.log('going looking. `--report` measures without failing.');
  process.exitCode = 1;
}
