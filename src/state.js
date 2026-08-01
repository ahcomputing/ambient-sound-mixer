/* The persisted mix: which rows are on, and at what volume.
 *
 * No DOM, no audio. Goes through storage.js — never localStorage directly, so
 * it stays namespaced, survives corrupt values and gets export/import for free.
 */

import * as storage from './storage.js';

const KEY = 'mix';
const WRITE_DELAY = 300;     // a slider drag fires ~60x/s; batch it

let mix = {};
let timer = null;

/* Reading is where this module earns its keep. Every branch below is a real
 * failure mode, and the cost of getting one wrong is paid at 3am. */
export function load(sounds) {
  const raw = storage.get(KEY, null);
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  mix = {};
  for (const [id, sound] of sounds) {
    const saved = src[id];
    const savedVolume = (saved && typeof saved === 'object') ? saved.volume : undefined;

    /* Number.isFinite, not truthiness. `saved.volume || 60` turns a deliberate
     * 0 into 60 — a sound the user muted comes back at 60% in the dark. */
    const volume = Number.isFinite(savedVolume)
      ? Math.min(100, Math.max(0, Math.round(savedVolume)))
      : sound.defaultVolume;

    /* Fail closed. Anything non-boolean reads as off, because the cost of
     * failing open is unexpected noise in a bedroom. */
    mix[id] = { enabled: saved?.enabled === true, volume };
  }
  // Ids in storage that are no longer in the catalog are simply not copied
  // across, and disappear on the next write.
  return mix;
}

export function get(id) {
  return mix[id];
}

export function all() {
  return mix;
}

export function enabledIds() {
  return Object.keys(mix).filter((id) => mix[id].enabled);
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; storage.set(KEY, mix); }, WRITE_DELAY);
}

export function setEnabled(id, on) {
  if (!mix[id]) return;
  mix[id].enabled = !!on;
  flush();                    // a toggle is deliberate and rare — write it now
}

export function setVolume(id, volume) {
  if (!mix[id]) return;
  mix[id].volume = Math.min(100, Math.max(0, Math.round(volume)));
  schedule();
}

/* CLAUDE.md: optimistic UI must persist, not just live in memory. A volume set
 * at bedtime that never got flushed before the phone slept is a lost setting,
 * so app.js calls this on visibilitychange and pagehide too. */
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  storage.set(KEY, mix);
}
