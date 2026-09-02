/* virtual.js — windowed rendering.
 *
 * Only the rows that intersect the viewport exist in the DOM. Nodes are
 * recycled through a free pool, positioned with transforms, and updated inside
 * a rAF, so scrolling a 50,000-track list costs the same as scrolling 30 rows.
 */

const OVERSCAN = 6;

/**
 * How strongly the grid hazes toward its edges, taken from the Look's own
 * Parallax setting so "how far panels lift off the world" governs this too —
 * and so Plain, which sets it to zero, switches the ramp off entirely along
 * with everything else.
 */
function readDepth() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--parallax'));
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export class VirtualList {
  /**
   * @param viewport   scrolling element
   * @param rowHeight  fixed px height per row
   * @param create()   -> HTMLElement   (called at most (visible + overscan) times)
   * @param render(node, item, index)
   */
  constructor({ viewport, rowHeight, create, render, overscan = OVERSCAN, keyOf }) {
    this.viewport = viewport;
    this.rowHeight = rowHeight;
    this.create = create;
    this.render = render;
    this.overscan = overscan;
    this.keyOf = keyOf;

    this.items = [];
    this.live = new Map();      // index -> node
    this.pool = [];
    this.start = 0;
    this.end = 0;
    this.frame = 0;

    this.sizer = document.createElement('div');
    this.sizer.className = 'v-sizer';

    this.layer = document.createElement('div');
    this.layer.className = 'v-layer';
    this.sizer.appendChild(this.layer);

    viewport.appendChild(this.sizer);

    this.onScroll = () => this.schedule();
    viewport.addEventListener('scroll', this.onScroll, { passive: true });

    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(viewport);
  }

  setItems(items) {
    this.items = items || [];
    this.sizer.style.height = this.items.length * this.rowHeight + 'px';
    this.recycleAll();
    this.update();
  }

  /** Re-runs render() on the rows currently on screen (state changed, not data). */
  refresh() {
    for (const [i, node] of this.live) {
      if (this.items[i]) this.render(node, this.items[i], i);
    }
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  update() {
    const { viewport, rowHeight, items } = this;
    const height = viewport.clientHeight;
    if (!height) return;

    // The sizer usually sits below a page header inside the same scroller.
    const scrollTop = viewport.scrollTop - this.sizer.offsetTop;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - this.overscan);
    const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + this.overscan);

    // Release rows that scrolled out.
    for (const [i, node] of this.live) {
      if (i < first || i >= last) { this.release(i, node); }
    }
    // Claim rows that scrolled in.
    for (let i = first; i < last; i++) {
      if (this.live.has(i)) continue;
      const node = this.pool.pop() || this.create();
      node.style.transform = `translate3d(0, ${i * rowHeight}px, 0)`;
      node.dataset.index = i;
      this.render(node, items[i], i);
      if (!node.parentNode) this.layer.appendChild(node);
      node.hidden = false;
      this.live.set(i, node);
    }
    this.start = first;
    this.end = last;
    this.orderRows();
  }

  /**
   * Puts the live rows back into index order in the DOM.
   *
   * A row is placed by its transform, so the browser draws it in the right
   * spot whatever order it sits in — but Tab, a screen reader and anything
   * else that walks the document read the DOM order, and the pool hands nodes
   * back last-in-first-out. Recycling a whole screen at once therefore leaves
   * the rows in exactly reverse order, and the queue's keyboard reordering
   * would have tabbed backwards through the list.
   *
   * The check is a walk and costs nothing; the repair only runs when the order
   * is actually wrong, which is on a data change rather than on every frame of
   * a scroll.
   */
  orderRows() {
    let last = -1;
    for (const node of this.layer.children) {
      if (node.hidden) continue;
      const i = +node.dataset.index;
      if (i < last) {
        for (const j of [...this.live.keys()].sort((a, b) => a - b)) {
          this.layer.appendChild(this.live.get(j));
        }
        return;
      }
      last = i;
    }
  }

  release(i, node) {
    this.live.delete(i);
    node.hidden = true;
    this.pool.push(node);
  }

  recycleAll() {
    for (const [i, node] of this.live) this.release(i, node);
  }

  scrollToIndex(i, align = 'center') {
    if (i < 0 || i >= this.items.length) return;
    /* Plus where the list starts inside the scroller.
     *
     * `update()` has always subtracted `sizer.offsetTop` when working out which
     * rows are visible, and this did not add it back — so a jump landed short
     * by however much page sits above the list, which on Songs is a heading, a
     * toolbar and a column header, or about four rows. Nothing noticed while
     * the only caller was a list that starts at the top of its own page. */
    const from = this.sizer.offsetTop - this.stickyInset();
    const target = align === 'center'
      ? from + i * this.rowHeight - (this.viewport.clientHeight - this.rowHeight) / 2
      : from + i * this.rowHeight;
    this.viewport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  /**
   * How much of the top of the scroller something else is already occupying.
   *
   * The songs list has a sticky column header pinned above it, so a row put at
   * the very top of the viewport arrives forty pixels underneath the thing
   * naming its columns — scrolled to, and invisible. Anything sticky sitting
   * between the top of the scroller and the list is measured rather than
   * assumed, because the album page has no header and the queue has a different
   * one, and a hard-coded inset would be wrong on two pages out of three.
   */
  stickyInset() {
    /* Where it will be once pinned, not where it is now.
     *
     * Reading the header's rectangle only works if it is already stuck, and at
     * the top of a page it is still in flow two hundred pixels down — so a jump
     * from the top would overshoot by the height of the page heading. A sticky
     * element pins at the scrollport's *padding* edge plus whatever `top` it
     * declares, so that is the sum: the scroller's own top padding, the
     * element's offset, and its height.
     *
     * Measured rather than assumed because the album page has no header at all
     * and the queue has a different one; a hard-coded inset would be wrong on
     * two pages out of three. */
    const pad = parseFloat(getComputedStyle(this.viewport).paddingTop) || 0;
    let inset = 0;
    for (let el = this.sizer.previousElementSibling; el; el = el.previousElementSibling) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky') continue;
      const offset = parseFloat(cs.top) || 0;
      inset = Math.max(inset, pad + offset + el.getBoundingClientRect().height);
    }
    return inset;
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
    this.sizer.remove();
  }
}

