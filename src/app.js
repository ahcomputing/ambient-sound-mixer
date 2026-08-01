/* Entry point and controller. Keeps the layers wired without letting any of
 * them know about the others: catalog knows no DOM, engine knows no storage,
 * state knows no audio, view knows neither.
 *
 * Storage init runs first so anything reading data sees a migrated schema.
 */

import * as storage from './storage.js';
import * as swUpdate from './sw-update.js';
import * as installPrompt from './install-prompt.js';

import { loadCatalog } from './catalog.js';
import * as engine from './engine.js';
import * as state from './state.js';
import * as view from './view.js';
import * as keepalive from './keepalive.js';

storage.init();
swUpdate.register('./sw.js');
installPrompt.init();

const root = document.getElementById('mixer');
let catalog = null;

/* Rows the user had on last time that cannot legally start without a tap. The
 * checkbox shows the saved intent; this set is what the resume banner acts on. */
const pending = new Set();

function labelsFor(ids) {
  return ids.map((id) => catalog.sounds.get(id)?.label ?? id);
}

function refreshResumeBanner() {
  if (pending.size) view.showResume(pending.size);
  else view.hideResume();
}

/* Turning a row on is the only path that can fail, so it owns the error
 * handling for the whole app. */
async function startRow(id) {
  const sound = catalog.sounds.get(id);
  if (!sound || sound.missing) return false;

  view.setBusy(id, true);
  view.setNote(id, '');
  try {
    await engine.start(sound, state.get(id).volume);
    return true;
  } catch (err) {
    // Revert the checkbox: never show an action as accepted when it was not.
    view.setChecked(id, false);
    state.setEnabled(id, false);

    if (err?.kind === 'offline') {
      // Transient. Disabling the row here would strand it after one bad moment
      // on the wifi, so it says what happened and stays tappable.
      view.setNote(id, 'not downloaded yet — connect once and try again');
    } else if (err?.kind === 'decode') {
      view.setMissing(id, 'audio file unreadable');
    } else {
      view.setMissing(id, 'audio file missing');
    }
    console.warn(`[app] could not start ${id}`, err);
    return false;
  } finally {
    view.setBusy(id, false);
  }
}

async function onToggle(id, checked) {
  pending.delete(id);
  // Clear the dashed border unconditionally: touching a restored row resolves
  // it either way, and setPlaying only clears pending when it turns a row ON —
  // so unchecking one used to leave it looking like it was still waiting.
  view.setPending(id, false);
  refreshResumeBanner();
  state.setEnabled(id, checked);

  if (!checked) {
    engine.stop(id);
    view.setPlaying(id, false);
    return;
  }
  view.setPlaying(id, await startRow(id));
}

function onVolume(id, value) {
  state.setVolume(id, value);
  engine.setVolume(id, value);          // no-op when the row is not playing
}

async function onResume() {
  const ids = [...pending];
  pending.clear();
  ids.forEach((id) => view.setPending(id, false));   // resolved, whatever happens next
  refreshResumeBanner();
  // allSettled: one bad file must not block the rest of the mix.
  const results = await Promise.allSettled(ids.map(startRow));
  results.forEach((r, i) => view.setPlaying(ids[i], r.value === true));
}

async function main() {
  if (!engine.isSupported()) {
    view.showFatal('This browser has no Web Audio support, so the mixer cannot run.');
    return;
  }

  catalog = await loadCatalog();
  const mix = state.load(catalog.sounds);
  view.mount(root, catalog, mix, { onToggle, onVolume, onResume });

  /* Restore positions but start nothing — the autoplay policy needs a tap
   * regardless, so a returning user gets their exact mix back in one press
   * instead of re-checking every box (spec §6). */
  for (const [id, sound] of catalog.sounds) {
    if (mix[id].enabled && !sound.missing) {
      pending.add(id);
      view.setPending(id, true);
    }
  }
  refreshResumeBanner();

  keepalive.install({
    resume: engine.resume,
    activeIds: engine.activeIds,
    stopAll: () => {
      for (const id of engine.activeIds()) {
        engine.stop(id);
        view.setPlaying(id, false);
        view.setChecked(id, false);
        state.setEnabled(id, false);
      }
    },
    onGiveUp: () => {
      const id = engine.activeIds()[0];
      if (id) view.setNote(id, 'audio was interrupted — uncheck and check again to resume');
    },
  });

  engine.onChange(({ activeIds, state: ctxState }) => {
    keepalive.sync({ activeIds, labels: labelsFor(activeIds), state: ctxState });
  });

  /* A volume set at bedtime that never made it out of the debounce before the
   * phone slept is a lost setting. */
  window.addEventListener('pagehide', state.flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') state.flush();
  });
}

main().catch((err) => {
  console.error('[app] failed to start', err);
  view.showFatal('Something went wrong starting the mixer. Reload to try again.');
});
