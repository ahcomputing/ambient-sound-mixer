/* "New version available" toast.
 *
 * Without this, an installed PWA can sit on old code until the user force-quits
 * it — the exact complaint that makes people stop trusting installed web apps.
 * sw.js deliberately does NOT call skipWaiting() on install; this module decides
 * when the swap happens, on a user click.
 */

let reloading = false;

export function register(swUrl = './sw.js') {
  if (!('serviceWorker' in navigator)) return;

  // sw.js calls clients.claim() on activate, which fires controllerchange on a
  // page that never had a controller — i.e. on every FIRST visit. Reloading
  // there is pointless (nothing is stale yet) and in this app it is destructive:
  // it kills whatever is playing. Worse, the media precache warm runs inside
  // install's waitUntil, so activate lands 10-30s in — right in the middle of
  // listening. Only reload when we are genuinely swapping one controller out.
  const hadController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', async () => {
    let reg;
    try {
      // updateViaCache: 'none' — never let the HTTP cache serve the SW script
      // itself, or an update check can be answered with the old worker.
      reg = await navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' });
    } catch (err) {
      console.warn('[sw] registration failed', err);
      return;
    }

    // A worker already waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) showToast(reg);

    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // `controller` present means this is an update, not a first install.
        // On a first install there is nothing to tell the user about.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showToast(reg);
        }
      });
    });

    // Installed PWAs sit backgrounded for days. Without this the user has to
    // fully kill the app to get an update check.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;   // first install, or already going
      reloading = true;
      window.location.reload();
    });
  });
}

function showToast(reg) {
  const toast = document.getElementById('update-toast');
  const button = document.getElementById('update-reload');
  if (!toast || !button) {
    console.warn('[sw] update available, but #update-toast is missing from the page');
    return;
  }

  toast.hidden = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    // The reload happens in the controllerchange handler above, once the new
    // worker has actually taken over. Reloading here would race it.
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
  }, { once: true });
}
