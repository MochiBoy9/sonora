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

/* ------------------------------------------------------------------ H5
 *
 * Installing it.
 *
 * There is a manifest, a service worker, an offline shell and an update
 * notice — everything a progressive web app needs except the moment where it
 * offers to become one. On a phone that moment is the difference between a
 * bookmark and something on the home screen with no browser furniture around
 * it, which for a full-screen music player is most of the point.
 *
 * The browser fires `beforeinstallprompt` once, early, and expects the page to
 * hold onto it and call `prompt()` from inside a real gesture later. So this
 * catches it at module load — before anything asks — and then does nothing
 * until somebody presses a button. Nothing pops up on its own: an app that
 * asks to be installed the first time you open it is an app you close.
 *
 * Firefox and desktop Safari never fire it. `canInstall()` returns false there
 * and the button is simply absent, which is honest — an install button that
 * explains it cannot install is worse than no button.
 */

let installEvent = null;
let installed = false;

if (typeof addEventListener === 'function') {
  addEventListener('beforeinstallprompt', (e) => {
    // Held rather than allowed to run: the default is a browser-chosen moment,
    // and this app has a better one.
    e.preventDefault();
    installEvent = e;
    document.dispatchEvent(new CustomEvent('sonora:installable'));
  });
  addEventListener('appinstalled', () => {
    installed = true;
    installEvent = null;
    document.dispatchEvent(new CustomEvent('sonora:installable'));
  });
}

/** Whether an install can be offered right now. */
export const canInstall = () => !!installEvent && !isInstalled();

/**
 * Whether this is already the installed copy.
 *
 * `display-mode: standalone` is what a launched PWA reports, and iOS Safari —
 * which has no install event at all — sets `navigator.standalone` instead.
 */
export function isInstalled() {
  if (installed) return true;
  try {
    if (matchMedia('(display-mode: standalone)').matches) return true;
    if (matchMedia('(display-mode: window-controls-overlay)').matches) return true;
  } catch { /* an old browser with no matchMedia for display-mode */ }
  return !!navigator.standalone;
}

/**
 * Asks. Must be called from inside a user gesture or the browser refuses.
 *
 * Returns 'accepted', 'dismissed', or 'unavailable'. The event is single-use
 * whatever the answer, so it is dropped either way — a second press of a
 * button that silently does nothing is worse than the button going away.
 */
export async function install() {
  if (!installEvent) return 'unavailable';
  const e = installEvent;
  installEvent = null;
  document.dispatchEvent(new CustomEvent('sonora:installable'));
  try {
    e.prompt();
    const { outcome } = await e.userChoice;
    return outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
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
