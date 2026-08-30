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
    const target = align === 'center'
      ? i * this.rowHeight - (this.viewport.clientHeight - this.rowHeight) / 2
      : i * this.rowHeight;
    this.viewport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
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
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.sizer);
  }

  setItems(items) {
    this.items = items || [];
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
    this.sizer.style.height = rows * rowHeight + 'px';
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
      this.fillRow(node, r);
      if (!node.parentNode) this.layer.appendChild(node);
      node.hidden = false;
      this.live.set(r, node);
    }

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
