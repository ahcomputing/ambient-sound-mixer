/* Install UX. Two paths, because Chrome and iOS Safari share nothing here.
 *
 * Chrome/Edge/Android fire `beforeinstallprompt`, which index.html stashes on
 * window.__deferredPrompt from an inline script in <head>. That inline stash is
 * load-bearing: the event can fire before this module executes and it does not
 * replay, so registering the listener only here means the button never appears.
 *
 * iOS Safari has no equivalent API at all — the best available is telling the
 * user where the Share menu is.
 */

import * as storage from './storage.js';

const DISMISS_KEY = 'ios-install-dismissed';

const isIos = () => /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // navigator.standalone is undefined off iOS, so test for true explicitly.
  navigator.standalone === true;

export function init() {
  if (isStandalone()) return;      // already installed; nothing to offer

  wireAndroidButton();
  if (isIos()) wireIosBanner();

  window.addEventListener('appinstalled', () => {
    hide('install-button');
    hide('ios-banner');
    window.__deferredPrompt = null;
  });
}

function wireAndroidButton() {
  const button = document.getElementById('install-button');
  if (!button) return;

  const reveal = () => { button.hidden = false; };

  if (window.__deferredPrompt) reveal();
  // Also catch it if it fires after this module loads.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__deferredPrompt = e;
    reveal();
  });

  button.addEventListener('click', async () => {
    const deferred = window.__deferredPrompt;
    if (!deferred) return;

    button.disabled = true;
    deferred.prompt();
    try {
      const { outcome } = await deferred.userChoice;
      console.info(`[install] user ${outcome}`);
    } catch (err) {
      console.warn('[install] prompt failed', err);
    }
    // The event is single-use. Holding a spent one just breaks the next click.
    window.__deferredPrompt = null;
    button.hidden = true;
    button.disabled = false;
  });
}

function wireIosBanner() {
  if (storage.get(DISMISS_KEY, false)) return;   // don't nag every visit

  const banner = document.getElementById('ios-banner');
  const dismiss = document.getElementById('ios-dismiss');
  if (!banner) return;

  banner.hidden = false;
  dismiss?.addEventListener('click', () => {
    banner.hidden = true;
    storage.set(DISMISS_KEY, true);
  });
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
