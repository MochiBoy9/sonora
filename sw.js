/* sw.js — keeping the promise the specification opens with.
 *
 * "Opens offline, on a plane, forever." That has always been true of the
 * library — it is in IndexedDB, and reconnecting to disk happens after first
 * paint — and it has never been true of the application, which was fetched
 * from a server on every single launch. Take the network away and you did not
 * get a music player with unreachable files; you got a browser error page.
 *
 * This is the smallest change on the list and the only one that adds no
 * promise. It keeps one that was already made.
 *
 * ------------------------------------------------------------------ the rule
 *
 * There is one piece of discipline here that matters more than the code, and
 * it is the reason a service worker in this application is worth being careful
 * about at all: **it caches only Sonora's own files and never fetches anything
 * else at runtime.**
 *
 * A service worker sees every request the page makes. One that opportunistically
 * caches whatever goes past would be exactly the thing this app has spent its
 * whole life promising not to be, and it would be invisible from the outside —
 * no setting to check, no request in the network panel, just a widening cache
 * nobody asked for. So the fetch handler below is deliberately narrow: it
 * answers for the shell and it declines to involve itself in anything else.
 *
 * In particular, a cross-origin request — the one online feature this app has,
 * the optional lyrics and band lookup — is not intercepted at all. Not cached,
 * not inspected, not counted. `respondWith` is never called for it, so the
 * browser handles it exactly as it would with no service worker installed.
 *
 * ------------------------------------------------------------------ updating
 *
 * A cached shell that will not update is worse than no cache. Three things
 * make that safe:
 *
 *   - VERSION below is the cache name. Change it and every file is fetched
 *     again; leave it and nothing is. There is no build step in this project,
 *     so it is a constant a person edits, and it is the first line of the file
 *     for that reason.
 *   - old caches are deleted on activate, so a stale shell cannot survive.
 *   - the page is told when a new worker is waiting, and offers to reload.
 *     A silent update to a local-first app is how somebody ends up running
 *     last month's build for a year.
 */

const VERSION = 'sonora-shell-v1';

/* Everything the application is made of, and nothing else.
 *
 * Listed explicitly rather than discovered, because a service worker cannot
 * read a directory and a wildcard would be a lie: the only honest way to know
 * what the shell contains is to say so. 45 files, about 840 KB.
 *
 * The worklets and workers are here too. They are fetched by the audio thread
 * and by `new Worker`, which go through the service worker like anything else
 * — and a player that opens offline but cannot pitch-shift or import a file
 * has not really opened offline. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',

  './css/aero.css',
  './css/base.css',
  './css/components.css',
  './css/intro.css',
  './css/layout.css',
  './css/sound.css',
  './css/views.css',
  './css/visualizer.css',

  './js/app.js',
  './js/audio.js',
  './js/backdrop.js',
  './js/band.js',
  './js/circles.js',
  './js/db.js',
  './js/gl.js',
  './js/intro.js',
  './js/library.js',
  './js/looks.js',
  './js/lyrics.js',
  './js/metadata.worker.js',
  './js/meter-worklet.js',
  './js/motion.js',
  './js/offline.js',
  './js/peaks.js',
  './js/peaks.worker.js',
  './js/pitch-worklet.js',
  './js/player.js',
  './js/playerbar.js',
  './js/queue.js',
  './js/relief.js',
  './js/session.js',
  './js/sound.js',
  './js/stage.js',
  './js/stats.js',
  './js/tags.js',
  './js/ui.js',
  './js/util.js',
  './js/views.js',
  './js/virtual.js',
  './js/visualizer-draw.js',
  './js/visualizer.js',
  './js/visualizer.worker.js',
];

/* ------------------------------------------------------------------ install */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* One at a time rather than `cache.addAll`, which rejects the whole batch
       if any single request fails. A shell that is missing one stylesheet
       should still install and serve the other forty-four — the alternative is
       an app that silently refuses to work offline because one file was
       renamed. */
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* logged by the browser; the rest of the shell still lands */ }
    }));
  })());
});

/* ------------------------------------------------------------------ activate */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('sonora-shell-') && n !== VERSION)
           .map((n) => caches.delete(n)),
    );
    // Take over open tabs immediately. Without this the new worker sits idle
    // until every tab is closed, which for an app people leave open is never.
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever GET. A service worker has no business in anything else.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Not ours: not our business. This is the rule at the top of the file, and
     it is enforced by *not calling respondWith* — the browser then handles the
     request exactly as it would if no worker were installed. The optional
     online lookups go out this way, uncached and unseen. */
  if (url.origin !== self.location.origin) return;

  /* A navigation is answered with the shell's index.html, so a reload at
     `#/albums` works offline. The hash never reaches the server anyway. */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try { return await fetch(req); }
      catch { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
    })());
    return;
  }

  /* Same-origin, and part of the shell: cache first, always. These files only
     change when the version does, so there is nothing to revalidate. */
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    /* Same-origin but not in the shell — an audio file served over HTTP, say,
       or something added after this worker was written. Fetched, and
       deliberately *not* cached: the shell is a fixed list, and a cache that
       grows on its own is the thing this file exists to avoid. */
    try {
      return await fetch(req);
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

/* ------------------------------------------------------------------ messages */

self.addEventListener('message', (event) => {
  // The page asking the waiting worker to take over now, because somebody
  // pressed "Reload".
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
