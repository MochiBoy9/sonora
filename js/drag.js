/* drag.js — what is currently being dragged, and who will take it.
 *
 * C1/C2/C3. Until now the only thing in Sonora that could be dragged was a
 * playlist in the sidebar and a row in the queue, and both of those dragged
 * only among themselves. Everything else — putting a track on a playlist,
 * putting a record in the queue, moving a selection of forty songs somewhere —
 * went through a context menu, which works and is the slow path for the one
 * operation people do most.
 *
 * The payload lives here rather than in the `DataTransfer`, for a reason that
 * is not obvious: during `dragover` the browser will tell a drop target which
 * *types* are on offer but refuses to hand over the data, so a target that
 * needs to know whether it wants this drag cannot ask. A module-level variable
 * is visible the whole time. The DataTransfer still carries a plain-text
 * fallback so a drag out of the window lands as a list of titles somewhere
 * useful, and a private MIME type so a target can recognise its own kind.
 */

import * as lib from './library.js';

export const MIME = 'application/x-sonora-tracks';

/** The drag in progress, or null between drags. */
let payload = null;

/**
 * Announces a drag of tracks.
 *
 * `ids` is the whole of it — a single row is a list of one, so nothing
 * downstream needs two paths. `label` is what a toast will call it afterwards.
 */
export function startTrackDrag(e, ids, label) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return false;
  payload = { kind: 'tracks', ids: list, label: label || '' };
  document.documentElement.classList.add('is-dragging-tracks');
  const dt = e.dataTransfer;
  if (!dt) return true;
  dt.effectAllowed = 'copyMove';
  try {
    dt.setData(MIME, list.join('\n'));
    // The names, for anything outside this window that will take text.
    dt.setData('text/plain', list
      .slice(0, 200)
      .map((id) => (lib.getTrack(id) || {}).title || id)
      .join('\n'));
  } catch { /* Safari refuses custom types in some versions; the module still knows */ }
  if (list.length > 1) dt.setDragImage?.(ghost(list.length), 18, 18);
  return true;
}

/** Announces a drag of whole albums, which is a drag of their tracks. */
export function startAlbumDrag(e, albumKeys, label) {
  const ids = [];
  for (const key of albumKeys) {
    const al = lib.state.albumBy.get(key);
    if (al) for (const t of al.tracks) ids.push(t.id);
  }
  return startTrackDrag(e, ids, label);
}

export function endDrag() {
  payload = null;
  document.documentElement.classList.remove('is-dragging-tracks');
  for (const n of document.querySelectorAll('.is-drop-tracks')) n.classList.remove('is-drop-tracks');
}

/** What is being dragged right now, for a target deciding whether to accept. */
export const dragging = () => payload;
export const draggingTracks = () => (payload && payload.kind === 'tracks' ? payload : null);

/**
 * Makes one element a drop target for tracks.
 *
 * Returns an unsubscribe, because half the things that want to be targets are
 * rows in a list that is repainted every time the library changes.
 */
export function acceptTracks(node, onDrop, { className = 'is-drop-tracks' } = {}) {
  const over = (e) => {
    const p = draggingTracks();
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add(className);
  };
  const leave = (e) => {
    // A dragleave fires for every child the pointer crosses; only the one that
    // actually leaves the target counts.
    if (e.relatedTarget && node.contains(e.relatedTarget)) return;
    node.classList.remove(className);
  };
  const drop = (e) => {
    const p = draggingTracks();
    node.classList.remove(className);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(p.ids, p);
    endDrag();
  };
  node.addEventListener('dragover', over);
  node.addEventListener('dragenter', over);
  node.addEventListener('dragleave', leave);
  node.addEventListener('drop', drop);
  return () => {
    node.removeEventListener('dragover', over);
    node.removeEventListener('dragenter', over);
    node.removeEventListener('dragleave', leave);
    node.removeEventListener('drop', drop);
  };
}

/* A badge for a multiple drag, because the default drag image of a table row
   is the row — which for forty rows is one row and a lie about what is moving.
   Built into the document because a detached node does not rasterise, put
   off screen, and swept on the next frame once the browser has taken its
   snapshot. */
function ghost(n) {
  const node = document.createElement('div');
  node.className = 'drag-ghost';
  node.textContent = String(n);
  document.body.appendChild(node);
  requestAnimationFrame(() => node.remove());
  return node;
}
