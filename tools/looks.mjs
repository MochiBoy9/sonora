/* Does it look right?
 *
 *   node tools/looks.mjs <library-dir> [golden-dir]
 *
 * `layout.mjs` next door asks whether the geometry is sound — nothing overflows,
 * nothing overlaps, every control is reachable. It is a good suite and it caught
 * none of the nine faults found the first time somebody ran this application at
 * a size they could see, because not one of them was a geometry fault. A
 * tracklist squeezed to four pixels fits its box. A tonearm drawn at a
 * fifteenth of its length overlaps nothing. Two spans that set on one line when
 * they were meant to stack are, geometrically, perfectly in order.
 *
 * So this asks a different question, in two ways.
 *
 * THE LINT is seven rules about the gap between what the CSS says and what
 * arrives on screen. Each one is a shape that a real defect took:
 *
 *   collapsed   a flex child squeezed below the height its own content needs.
 *               The album back cover's tracklist: `flex: 1` made it the only
 *               elastic block on the card, so it absorbed the whole shortfall
 *               and printed its rows on top of the block below it.
 *   clipped     `overflow: hidden` cutting real content, where no mask says it
 *               was meant to be cut. The EQ's own axis label, reading "2"
 *               instead of "20k".
 *   tiny        text under seven effective pixels, transforms included. The
 *               shelf: two vertical text columns and an 8px gap sharing 15px of
 *               spine, four pixels each, unreadable at any zoom.
 *   stacked     two text boxes sitting on top of each other. Whatever the
 *               tracklist spilled onto.
 *   buried      an interactive control under the transport. Carried over from
 *               `layout.mjs`, which is where it was first caught.
 *   small       H3: a tap target under 44 by 44, on a coarse-pointer sweep.
 *               Nearly every control in the application, the first time it
 *               ran — including a 19px record spine and a 20px scrubber.
 *   faint       J3: text under WCAG's 4.5:1, or 3:1 where it is large.
 *               Contrast had been measured once, by hand, on two tokens; this
 *               measures every text node on every surface in both schemes,
 *               which is the same walk the rules above already do.
 *
 * THE GOLDENS are the other half, because a lint can only find what somebody
 * has already been bitten by. Every surface is photographed and compared with
 * the last accepted photograph, pixel for pixel: a change that alters what is
 * on screen fails the run and prints where. `--accept` blesses the current
 * state as the new truth, which is the only way to start and the right way to
 * take a deliberate change.
 *
 * J4: the goldens are committed, so the accepted appearance travels with the
 * source rather than living on whichever machine last ran the suite. One
 * caveat that follows from that and is worth knowing before you go hunting:
 * a screenshot is not perfectly reproducible across machines — font hinting,
 * GPU rasterisation and the exact Chromium build all move pixels — so a run on
 * a different machine from the one that blessed them may disagree everywhere
 * at once. That pattern is the tell. A real regression is one or two surfaces
 * with a named region; a machine difference is all eighty at a fraction of a
 * percent, and the answer to it is `--accept` on the machine you intend to
 * work from, not a hunt through the CSS.
 *
 * Neither half needs a network, a service or a dependency the other tools do
 * not already have.
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/* Flags are taken out before the positional arguments are read. Without this
   `looks.mjs <lib> --accept` quietly made a golden directory called
   "--accept", accepted every surface into it, and reported a clean run. */
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const LIB = ARGS[0];
const GOLD = ARGS[1] || './shots-looks';
const ACCEPT = FLAGS.includes('--accept');
const DIFF_DIR = `${GOLD}/_diff`;

