/* Looks at every route at every width and reports what is wrong with the
 * layout: horizontal overflow, elements off the edge, and — the one that is
 * hard to catch by eye — controls that overlap each other.
 *
 *   node tools/layout.mjs <library-dir> [screenshot-dir]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const LIB = process.argv[2];
const SHOTS = process.argv[3] || './shots-layout';
mkdirSync(SHOTS, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);
const ok = (label, pass, extra = '') => {
  log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!pass) problems.push(label + (extra ? ': ' + extra : ''));
};

/* The widths that matter: a phone held upright, a small phone, a tablet, a
   laptop, and a desktop wide enough that the layout has to stop growing. */
const WIDTHS = [
  { w: 360, h: 780, name: 'phone-small' },
  { w: 414, h: 896, name: 'phone' },
  { w: 620, h: 900, name: 'phablet' },
  { w: 768, h: 1024, name: 'tablet' },
  { w: 1024, h: 768, name: 'tablet-wide' },
  { w: 1280, h: 800, name: 'laptop' },
  { w: 1680, h: 1050, name: 'desktop' },
  { w: 2400, h: 1400, name: 'wide' },
];

const ROUTES = ['home', 'songs', 'albums', 'artists', 'playlists', 'circles', 'sound', 'settings'];

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
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

// Something in the transport, so the player bar is at full height everywhere.
await page.locator('.nav-item[data-route="songs"]').click();
await page.waitForSelector('.v-layer .trow');
await page.locator('.v-layer .trow:not([hidden])').first().dblclick();
await page.waitForTimeout(900);

/**
 * Everything that must never sit on top of anything else, and everything that
 * must never leave the viewport. Read in the page so the geometry is the
 * browser's own, not a guess from the CSS.
 */
