/* offline.js — registering the service worker, and telling you when it moved.
 *
 * The worker itself is sw.js; this is only the page's half of the arrangement.
 * Two jobs, and the second is the one that matters:
 *
 *   1. register, once, after the app has finished starting. Never during boot:
 *      registration competes with the very files it is trying to cache, and
 *      the one thing this must not do is make the first launch slower.
 *
 *   2. notice when a new version is waiting, and *say so*. A cached shell that
 *      updates silently is how somebody ends up running last month's build for
 *      a year without knowing there was a newer one — and on a local-first app
 *      with no server telling them otherwise, they would never find out.
 *
 * A file:// page has no service worker and never will; that is not a failure,
 * it is what the protocol allows, and it is why this reports rather than
 * throws.
 */

import { toast } from './ui.js';

const SUPPORTED = typeof navigator !== 'undefined' &&
                  'serviceWorker' in navigator &&
                  location.protocol.startsWith('http');

let registration = null;

/** What the offline state is, for Settings and for a bad afternoon. */
export function status() {
  return {
    supported: SUPPORTED,
    registered: !!registration,
    controlled: !!(SUPPORTED && navigator.serviceWorker.controller),
    waiting: !!(registration && registration.waiting),
  };
}

/** Roughly how much has been cached, for the readout. */
export async function cachedBytes() {
  if (!SUPPORTED || !('caches' in self)) return null;
  try {
    const names = (await caches.keys()).filter((n) => n.startsWith('sonora-shell-'));
    let total = 0, files = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (!res) continue;
        files++;
        const len = res.headers.get('content-length');
        if (len) total += Number(len) || 0;
        else total += (await res.clone().blob()).size;
      }
    }
    return { files, bytes: total };
  } catch { return null; }
}

/**
 * Offers the update rather than taking it.
 *
 * Reloading underneath somebody mid-track is worse than being one version
 * behind, so this asks. `skip-waiting` promotes the waiting worker, and the
 * `controllerchange` that follows is what actually reloads the page — reloading
 * before the new worker has control would just re-serve the old shell.
 */
function offerUpdate(waiting) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return;
    reloading = false;
    location.reload();
  });

  toast('A new version of Sonora is ready', {
    action: {
      label: 'Reload',
      onSelect: () => {
        reloading = true;
        waiting.postMessage({ type: 'skip-waiting' });
      },
    },
    duration: 12000,
  });
}

function watch(reg) {
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener('statechange', () => {
      /* `installed` with a controller already present means this is an update
         rather than a first install. Without that second test, the very first
         visit would be told a new version is ready — which it is, in the
         narrow sense, and which would be nonsense to read. */
      if (next.state === 'installed' && navigator.serviceWorker.controller) {
        offerUpdate(next);
      }
    });
  });
}

/**
 * Registers the worker. Safe to call more than once; safe to call anywhere it
 * cannot work.
 */
export async function startOffline() {
  if (!SUPPORTED || registration) return status();
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    watch(registration);
  } catch (err) {
    // A page served from file://, a browser with workers disabled, a private
    // window that declines. None of it is fatal and none of it is worth an
    // error in somebody's console.
    registration = null;
  }
  return status();
}

/** Removes the worker and everything it cached. For the Settings panel. */
export async function clearOffline() {
  if (!SUPPORTED) return false;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const names = (await caches.keys()).filter((n) => n.startsWith('sonora-shell-'));
    await Promise.all(names.map((n) => caches.delete(n)));
    registration = null;
    return true;
  } catch { return false; }
}