mkdirSync(GOLD, { recursive: true });
mkdirSync(DIFF_DIR, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);
const ok = (label, pass, extra = '') => {
  log(`${pass ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!pass) problems.push(label + (extra ? ': ' + extra : ''));
};

/* ------------------------------------------------------------------ png
 *
 * Comparing two screenshots needs the pixels, and Node has no image decoder.
 * PNG is simple enough to read by hand for the cases that matter here:
 * whatever Chromium writes, which is 8-bit non-interlaced, in one or more IDAT
 * chunks — RGB where the page is fully opaque and RGBA where it is not, and it
 * picks per shot. Greyscale is handled for completeness; palettes and 16-bit
 * are refused rather than guessed at. Everything is normalised to RGBA so the
 * comparison never has to care which it was given.
 */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let p = 8, w = 0, h = 0, bits = 0, type = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tag = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      bits = body[8]; type = body[9]; interlace = body[12];
    } else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (bits !== 8 || !CH || interlace !== 0) {
    throw new Error(`unsupported png: ${bits}-bit type ${type} interlace ${interlace}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH;
  const flat = Buffer.alloc(h * stride);
  // Undo the per-scanline filters. Each line is prefixed with its filter byte,
  // and the predictors look back one *pixel*, not one byte.
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= CH ? cur[x - CH] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= CH ? prev[x - CH] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  if (CH === 4) return { w, h, data: flat };
  // Widen to RGBA so a run that wrote RGB and a run that wrote RGBA compare.
  const out = Buffer.alloc(w * h * 4, 255);
  for (let i = 0, j = 0; i < w * h; i++, j += CH) {
    const g = flat[j];
    out[i * 4] = CH >= 3 ? flat[j] : g;
    out[i * 4 + 1] = CH >= 3 ? flat[j + 1] : g;
    out[i * 4 + 2] = CH >= 3 ? flat[j + 2] : g;
    out[i * 4 + 3] = CH === 2 ? flat[j + 1] : 255;
  }
  return { w, h, data: out };
}

/* How different are these two shots?
 *
 * A per-channel tolerance rather than an exact match, because text rendering
 * is not bit-identical between runs on every machine, and a suite that cries
 * wolf on antialiasing is a suite people turn off. */
function comparePNG(a, b, tol = 12) {
  const A = decodePNG(a), B = decodePNG(b);
  if (A.w !== B.w || A.h !== B.h) return { size: [A.w, A.h, B.w, B.h], diff: -1 };
  let diff = 0;
  let minX = A.w, minY = A.h, maxX = -1, maxY = -1;
  for (let y = 0; y < A.h; y++) {
    for (let x = 0; x < A.w; x++) {
      const i = (y * A.w + x) * 4;
      if (Math.abs(A.data[i] - B.data[i]) > tol ||
          Math.abs(A.data[i + 1] - B.data[i + 1]) > tol ||
          Math.abs(A.data[i + 2] - B.data[i + 2]) > tol ||
          Math.abs(A.data[i + 3] - B.data[i + 3]) > tol) {
        diff++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { diff, total: A.w * A.h, box: maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1] };
}

/* ------------------------------------------------------------------ lint */

const LINT = () => {
  const out = { collapsed: [], clipped: [], tiny: [], stacked: [], buried: [], small: [], faint: [] };
  const name = (e) => {
    const c = String(e.className?.baseVal ?? e.className ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return e.tagName.toLowerCase() + (c ? '.' + c : '') + (e.id ? '#' + e.id : '');
  };
  const path = (e) => {
    const p = [];
    for (let n = e; n && n !== document.body; n = n.parentElement) p.unshift(name(n));
    return p.slice(-3).join('>');
  };
  const shown = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return null;
    // An ancestor faded to nothing takes its children with it — a title behind
    // `opacity: 0` is not on screen however solid the span itself is.
    for (let p = e.parentElement; p; p = p.parentElement) {
      const pc = getComputedStyle(p);
      if (pc.display === 'none' || pc.visibility === 'hidden' || +pc.opacity === 0) return null;
    }
    const r = e.getBoundingClientRect();
    return r.width && r.height ? { cs, r } : null;
  };
  /* What of this element actually reaches the screen.
   *
   * A bounding rectangle is where an element *would* be. Inside a scroller the
   * two part company constantly: the rows below the fold of a virtualised list
   * have rectangles hundreds of pixels past the bottom of the viewport, and
   * comparing those with a fixed transport bar reports every list in the app as
   * having controls buried under it. Intersecting with every clipping ancestor
   * first is the difference between a suite worth reading and one worth
   * switching off. */
  const visible = (e) => {
    let r = e.getBoundingClientRect();
    let box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    for (let p = e.parentElement; p; p = p.parentElement) {
      const pc = getComputedStyle(p);
      if (!/hidden|clip|auto|scroll/.test(pc.overflowY + pc.overflowX)) continue;
      const pr = p.getBoundingClientRect();
      box.top = Math.max(box.top, pr.top);
      box.bottom = Math.min(box.bottom, pr.bottom);
      box.left = Math.max(box.left, pr.left);
      box.right = Math.min(box.right, pr.right);
    }
    box.top = Math.max(box.top, 0);
    box.left = Math.max(box.left, 0);
    box.bottom = Math.min(box.bottom, innerHeight);
    box.right = Math.min(box.right, innerWidth);
    if (box.bottom - box.top < 2 || box.right - box.left < 2) return null;
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    return box;
  };

  const all = [...document.querySelectorAll('body *')];
  for (const e of all) {
    if (e.closest('.sprite')) continue;
    const v = shown(e);
    if (!v) continue;
    const { cs, r } = v;

    /* `text-overflow: ellipsis` is a promise that the cut is deliberate and
       marked — but it only applies along the *inline* axis, which a vertical
       writing mode turns on its side. Excusing the wrong axis excuses a real
       clip; excusing neither reports every truncated title in the app. */
    const vertical = /vertical/.test(cs.writingMode);
    const marked = cs.textOverflow === 'ellipsis' || /gradient/.test(cs.maskImage + cs.webkitMaskImage);
    const excuseY = /gradient/.test(cs.maskImage + cs.webkitMaskImage) || (vertical && marked);
    const excuseX = /gradient/.test(cs.maskImage + cs.webkitMaskImage) || (!vertical && marked);
    /* `data-clips` is an element saying the cut is the point — the crate is
       records receding out of frame, and a crate that fits its box is not a
       crate. Saying so in the markup keeps the rule honest for everything else. */
    if (e.hasAttribute('data-clips')) continue;
    /* Which child is doing the overflowing. "This box is ten pixels short" is
       a fact you then have to go and investigate; "this box is ten pixels short
       and it is the heading" is a fix. */
    /* `scrollHeight` counts children nobody can see. The immersive stage hides
       its own chrome when the pointer goes still, by fading it out and sliding
       it ten pixels down — so a box that is behaving perfectly reports ten
       pixels of overflow, for ever, and the rule that cried wolf gets ignored.
       Content is only cut off if something *visible* is being cut off, so the
       cheap measure is the trigger and a visible child is the verdict. It also
       names the child, which turns "this box is short" into a fix. */
    const culprit = (axis) => {
      const r = e.getBoundingClientRect();
      let worst = null, by = 0;
      for (const k of e.querySelectorAll('*')) {
        if (!shown(k)) continue;
        const kr = k.getBoundingClientRect();
        const d = axis === 'y' ? Math.max(kr.bottom - r.bottom, r.top - kr.top)
                               : Math.max(kr.right - r.right, r.left - kr.left);
        if (d > by) { by = d; worst = k; }
      }
      return by > 4 ? ` (${name(worst)} by ${by.toFixed(0)}px)` : null;
    };
    if (/hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 0 && !excuseY) {
      const who = culprit('y');
      if (who) out.clipped.push(`${path(e)} y ${e.clientHeight}<${e.scrollHeight}${who}`);
    }
    if (/hidden|clip/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 4 && e.clientWidth > 0 && !excuseX) {
      const who = culprit('x');
      if (who) out.clipped.push(`${path(e)} x ${e.clientWidth}<${e.scrollWidth}${who}`);
    }
    if (e.children.length && r.height < 10 && e.scrollHeight > r.height + 12 && cs.position !== 'absolute') {
      out.collapsed.push(`${path(e)} h=${r.height.toFixed(1)} needs ${e.scrollHeight}`);
    }
    const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    /* Text that exists only for a screen reader is not text on the screen.
       `.sr-only` is a 1×1 clipped box by construction — measuring its font
       against its height is measuring the wrong thing, and the rule that
       catches unreadable type would report every live region in the app. */
    if (hasText && !e.closest('.sr-only')) {
      const m = new DOMMatrixReadOnly(cs.transform);
      const scale = Math.min(Math.hypot(m.a, m.b) || 1, Math.hypot(m.c, m.d) || 1);
      const eff = parseFloat(cs.fontSize) * scale;
      // A vertical writing mode gives its text the *cross* size to sit in, so a
      // column four pixels wide is unreadable however large the font is.
      const cross = /vertical/.test(cs.writingMode) ? r.width : r.height;
      if (eff > 0 && (eff < 7 || cross < 7)) {
        out.tiny.push(`${path(e)} ${eff.toFixed(1)}px in ${cross.toFixed(1)}px "${e.textContent.trim().slice(0, 20)}"`);
      }
    }
  }

  const leaves = all.filter((e) => {
    if (e.closest('.sprite, .menu, .dialog, .toast')) return false;
    /* A face turned away from the viewer is not text on the screen.
     *
     * The back of a sleeve is drawn in the same place as the front and rotated
     * out of view; its boxes are exactly where the front's are, so every one
     * of them reads as an overlap. `aria-hidden` is already how the app says
     * "this face is not currently the one you are looking at", which makes it
     * the honest test rather than a special case about sleeves. */
    if (e.closest('[aria-hidden="true"], .sr-only')) return false;
    /* A control's own label sitting over the content it acts on is what a
       control does. The flip and zoom buttons are drawn on the sleeve on
       purpose; reporting them as an overlap is reporting the design. */
    if (e.closest('button, .btn, .icon-btn')) return false;
    if (!/^(span|h1|h2|h3|h4|p|li|dd|dt|a|strong|em|label|small|time|b)$/.test(e.tagName.toLowerCase())) return false;
    if (e.children.length || !e.textContent.trim()) return false;
    const v = shown(e);
    if (!v || v.cs.position === 'fixed') return false;
    /* An overlay covering the page is not two things overlapping.
     *
     * The stage and the queue pane are fixed layers drawn over whatever route
     * is behind them, so every line of text on one reads as colliding with a
     * line on the other. Checking the element's own position was enough while
     * the overlays had no nested text; walking up for a fixed ancestor is what
     * it always meant. */
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position === 'fixed') return false;
    }
    return !!visible(e);
  }).map((e) => ({ e, r: visible(e) }));
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 6 && oy > 6) {
        const area = ox * oy;
        const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
        if (area > small * 0.45) {
          out.stacked.push(`${name(a.e)}"${a.e.textContent.trim().slice(0, 12)}" × ${name(b.e)}"${b.e.textContent.trim().slice(0, 12)}"`);
        }
      }
    }
  }

  const bar = document.querySelector('.playerbar')?.getBoundingClientRect();
  if (bar && bar.height) {
    for (const el of document.querySelectorAll('#view button, #view a[href], #view input')) {
      if (el.closest('[hidden], .toast, .menu, .dialog')) continue;
      if (!shown(el)) continue;
      const r = visible(el);
      if (!r) continue;
      if (r.top < bar.bottom && r.bottom > bar.top + 2) out.buried.push(name(el));
    }
  }

  /* H3: hit targets, on a surface that is actually being touched.
   *
   * This suite already walks every interactive element on sixty surfaces and
   * measures its box. One more rule turns "the phone layout is probably fine"
   * into something that fails — which is the whole reason the suite exists.
   *
   * 44 by 44 is the figure both platform guidelines land on and roughly the
   * contact patch of an adult fingertip. It is checked only where the pointer
   * is coarse, because on a mouse a 24px button is not a problem and demanding
   * 44 everywhere would make the desktop layout worse to satisfy a test.
   *
   * A link inside a run of prose is exempt: it is a word in a sentence, its
   * height is the line height, and the fix for a small one is not to make the
   * paragraph double-spaced. `data-small-ok` is the deliberate opt-out for the
   * handful of controls that live inside something already finger-sized.
   */
  if (matchMedia('(pointer: coarse)').matches) {
    const HIT = 44;
    const TAPPABLE = 'button, a[href], input:not([type=hidden]), select, [role="slider"], [role="switch"], [role="tab"], [tabindex="0"]';
    for (const e of document.querySelectorAll(TAPPABLE)) {
      if (e.closest('.sprite, [hidden], .toast')) continue;
      if (e.hasAttribute('data-small-ok') || e.closest('[data-small-ok]')) continue;
      // A link in a paragraph is text. Anything laid out inline that is not a
      // control is being read, not aimed at.
      const cs = getComputedStyle(e);
      if (e.tagName === 'A' && cs.display === 'inline') continue;
      if (!shown(e)) continue;
      /* On screen at all is checked against the clipped box; the *size* is the
         element's own. A card half scrolled off the bottom is not a small
         target, it is a scrolled one, and measuring the clipped rectangle
         reported "322×12" for a control that is 322×418. */
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      /* Half a pixel of slack, because layout is floating point.
       *
       * The album and artist walls are fluid grids: the column width is the
       * row's width divided by the column count, which is very rarely a whole
       * number, and a control anchored inside a cell of 173.99998px comes back
       * measuring 43.999969482421875 instead of the 44 its stylesheet asked
       * for. That is not a small target, it is arithmetic — and a rule that
       * fails on it is a rule that fails whenever a window is an awkward width,
       * which is the kind of flake that gets a suite switched off. Nothing a
       * finger can feel lives inside half a pixel, and no genuinely undersized
       * control is within half a pixel of passing. */
      if (r.width >= HIT - 0.5 && r.height >= HIT - 0.5) continue;
      out.small.push(`${name(e)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }

  /* J3: contrast, measured rather than remembered.
   *
   * It was fixed once, by hand, on two tokens — and nothing has re-checked
   * them since, so the next regression arrives silently in a theme nobody was
   * looking at. This suite already visits every surface in two schemes and
   * already walks every element on each; computing the ratio for the text it
   * finds is the same walk with arithmetic on the end.
   *
   * WCAG's 4.5:1 for body text and 3:1 for large text, which are the two
   * numbers everybody argues about and nobody has a better answer than.
   * "Large" is 24px, or 18.66px bold — the spec's own definition.
   *
   * The background is found by walking up until something is not transparent,
   * which is what the eye does. It cannot see through an image or a gradient,
   * so anything painted over one is skipped rather than guessed at: a wrong
   * pass is worse than no reading, and a wrong *fail* would have somebody
   * chasing a number that was never real.
   */
  const rgba = (v) => {
    const m = String(v).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
  };
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  /** The colour actually behind an element, or null where it cannot be known. */
  function behind(el) {
    let acc = null;                       // layers between the text and the page
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (!c || !c.a) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    const root = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (!root || !root.a) return null;
    return acc ? over(acc, root) : root;
  }

  for (const e of all) {
    /* Ornament and logotypes are out.
     *
     * `aria-hidden` is the app saying a thing carries no information — the
     * numbers beside the nav items, the ticks on a meter — and a decorative
     * mark set faint on purpose is not body text that has gone wrong.
     * `data-logotype` is the one exemption WCAG grants by name: "text that is
     * part of a logo or brand name has no contrast requirement". Both are
     * narrow, both have to be written on the element, and neither should ever
     * be reached for to quiet this rule about something somebody has to read. */
    if (e.closest('.sprite, .sr-only, [aria-hidden="true"], [data-logotype]')) continue;
    if (e.children.length) continue;                       // leaves only
    const text = e.textContent.trim();
    if (!text) continue;
    const v = shown(e);
    if (!v || !visible(e)) continue;

    const fg = rgba(v.cs.color);
    if (!fg) continue;
    const bg = behind(e);
    if (!bg) continue;                                     // over art, or a gradient

    const opacity = parseFloat(v.cs.opacity);
    const solid = over({ ...fg, a: fg.a * (isFinite(opacity) ? opacity : 1) }, bg);
    const l1 = lum(solid), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const px = parseFloat(v.cs.fontSize);
    const bold = parseInt(v.cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio + 0.05 < need) {
      out.faint.push(`${name(e)} ${ratio.toFixed(2)}:1 needs ${need} "${text.slice(0, 18)}"`);
    }
  }

  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 8);
  return out;
};

/* ------------------------------------------------------------------ run */

const browser = await chromium.launch({
  executablePath: process.env.SONORA_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const seenGolden = new Set();
let shotCount = 0;

async function sweep(scheme, width, height, { touch = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1,
    reducedMotion: 'reduce',      // entrances mid-flight are not what is being photographed
    // H3: a coarse pointer, so the hit-target rule has a surface to run on.
    hasTouch: touch,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('UNCAUGHT: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.addInitScript(() => { delete window.showDirectoryPicker; delete window.showOpenFilePicker; });
  /* The clock, pinned to an afternoon.
   *
   * Home greets by hour and the intro picks its line the same way, so a sweep
   * that wrote its goldens in the morning disagrees with every sweep run after
   * noon — for a reason that has nothing to do with what changed. Only
   * `getHours` is pinned, and nothing else in the app reads it: the day log
   * keys off the date, which stays real. */
  await page.addInitScript(() => {
    const real = Date.prototype.getHours;
    Date.prototype.getHours = function () { return this === undefined ? real.call(this) : 14; };
  });
  await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready', { timeout: 30000 });
  await page.waitForSelector('#intro', { state: 'detached', timeout: 30000 });

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      /* Whichever Add button this width actually shows. The phone layout hides
         the one in the side rail and keeps the one in the topbar, so a sweep
         that only knows about the first cannot import anything below 560px —
         which is exactly the width the touch pass runs at. */
      const side = page.locator('.side-foot .add-btn');
      const top = page.locator('.topbar-add');
      await (await side.isVisible() ? side : top).click();
      await page.locator('.menu-item', { hasText: 'Add a folder' }).click();
    })(),
  ]);
  await chooser.setFiles(LIB);
  await page.waitForFunction(() => document.querySelectorAll('.rail .card').length > 0, null, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('.scan')?.hidden !== false, null, { timeout: 90000 });

  /* Something in the transport, so the bar is at full height on every surface —
     and then stopped, because a run that keeps playing is a run whose
     photographs are all slightly different: the playhead advances, the track
     changes under it, and the lit row in the songs list moves down the page
     between the sweep that wrote the goldens and the sweep that checks them.
     Loaded and paused is a real state, and it is the same one every time. */
  await page.evaluate(() => { location.hash = '#/songs'; });
  await page.waitForSelector('.v-layer .trow');
  await page.locator('.v-layer .trow:not([hidden])').first().dblclick();
  await page.waitForTimeout(900);
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.querySelector('.playerbar')?.classList.contains('is-playing'),
                             null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  /* Any toast still on screen is swept away before the sweep starts.
   *
   * A toast is transient by definition, so a golden that happens to contain
   * one is a golden that depends on how long the run took to get here — and
   * the day somebody adds a toast with a longer duration, thirty photographs
   * disagree with the goldens for a reason that has nothing to do with what
   * any of them are of. Observed: the import report's "needs attention" toast
   * outlived the setup and printed itself across four pages. */
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove(); });
  await page.waitForTimeout(120);

  const tag = `${scheme}-${width}`;

  const check = async (label) => {
    const r = await page.evaluate('(' + LINT.toString() + ')()');
    const n = Object.values(r).reduce((a, b) => a + b.length, 0);
    if (n) {
      for (const [k, v] of Object.entries(r)) {
        if (v.length) ok(`${tag}/${label} ${k}`, false, v.join('; '));
      }
    }
    return n;
  };

  /* A golden is only a golden if it is stable. Anything that moves on its own
     — the world behind the interface, the spectrum, the platter — is stopped
     before the shutter, so a diff means the drawing changed and not that the
     photograph was taken a frame later.
     
     An entrance is *finished*, not paused. Pausing one at time zero freezes the
     page in the state it was leaving, which is a state nobody ever looks at:
     it reported the immersive stage as ten pixels of overflow for a whole run,
     and the overflow was a heading still sitting where it had begun. Anything
     that repeats for ever has no end to run to, so those are parked instead. */
  const still = () => page.evaluate(() => {
    document.querySelectorAll('canvas').forEach((c) => { c.style.visibility = 'hidden'; });
    /* The tonearm is the playhead, which is the whole point of it and makes it
       the one drawing that is never twice the same: four seconds into a side it
       sits somewhere no run will reproduce, and it sweeps a big enough area to
       trip the comparison every time. Pinned to a fixed angle the golden still
       checks how the arm is *drawn* — its length, its pivot, the headshell,
       where it sits against the grooves — and where it should be for a given
       moment is arithmetic, checked in `smoke.mjs`, not a photograph. */
    let pin = document.getElementById('looks-pin');
    if (!pin) {
      pin = document.createElement('style');
      pin.id = 'looks-pin';
      pin.textContent = '.deck-arm { rotate: 14deg !important; transition: none !important; }';
      document.head.appendChild(pin);
    }
    for (const a of document.getAnimations()) {
      try {
        const it = a.effect?.getComputedTiming?.().iterations;
        if (it === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
      } catch { /* an animation that will not be told is not worth the run */ }
    }
  });

  const golden = async (label) => {
    await still();
    await page.waitForTimeout(120);
    const shot = await page.screenshot();
    const file = `${GOLD}/${tag}-${label}.png`;
    seenGolden.add(`${tag}-${label}.png`);
    shotCount++;
    if (ACCEPT || !existsSync(file)) { writeFileSync(file, shot); return; }
    const cmp = comparePNG(readFileSync(file), shot);
    if (cmp.diff === -1) {
      ok(`${tag}/${label} is the size it was`, false, `${cmp.size[0]}×${cmp.size[1]} -> ${cmp.size[2]}×${cmp.size[3]}`);
    } else if (cmp.diff > cmp.total * 0.0015) {
      writeFileSync(`${DIFF_DIR}/${tag}-${label}.png`, shot);
      const [x, y, w, h] = cmp.box;
      ok(`${tag}/${label} looks like it did`, false,
         `${cmp.diff} px changed (${(100 * cmp.diff / cmp.total).toFixed(2)}%) around ${x},${y} ${w}×${h}`);
    }
    // The canvases were hidden for the shot; put them back for the next route.
    await page.evaluate(() => document.querySelectorAll('canvas').forEach((c) => { c.style.visibility = ''; }));
  };

  const surface = async (label, go) => {
    await go();
    await page.waitForTimeout(500);
    await check(label);
    await golden(label);
  };

  const route = (r) => async () => {
    await page.evaluate((x) => { location.hash = '#/' + x; }, r);
    await page.waitForTimeout(650);
  };

  log(`\n> ${tag}`);
  for (const r of ['home', 'songs', 'albums', 'artists', 'playlists', 'favourites', 'files', 'circles', 'sound', 'settings']) {
    await surface('route-' + r, route(r));
  }

  /* Settings is taller than the window and the shot is viewport-sized, so the
     top of the page is the only part the goldens had ever seen — every row
     below the fold, which is most of them, was unwatched. */
  await surface('settings-lower', async () => {
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForTimeout(650);
    await page.evaluate(() => { document.querySelector('#view').scrollTop = 620; });
    await page.waitForTimeout(450);
  });

  await route('albums')();
  for (const m of ['Crate', 'Shelf', 'Floor']) {
    await surface('albums-' + m.toLowerCase(), async () => {
      await page.locator('.seg', { hasText: new RegExp('^' + m + '$') }).click();
      await page.waitForTimeout(1100);
    });
  }
  await page.locator('.seg', { hasText: /^Grid$/ }).click();
  await page.waitForTimeout(500);

  await surface('album', async () => {
    await page.locator('.acard, .album-card, .card').first().click();
    await page.waitForTimeout(1100);
  });
  if (await page.locator('.flip-btn').count()) {
    await surface('album-back', async () => {
      await page.locator('.flip-btn').first().click();
      await page.waitForTimeout(1100);
    });
  }

  await surface('queue', async () => {
    await page.locator('.pb-queue').click();
    await page.waitForTimeout(700);
  });
  await page.locator('.pb-queue').click();
  await page.waitForTimeout(400);

  /* The stage hides its own chrome when the pointer goes still, and in a run
     nobody touches the mouse — so photographed as found, both stage goldens are
     a picture of an empty screen. Nudging the pointer first is what a person
     looking at it would have done. */
  const wake = async () => {
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 4, height / 2 + 4);
    await page.waitForTimeout(350);
  };
  await surface('stage', async () => {
    await page.keyboard.press('v');
    await page.waitForTimeout(1200);
    await wake();
  });
  await surface('stage-deck', async () => {
    await page.keyboard.press('d');
    await page.waitForTimeout(1300);
    await wake();
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await surface('shortcuts', async () => {
    await page.keyboard.press('?');
    await page.waitForTimeout(700);
  });
  await page.keyboard.press('Escape');

  ok(`${tag} console is clean`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

await sweep('dark', 1440, 900);
await sweep('light', 1440, 900);
await sweep('dark', 620, 900);
// H3: one pass with a finger rather than a pointer. Same surfaces, same
// goldens, plus the one rule that only means anything here.
await sweep('dark', 390, 844, { touch: true });

await browser.close();

/* A golden nobody photographed this run is a golden for a surface that no
   longer exists, and it will quietly pass forever. Say so. */
const stale = readdirSync(GOLD).filter((f) => f.endsWith('.png') && !seenGolden.has(f));
if (stale.length) ok('every golden still has a surface', false, stale.join(', '));

log('');
if (problems.length) {
  log(`${problems.length} LOOKS PROBLEM(S):`);
  problems.forEach((p) => log('  - ' + p));
  if (existsSync(DIFF_DIR)) log(`\nWhat it looks like now: ${DIFF_DIR}`);
  log('If a change was intended, re-run with --accept to make it the new truth.');
  process.exit(1);
}
log(`LOOKS CLEAN — ${shotCount} surfaces, lint and goldens`);