const audit = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { sel, x: r.x, y: r.y, w: r.width, h: r.height } : null;
  };

  // Landmarks that own their own space. The queue pane is an overlay on
  // narrow screens, so it is only compared when it is docked.
  const docked = !document.getElementById('app')?.classList.contains('pane-float');
  const names = ['.sidebar', '.topbar', '#view', '.playerbar', docked ? '.pane' : null].filter(Boolean);
  const boxes = names.map(box).filter(Boolean);

  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // A shared hairline is a border, not an overlap.
      if (ox > 1.5 && oy > 1.5) overlaps.push(`${a.sel} × ${b.sel} (${Math.round(ox)}×${Math.round(oy)}px)`);
    }
  }

  // Anything interactive that has been pushed somewhere it cannot be reached.
  // Content that is merely scrolled past is not a bug — a rail is *supposed*
  // to run off the right-hand edge — so an element only counts as escaped when
  // no ancestor can scroll to bring it back.
  const canScroll = (el, axis) => {
    const size = axis === 'x' ? 'scrollWidth' : 'scrollHeight';
    const client = axis === 'x' ? 'clientWidth' : 'clientHeight';
    const prop = axis === 'x' ? 'overflowX' : 'overflowY';
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs[prop]) && p[size] > p[client] + 1) return true;
    }
    const d = document.documentElement;
    return d[size] > d[client] + 1;
  };

  /* A control that parks itself off screen and comes back when it takes focus
     is not unreachable — it is the opposite, and a skip link is the whole of
     that category. Checked rather than named: focus it, measure again, and put
     focus back where it was. Anything that stays off screen when focused is
     still a problem and still reported. */
  const revealsOnFocus = (el) => {
    const was = document.activeElement;
    /* The reveal is animated, and measuring it a microtask after `focus()`
       catches it somewhere over the top edge — which is how this reported a
       skip link as unreachable at one width out of six and not the others.
       The transition is suppressed for the measurement and put back, so what
       is read is where the element ends up rather than where it was passing
       through. */
    const had = el.style.transition;
    el.style.transition = 'none';
    let back = false;
    try {
      el.focus({ preventScroll: true });
      el.getBoundingClientRect();                    // flush the style change
      const r = el.getBoundingClientRect();
      back = r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1;
    } catch { /* not focusable */ }
    el.style.transition = had;
    try { (was && was.focus) ? was.focus({ preventScroll: true }) : el.blur(); } catch { /* gone */ }
    return back;
  };

  const escaped = [];
  const seen = new Set();
  const interactive = 'button, a[href], input, select, [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(interactive)) {
    if (el.closest('[hidden], .toast, .menu, .dialog, .sprite')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const key = String(el.className?.baseVal || el.className || el.tagName).split(' ')[0];
    if (seen.has(key)) continue;
    if ((r.right > vw + 1 || r.left < -1) && !canScroll(el, 'x')) {
      seen.add(key);
      escaped.push(`${key} x:${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    } else if ((r.bottom > vh + 1 || r.top < -1) && !canScroll(el, 'y') && !revealsOnFocus(el)) {
      seen.add(key);
      escaped.push(`${key} y:${Math.round(r.top)}..${Math.round(r.bottom)} of ${vh}`);
    }
  }

  // Glyph centring: the visible icon inside a button should sit on the
  // button's own centre, within half a pixel.
  const offCentre = [];
  for (const btn of document.querySelectorAll('button')) {
    const icons = [...btn.querySelectorAll('.ico')].filter((i) => {
      const r = i.getBoundingClientRect();
      const use = i.querySelector('use');
      return r.width && (!use || getComputedStyle(use).display !== 'none');
    });
    if (!icons.length) continue;
    const b = btn.getBoundingClientRect();
    if (btn.textContent.trim()) continue;          // icon + label is not centred
    for (const i of icons) {
      const r = i.getBoundingClientRect();
      const dx = (r.x + r.width / 2) - (b.x + b.width / 2);
      const dy = (r.y + r.height / 2) - (b.y + b.height / 2);
      if (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) {
        offCentre.push(`${String(btn.className).split(' ').slice(0, 2).join('.')} off by ${dx.toFixed(1)},${dy.toFixed(1)}`);
      }
    }
  }

  return {
    vw, vh,
    overflowX: document.documentElement.scrollWidth - vw,
    overlaps,
    escaped: escaped.slice(0, 6),
    offCentre: [...new Set(offCentre)].slice(0, 6),
  };
});

for (const size of WIDTHS) {
  log(`\n> ${size.name}  ${size.w}×${size.h}`);
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.waitForTimeout(500);

  for (const route of ROUTES) {
    await page.evaluate((r) => { location.hash = '#/' + r; }, route);
    await page.waitForTimeout(420);
    const r = await audit();
    const tag = `${size.name}/${route}`;
    // Scrolled to the very end, nothing may still be hiding under the
    // transport: that is the one way a fixed bar makes content unreachable.
    await page.evaluate(() => {
      const view = document.getElementById('view');
      // `scroll-behavior: smooth` animates this, and measuring mid-flight
      // reports every element that happens to be passing the transport.
      if (view) view.scrollTo({ top: view.scrollHeight, behavior: 'instant' });
    });
    await page.waitForTimeout(220);
    const buried = await page.evaluate(() => {
      const bar = document.querySelector('.playerbar')?.getBoundingClientRect();
      if (!bar || !bar.height) return [];
      const out = new Set();
      for (const el of document.querySelectorAll('#view button, #view a[href], #view input')) {
        if (el.closest('[hidden], .toast, .menu, .dialog')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.top < bar.bottom && r.bottom > bar.top + 2) {
          out.add(String(el.className?.baseVal || el.className || el.tagName).split(' ')[0]);
        }
      }
      return [...out].slice(0, 4);
    });
    if (buried.length) ok(`${tag} clears the transport at the end of the page`, false, buried.join('; '));
    if (r.overflowX > 0) ok(`${tag} fits the width`, false, `${r.overflowX}px of overflow`);
    if (r.overlaps.length) ok(`${tag} has no overlapping regions`, false, r.overlaps.join('; '));
    if (r.escaped.length) ok(`${tag} keeps every control reachable`, false, r.escaped.join('; '));
    if (r.offCentre.length) ok(`${tag} centres its glyphs`, false, r.offCentre.join('; '));
  }
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${size.name}.png` });
  log(`  shot  ${size.name}.png`);
}

const noise = errors.filter((e) => !/favicon|Autoplay|net::ERR_/i.test(e));
ok('no console errors', noise.length === 0, noise.slice(0, 3).join(' | '));

await browser.close();
log('\n' + (problems.length ? `${problems.length} LAYOUT PROBLEM(S):` : 'LAYOUT CLEAN AT EVERY WIDTH'));
for (const p of problems) log('  - ' + p);
process.exit(problems.length ? 1 : 0);
