/* Does the rack actually change the sound?
 *
 * Not "does the slider move" — does the audio leaving the graph differ. The
 * app's own analyser sits *after* the rack, so it can be asked directly: play
 * a tone, read the spectrum, turn a band up, read it again.
 *
 *   node tools/audio.mjs <library-dir>
 */

import { chromium } from 'playwright';

const LIB = process.argv[2];
const problems = [];
const log = (...a) => console.log(...a);
const ok = (label, pass, extra = '') => {
  log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!pass) problems.push(label + (extra ? ': ' + extra : ''));
};

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript(() => { delete window.showDirectoryPicker; });
await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 20000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 20000 });

const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  (async () => {
    await page.locator('.side-foot .add-btn').click();
    await page.locator('.menu-item', { hasText: 'Add a folder' }).click();
  })(),
]);
await chooser.setFiles(LIB);
await page.waitForFunction(() => document.querySelectorAll('.rail .card').length > 0, null, { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.scan')?.hidden !== false, null, { timeout: 60000 });

/* The WAV and AIFF files in the test library carry a real sine tone between
   150 and 400 Hz. Everything else decodes to silence, which measures nothing. */
log('\n> playing a tone');
const started = await page.evaluate(async () => {
  const lib = await import('/js/library.js');
  const player = await import('/js/player.js');
  const tone = lib.allTracks().find((t) => /\.(wav|aiff?)$/i.test(t.name));
  if (!tone) return null;
  player.playTracks([tone], 0, null);
  // The measurements below take longer than the tone does. Looping it means
  // every reading is of the same sound, which is the only way the comparisons
  // mean anything — the first version of this test measured silence and
  // reported that the pitch shifter had broken the audio.
  player.state.repeat = 'one';
  return tone.name;
});
ok('a tone is playing', !!started, started || 'no wav/aiff in the library');
await page.waitForTimeout(1600);

/** Average the analyser over a second of frames, after the rack has settled. */
const measureRaw = () => page.evaluate(() => new Promise((resolve) => {
  const player = window.__sonoraPlayer;
  let n = 0;
  const sum = { bass: 0, mid: 0, treble: 0, level: 0 };
  const step = () => {
    const a = player.analysis();
    sum.bass += a.bass; sum.mid += a.mid; sum.treble += a.treble; sum.level += a.level;
    if (++n < 45) return requestAnimationFrame(step);
    resolve({ bass: sum.bass / n, mid: sum.mid / n, treble: sum.treble / n, level: sum.level / n });
  };
  requestAnimationFrame(step);
}));

/** A reading of silence is not a reading. */
async function measure(label) {
  const r = await measureRaw();
  if (r.level < 0.005) {
    ok(`something was playing while measuring ${label}`, false, `level ${r.level.toFixed(4)}`);
  }
  return r;
}

// The test needs the same module instance the app is running.
await page.evaluate(async () => {
  window.__sonoraPlayer = await import('/js/player.js');
  window.__sonoraRack = await import('/js/audio.js');
});

const setRack = (patch) => page.evaluate((p) => {
  const rack = window.__sonoraRack;
  if (p.eq) rack.state.eq = p.eq;
  rack.set(p.rest || {});
}, patch);

const flat = await measure('flat');
log(`  flat:  bass ${flat.bass.toFixed(3)}  mid ${flat.mid.toFixed(3)}  level ${flat.level.toFixed(3)}`);
ok('the analyser is hearing something', flat.level > 0.01, `level ${flat.level.toFixed(3)}`);

/* ---------------------------------------------------------------- equaliser */

log('\n> equaliser');
await setRack({ eq: [0, 12, 12, 12, 0, 0, 0, 0, 0, 0] });
await page.waitForTimeout(900);
const boosted = await measure('the boost');
log(`  boosted: bass ${boosted.bass.toFixed(3)} (was ${flat.bass.toFixed(3)})`);
ok('boosting the low bands is audible in the output',
   boosted.bass > flat.bass * 1.06, `${flat.bass.toFixed(3)} -> ${boosted.bass.toFixed(3)}`);

await setRack({ eq: [-12, -12, -12, -12, 0, 0, 0, 0, 0, 0] });
await page.waitForTimeout(900);
const cut = await measure('the cut');
log(`  cut:     bass ${cut.bass.toFixed(3)}`);
ok('cutting the low bands is audible in the output',
   cut.bass < flat.bass * 0.94, `${flat.bass.toFixed(3)} -> ${cut.bass.toFixed(3)}`);

/* ---------------------------------------------------------------- bypass */

log('\n> bypass');
await page.evaluate(() => window.__sonoraRack.set({ on: false }));
await page.waitForTimeout(900);
const bypassed = await measure('the bypass');
ok('bypass restores the untouched signal',
   Math.abs(bypassed.bass - flat.bass) < Math.max(0.05, flat.bass * 0.25),
   `${flat.bass.toFixed(3)} vs ${bypassed.bass.toFixed(3)}`);
await page.evaluate(() => window.__sonoraRack.set({ on: true }));
await page.evaluate(() => window.__sonoraRack.reset());
await page.waitForTimeout(600);

/* ---------------------------------------------------------------- pitch */

log('\n> pitch and speed');
await page.evaluate(() => window.__sonoraRack.set({ pitch: 7 }));
// The worklet module is fetched on first use, so give the crossfade room to
// finish rather than measuring the fetch.
await page.waitForFunction(
  () => window.__sonoraRack.__debug().ratio > 1.4, null, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(1200);
const shifted = await measure('the shift');
const dbg = await page.evaluate(() => window.__sonoraRack.__debug());
log(`  ${JSON.stringify(dbg)}`);
ok('the shifter is in the path at the right ratio',
   dbg.worklet && Math.abs(dbg.ratio - Math.pow(2, 7 / 12)) < 0.02, JSON.stringify(dbg.ratio));
ok('the shifter keeps the audio flowing', shifted.level > 0.01, `level ${shifted.level.toFixed(3)}`);
// A tone shifted up seven semitones puts its energy in a higher band.
ok('pitching up moves energy upward',
   shifted.mid + shifted.treble > flat.mid + flat.treble,
   `${(flat.mid + flat.treble).toFixed(3)} -> ${(shifted.mid + shifted.treble).toFixed(3)}`);

await page.evaluate(() => window.__sonoraRack.set({ pitch: 0, speed: 1.5 }));
await page.waitForTimeout(500);
const fast = await page.evaluate(() => window.__sonoraRack.__debug());
ok('speed drives the element', Math.abs(fast.rate - 1.5) < 0.01, `${fast.rate}×`);

await page.evaluate(() => window.__sonoraRack.reset());
await page.waitForTimeout(400);

/* ---------------------------------------------------------------- persist */

log('\n> persistence');
await page.evaluate(() => window.__sonoraRack.usePreset('vocal'));
await page.waitForTimeout(900);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('body.is-ready', { timeout: 20000 });
await page.waitForSelector('#intro', { state: 'detached', timeout: 20000 });
await page.waitForTimeout(700);
const after = await page.evaluate(async () => {
  const rack = await import('/js/audio.js');
  await rack.preload();
  return { preset: rack.state.preset, eq: rack.state.eq.slice(0, 4) };
});
ok('the rack comes back after a reload', after.preset === 'vocal',
   `${after.preset} ${JSON.stringify(after.eq)}`);

/* ---------------------------------------------------------------- the page */

log('\n> the sound page');
await page.evaluate(() => { location.hash = '#/sound'; });
await page.waitForTimeout(900);
ok('the curve is drawn', await page.evaluate(() => {
  const d = document.querySelector('.eq-line')?.getAttribute('d') || '';
  return d.length > 100;
}));
ok('the curve follows the settings', await page.evaluate(() => {
  // Vocal cuts the bottom, so the left end of the curve sits below the middle.
  const d = document.querySelector('.eq-line').getAttribute('d');
  const first = parseFloat(d.slice(1).split(' ')[1]);
  return first > 200;                                  // below the 0 dB line
}));
const faders = await page.locator('.fader input').count();
ok('there is a fader per band', faders === 10, `${faders} faders`);
ok('presets are shown', await page.locator('.preset-strip .preset').count() >= 11);

const bandBefore = await page.evaluate(async () => (await import('/js/audio.js')).state.eq[9]);
await page.locator('.eq-handle').nth(9).focus();
await page.keyboard.press('ArrowUp');
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(400);
const bandAfter = await page.evaluate(async () => (await import('/js/audio.js')).state.eq[9]);
ok('a band can be moved from the keyboard',
   Math.abs(bandAfter - (bandBefore + 1)) < 0.01, `${bandBefore} -> ${bandAfter}`);
await page.keyboard.press('Home');
await page.waitForTimeout(250);
ok('Home returns a band to flat',
   await page.evaluate(async () => (await import('/js/audio.js')).state.eq[9] === 0));

const noise = errors.filter((e) => !/favicon|Autoplay|net::ERR_/i.test(e));
ok('no console errors', noise.length === 0, noise.slice(0, 3).join(' | '));

await browser.close();
log('\n' + (problems.length ? `${problems.length} AUDIO PROBLEM(S):` : 'ALL AUDIO CHECKS PASSED'));
for (const p of problems) log('  - ' + p);
process.exit(problems.length ? 1 : 0);
