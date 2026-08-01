/* Keeping playback alive on Android. Pure browser-quirk code with a short shelf
 * life, which is why it is its own file: when Android changes behaviour there is
 * one place to open. It touches the engine through the two callbacks passed to
 * install() and never sees an AudioContext.
 *
 * The app's core promise is that a mix runs all night and stops only when a
 * person stops it. Three things break that on a phone, and each has a layer:
 *
 *   the OS suspends the audio session   -> audioSession + the media anchor
 *   the context is interrupted (a call) -> statechange auto-resume
 *   the tab is frozen while backgrounded-> the media anchor's foreground status
 *
 * WHY THE SILENT <audio> ANCHOR, AND WHAT IT COSTS
 * ------------------------------------------------
 * Chrome decides a page is "playing media" from HTMLMediaElement playback, not
 * from Web Audio output, and that classification is what earns the foreground
 * service that stops an OEM battery manager killing the process overnight. A
 * MUTED element gets no notification but also earns no protection — the
 * notification IS the protection, they are the same mechanism. So this ships an
 * unmuted, digitally silent, looping element, and Aaron has accepted the
 * lock-screen media notification that comes with it.
 *
 * Given the notification exists, its buttons are wired to do the right thing:
 * an unhandled pause leaves a zombie context that looks playing and is not.
 *
 * NOT DONE, deliberately: navigator.wakeLock. It keeps the display on, which
 * for a bedtime app is actively wrong. Do not add it as an "obvious" fix.
 */

/* 1s of digital silence, ~1.3KB. Inline rather than a file so it cannot 404,
 * needs no cache entry, and works on a cold offline start. */
const SILENCE = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAAKQAABOUAKiowMDU1NTo6Pz8/RUVKSkpPT1VVWlpaYGBlZWVqam9vb3V1enp6f3+FhYqKipCQlZWVmpqfn5+lpaqqsLCwtbW6urrAwMXFxcrKz8/P1dXa2uDg4OXl6urq8PD19fX6+v//AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQD3gAAAAAAAATl8EOFCwAAAAAAAAAAAAAAAAD/8xDEAAAAA0gAAAAATEFNRTMuMTBMQU1FM//zEsQNAAADSAAAAAAuMTAwVVVVVUxBTUUzLv/zEMQbAAADSAAAAAAxMDBVVVVVTEFNRTMu//MQxCgAAANIAAAAADEwMFVVVVVMQU1FMy7/8xDENQAAA0gAAAAAMTAwVVVVVUxBTUUzLv/zEMRCAAADSAAAAAAxMDBVVVVVTEFNRTMu//MQxE8AAANIAAAAADEwMFVVVVVVTEFNRTP/8xDEXAAAA0gAAAAALjEwMFVVVVVMQU1FM//zEMRpAAADSAAAAAAuMTAwVVVVVUxBTUUz//MSxHYAAANIAAAAAC4xMDBVVVVVTEFNRTMu//MQxIQAAANIAAAAADEwMFVVVVVMQU1FMy7/8xDEkQAAA0gAAAAAMTAwVVVVVUxBTUUzLv/zEMSeAAADSAAAAAAxMDBVVVVVTEFNRTMu//MQxKsAAANIAAAAADEwMFVVVVVMQU1FMy7/8xDEuAAAA0gAAAAAMTAwVVVVVVVMQU1FM//zEMTFAAADSAAAAAAuMTAwVVVVVUxBTUUz//MQxNIAAANIAAAAAC4xMDBVVVVVTEFNRTP/8xLE3wAAA0gAAAAALjEwMFVVVVVMQU1FMy7/8xDE7QAAA0gAAAAAMTAwVVVVVUxBTUUzLv/zEMTyAAADSAAAAAAxMDBVVVVVTEFNRTMu//MQxPIAAANIAAAAADEwMFVVVVVMQU1FMy7/8xDE8gAAA0gAAAAAMTAwVVVVVUxBTUUzLv/zEMTyAAADSAAAAAAxMDBVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEsTxAAADSAAAAABVVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MSxPEAAANIAAAAAFVVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVU=';

/* CLAUDE.md's circuit-breaker rule: stop after ~3 consecutive failures and make
 * the user tap. An unbounded auto-resume loop against a browser that is refusing
 * is a battery drain, not a fix. */
const BACKOFF_MS = [250, 750, 2000];

let anchor = null;
let hooks = null;
let strikes = 0;
let retrying = false;

function shouldBePlaying() {
  return hooks.activeIds().length > 0;
}

function startAnchor() {
  if (!anchor) {
    anchor = new Audio(SILENCE);
    anchor.loop = true;
    anchor.preload = 'auto';
    // NOT muted — see the header. Muted costs the protection entirely.
    anchor.volume = 1;
    anchor.dataset.role = 'keepalive';
    /* In the document rather than detached: Chrome's media handling is only
     * specified for elements in a document, and a detached one is invisible in
     * DevTools, which makes "is the anchor actually running?" unanswerable
     * exactly when you need to answer it. */
    document.body.appendChild(anchor);
  }
  anchor.play().catch(() => { /* no gesture yet; the next toggle retries */ });
}

function stopAnchor() {
  anchor?.pause();
}

function updateMediaSession(labels) {
  if (!navigator.mediaSession) return;
  const playing = labels.length > 0;
  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: labels.join(' + '),
        artist: 'Ambient Sound Mixer',
      });
    }
  } catch { /* metadata is cosmetic; never let it break playback */ }
}

async function tryResume() {
  if (retrying || !shouldBePlaying()) return;
  retrying = true;
  try {
    while (strikes < BACKOFF_MS.length) {
      if (await hooks.resume()) { strikes = 0; return; }
      await new Promise((r) => setTimeout(r, BACKOFF_MS[strikes]));
      strikes += 1;
      if (!shouldBePlaying()) return;      // stopped while we were waiting
    }
    hooks.onGiveUp?.();
  } finally {
    retrying = false;
  }
}

/* hooks: { resume() -> Promise<bool>, activeIds() -> string[],
 *          labelsFor(ids) -> string[], stopAll(), onGiveUp() } */
export function install(newHooks) {
  hooks = newHooks;

  if (navigator.mediaSession) {
    try {
      // The notification is happening, so make its buttons coherent rather than
      // leaving them to desync from what is actually playing.
      navigator.mediaSession.setActionHandler('pause', () => hooks.stopAll());
      navigator.mediaSession.setActionHandler('stop', () => hooks.stopAll());
      navigator.mediaSession.setActionHandler('play', () => { strikes = 0; tryResume(); });
    } catch { /* older Chrome rejects unknown actions */ }
  }

  // Screen unlock, task switch back, window refocus — all land here.
  for (const evt of ['visibilitychange', 'pageshow', 'focus']) {
    window.addEventListener(evt, () => {
      if (document.visibilityState === 'hidden') return;
      strikes = 0;
      tryResume();
    });
  }
}

/* Called by app.js whenever the set of playing sounds changes. */
export function sync({ activeIds, labels, state }) {
  if (activeIds.length) startAnchor(); else stopAnchor();
  updateMediaSession(labels);
  if (activeIds.length && state !== 'running') {
    strikes = 0;
    tryResume();
  }
}
