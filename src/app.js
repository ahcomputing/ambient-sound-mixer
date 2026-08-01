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

/* The one row whose volume slider is showing, or null. Only ever set by tapping
 * a sound; every other control clears it, so a stray scroll near Play/Stop or
 * the preset list can never land on a slider. */
let focusedId = null;


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

function setFocus(id) {
  focusedId = id;
  view.setFocus(id);
}

/* Tapping a row's body selects it as the one showing its volume. On a row that
 * is off, it switches it on as well — otherwise the gesture would reveal a
 * slider for something silent, and spec §1 says volume is only meaningful on a
 * sound that is playing. */
async function onFocusRow(id) {
  const sound = catalog.sounds.get(id);
  if (!sound || sound.missing) return;
  if (state.get(id)?.enabled) { setFocus(id); return; }
  view.setChecked(id, true);
  await onToggle(id, true);
}

async function onToggle(id, checked) {
  pending.delete(id);
  // Clear the dashed border unconditionally: touching a restored row resolves
  // it either way, and setPlaying only clears pending when it turns a row ON —
  // so unchecking one used to leave it looking like it was still waiting.
  view.setPending(id, false);
  refreshResumeBanner();
  state.setEnabled(id, checked);
  setFocus(checked ? id : (focusedId === id ? null : focusedId));

  if (!checked) {
    engine.stop(id);
    view.setPlaying(id, false);
  } else {
    view.setPlaying(id, await startRow(id));
  }
  refreshTransport();
}

function onVolume(id, value) {
  state.setVolume(id, value);
  engine.setVolume(id, value);          // no-op when the row is not playing
  refreshTransport();                   // may have made the active preset dirty
}

/* Starts every enabled row that is not missing. Shared by the resume banner,
 * the master button and preset loading — allSettled throughout, because one bad
 * file must never block the rest of the mix. */
async function startEnabled() {
  const ids = state.enabledIds().filter((id) => !catalog.sounds.get(id)?.missing);
  pending.clear();
  ids.forEach((id) => view.setPending(id, false));
  refreshResumeBanner();
  const results = await Promise.allSettled(ids.map(startRow));
  results.forEach((r, i) => view.setPlaying(ids[i], r.value === true));
  refreshTransport();
}

async function onResume() {
  setFocus(null);
  await startEnabled();
}

/* One control for "make it all stop" and "start it again". Stops the sources
 * rather than ducking the master gain: an oscillator left running silently all
 * night is battery for nothing. The checkboxes stay checked, so Play restores
 * exactly what was on. */
async function onMasterToggle() {
  setFocus(null);
  if (engine.activeIds().length) {
    for (const id of engine.activeIds()) {
      engine.stop(id);
      view.setPlaying(id, false);
    }
    refreshTransport();
    return;
  }
  await startEnabled();
}

async function onLoadPreset(id) {
  const mix = state.loadPreset(id);
  if (!mix) return;

  for (const active of engine.activeIds()) {
    engine.stop(active);
    view.setPlaying(active, false);
  }
  pending.clear();
  for (const rowId of catalog.sounds.keys()) view.setPending(rowId, false);
  view.applyMix(mix);                   // also clears the focused row
  focusedId = null;
  refreshResumeBanner();
  await startEnabled();
}

function onSavePreset(name) {
  setFocus(null);
  state.savePreset(name);
  refreshTransport();
}

function onDeletePreset(id) {
  setFocus(null);
  state.deletePreset(id);
  refreshTransport();
}

/* Keeps the master button and the "what am I playing" line honest. */
function refreshTransport() {
  const playing = engine.activeIds().length > 0;
  const selected = state.enabledIds().length;
  view.setMaster(playing ? 'playing' : (selected ? 'ready' : 'empty'));

  const active = state.activePreset();
  const dirty = state.isDirty();
  view.setNowPlaying(
    active ? active.name : (selected ? 'Custom mix' : 'Nothing selected'),
    [
      selected ? `${selected} sound${selected === 1 ? '' : 's'}` : '',
      playing ? 'playing' : (selected ? 'stopped' : ''),
      active && dirty ? 'edited' : '',
    ].filter(Boolean).join(' · '),
  );

  view.renderPresets(state.listPresets(), active?.id ?? null);
}

async function main() {
  if (!engine.isSupported()) {
    view.showFatal('This browser has no Web Audio support, so the mixer cannot run.');
    return;
  }

  catalog = await loadCatalog();
  const mix = state.load(catalog.sounds);
  view.mount(root, catalog, mix, {
    onToggle, onVolume, onResume, onFocusRow,
    onClearFocus: () => setFocus(null),
    onMasterToggle, onLoadPreset, onSavePreset, onDeletePreset,
  });

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
  refreshTransport();

  keepalive.install({
    resume: engine.resume,
    activeIds: engine.activeIds,
    /* The lock-screen pause. Leaves the checkboxes alone so the mix survives —
     * a pocket-tap must not wipe what was selected, only silence it. That makes
     * it identical to the master Stop button, which is the point. */
    stopAll: () => {
      for (const id of engine.activeIds()) {
        engine.stop(id);
        view.setPlaying(id, false);
      }
      refreshTransport();
    },
    startAll: () => { startEnabled(); },
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