/**
 * Grid variant. One node per grid *row* (a CSS grid of `cols` cells), which
 * keeps the node count an order of magnitude lower than one node per cell and
 * lets the browser handle intra-row layout.
 */
export class VirtualGrid {
  constructor({ viewport, minCell, gap = 20, aspect = 1, footer = 62, create, render, overscan = 2 }) {
    this.viewport = viewport;
    this.minCell = minCell;
    this.gap = gap;
    this.aspect = aspect;
    this.footer = footer;
    this.create = create;
    this.render = render;
    this.overscan = overscan;

    this.items = [];
    this.cols = 1;
    this.rowHeight = 1;
    this.live = new Map();
    this.pool = [];
    this.frame = 0;

    this.sizer = document.createElement('div');
    this.sizer.className = 'v-sizer';
    this.layer = document.createElement('div');
    this.layer.className = 'v-layer';
    this.sizer.appendChild(this.layer);
    viewport.appendChild(this.sizer);

    this.onScroll = () => this.schedule();
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
    /* The viewport, not the sizer.
     *
     * measure() writes the sizer's height, so an observer on the sizer is
     * being fed its own output: the browser drops the second delivery and
     * reports "ResizeObserver loop completed with undelivered notifications"
     * on every mount. The sizer's width is the viewport's content width, and
     * measure() reads it directly, so watching the viewport sees every change
     * that matters without the write coming back round. It is also what
     * VirtualList next door already does. */
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.viewport);
  }

  setItems(items) {
    this.items = items || [];
    /* Every visible cell, again.
     *
     * `measure()` alone is not enough, and the reason is easy to miss: it only
     * rebuilds when the *geometry* changes, and reordering a list of the same
     * length at the same width changes neither the column count nor the row
     * height. So the rows stayed exactly as they were and a re-sorted grid
     * showed the old order — which is what happened the first time the Artists
     * page was given something to sort by. The list next door has always done
     * this; the grid only ever had new data handed to it when the count
     * changed, so nothing had noticed.
     *
     * It costs one re-render of what is on screen, which is a couple of dozen
     * cells however large the library is. */
    this.recycleAll();
    this.measure();
  }

  /** Recomputes the column count; a change forces a full rebuild of the rows. */
  measure() {
    const width = this.sizer.clientWidth || this.viewport.clientWidth;
    if (!width) return;
    const cols = Math.max(1, Math.floor((width + this.gap) / (this.minCell + this.gap)));
    const cellW = (width - this.gap * (cols - 1)) / cols;
    const rowHeight = Math.round(cellW * this.aspect + this.footer + this.gap);

    const changed = cols !== this.cols || rowHeight !== this.rowHeight;
    this.cols = cols;
    this.rowHeight = rowHeight;
    if (changed) this.recycleAll();

    // How much aerial perspective the grid gets, read here rather than per
    // frame: a getComputedStyle inside update() would be a forced style read
    // on every scroll frame, which is the exact cost this whole file exists to
    // avoid. measure() runs on construction and on every resize, so a Look
    // changed mid-session takes effect at the next route change or resize.
    this.depth = readDepth();

    const rows = Math.ceil(this.items.length / cols);
    /* Only when it actually moves. This runs from a ResizeObserver on the
       sizer, so writing the sizer's height unconditionally feeds the observer
       its own output — the browser notices, drops the second delivery, and
       reports "ResizeObserver loop completed with undelivered notifications"
       on every route change. Nothing was visibly broken; it was one frame of
       wasted work and a warning in everybody's console. */
    const h = rows * rowHeight + 'px';
    if (this.sizer.style.height !== h) this.sizer.style.height = h;
    this.update();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  update() {
    const height = this.viewport.clientHeight;
    if (!height || !this.rowHeight) return;
    const rows = Math.ceil(this.items.length / this.cols);
    const scrollTop = this.viewport.scrollTop - this.sizer.offsetTop;
    const first = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const last = Math.min(rows, Math.ceil((scrollTop + height) / this.rowHeight) + this.overscan);

    for (const [r, node] of this.live) {
      if (r < first || r >= last) { this.live.delete(r); node.hidden = true; this.pool.push(node); }
    }
    for (let r = first; r < last; r++) {
      if (this.live.has(r)) continue;
      const node = this.pool.pop() || this.createRow();
      node.style.transform = `translate3d(0, ${r * this.rowHeight}px, 0)`;
      node.style.gridTemplateColumns = `repeat(${this.cols}, minmax(0, 1fr))`;
      node.style.gap = this.gap + 'px';
      node.dataset.row = r;
      this.fillRow(node, r);
      if (!node.parentNode) this.layer.appendChild(node);
      node.hidden = false;
      this.live.set(r, node);
    }
    this.orderRows();

    if (this.depth) { this.paintDepth(scrollTop, height); this.hazed = true; }
    else if (this.hazed) {
      // Parallax was turned down. A recycled row would otherwise carry the
      // opacity from its previous life forever.
      for (const [, node] of this.live) node.style.removeProperty('opacity');
      for (const node of this.pool) node.style.removeProperty('opacity');
      this.hazed = false;
    }
  }

  /**
   * Aerial perspective: rows away from the middle of the viewport sit back a
   * little, so a long grid has a focal plane instead of being a flat wall.
   *
   * Distance, not depth — the ramp is opacity only, and deliberately so.
   * Scaling or translating the rows would be a second transform fighting the
   * one that positions them, and a third fighting `.card:hover`; the row's
   * transform channel is spoken for. Haze is how distance reads in the real
   * world anyway, and opacity is a compositor property, so a write per live
   * row costs a fraction of what re-laying one out would.
   *
   * The curve is squared, which keeps the middle of the screen flat and puts
   * all of the falloff in the last stretch — a library is for reading, and a
   * grid that dims everything you are not looking straight at is a grid you
   * cannot scan.
   */
  paintDepth(scrollTop, height) {
    const centre = scrollTop + height / 2;
    const half = height / 2 || 1;
    for (const [r, node] of this.live) {
      const mid = r * this.rowHeight + this.rowHeight / 2;
      const d = Math.min(1, Math.abs(mid - centre) / half);
      node.style.opacity = (1 - d * d * 0.34 * this.depth).toFixed(3);
    }
  }

  createRow() {
    const row = document.createElement('div');
    row.className = 'v-grid-row';
    return row;
  }

  fillRow(row, r) {
    const from = r * this.cols;
    for (let c = 0; c < this.cols; c++) {
      let cell = row.children[c];
      if (!cell) { cell = this.create(); row.appendChild(cell); }
      const item = this.items[from + c];
      if (item) { cell.hidden = false; this.render(cell, item, from + c); }
      else { cell.hidden = true; }
    }
    while (row.children.length > this.cols) row.lastChild.remove();
  }

  refresh() { for (const [r, node] of this.live) this.fillRow(node, r); }

  /** Index order in the DOM. See `VirtualList.orderRows` for why it matters. */
  orderRows() {
    let last = -1;
    for (const node of this.layer.children) {
      if (node.hidden) continue;
      const r = +node.dataset.row;
      if (r < last) {
        for (const j of [...this.live.keys()].sort((a, b) => a - b)) {
          this.layer.appendChild(this.live.get(j));
        }
        return;
      }
      last = r;
    }
  }

  recycleAll() {
    for (const [r, node] of this.live) { node.hidden = true; this.pool.push(node); }
    this.live.clear();
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
    this.sizer.remove();
  }
}
