/* The persisted mix and the named presets.
 *
 * No DOM, no audio. Goes through storage.js — never localStorage directly, so
 * it stays namespaced, survives corrupt values and gets export/import for free.
 */

import * as storage from './storage.js';

const KEY = 'mix';
const PRESETS_KEY = 'presets';
const ACTIVE_KEY = 'activePreset';
const WRITE_DELAY = 300;     // a slider drag fires ~60x/s; batch it
const MAX_NAME = 40;

let catalogIds = null;       // Map<id, Sound>, kept for re-sanitising presets
let mix = {};
let presets = [];
let activeId = null;
let timer = null;

/* Sanitising is where this module earns its keep. Every branch below is a real
 * failure mode, and the cost of getting one wrong is paid at 3am.
 *
 * Shared between the live mix and presets on purpose: a preset saved before a
 * sound was added or removed has exactly the same problems as a stale mix, and
 * the theta rows really were renamed once already. */
function sanitise(sounds, raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
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
    out[id] = { enabled: saved?.enabled === true, volume };
  }
  // Ids no longer in the catalog are simply not copied across.
  return out;
}

export function load(sounds) {
  catalogIds = sounds;
  mix = sanitise(sounds, storage.get(KEY, null));

  const rawPresets = storage.get(PRESETS_KEY, null);
  presets = (Array.isArray(rawPresets) ? rawPresets : [])
    .filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
    .map((p) => ({
      id: String(p.id ?? crypto.randomUUID()),
      name: p.name.slice(0, MAX_NAME),
      mix: sanitise(sounds, p.mix),
    }));

  const savedActive = storage.get(ACTIVE_KEY, null);
  activeId = presets.some((p) => p.id === savedActive) ? savedActive : null;
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
  timer = setTimeout(() => { timer = null; flush(); }, WRITE_DELAY);
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
  storage.set(PRESETS_KEY, presets);
  storage.set(ACTIVE_KEY, activeId);
}

/* ── presets ─────────────────────────────────────────────────────────────── */

export function listPresets() {
  return presets.map((p) => ({
    id: p.id,
    name: p.name,
    count: Object.values(p.mix).filter((e) => e.enabled).length,
  }));
}

export function activePreset() {
  return presets.find((p) => p.id === activeId) ?? null;
}

/* True when the live mix has drifted from the preset it was loaded from, so the
 * UI can say "Rainy night · edited" rather than claiming to be playing
 * something it is not. That claim is the whole point of naming presets. */
export function isDirty() {
  const active = activePreset();
  if (!active) return false;
  return Object.keys(mix).some((id) => {
    const a = active.mix[id], b = mix[id];
    return !a || a.enabled !== b.enabled || a.volume !== b.volume;
  });
}

/* Saving under an existing name overwrites it rather than making a duplicate —
 * with no rename UI, two presets called "Rain" would be unfixable. */
export function savePreset(name) {
  const clean = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!clean) return null;

  const snapshot = structuredClone(mix);
  const existing = presets.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    existing.mix = snapshot;
    activeId = existing.id;
  } else {
    const preset = { id: crypto.randomUUID(), name: clean, mix: snapshot };
    presets.push(preset);
    activeId = preset.id;
  }
  flush();
  return activeId;
}

/* Returns the mix to apply, or null. Does NOT touch audio — app.js decides what
 * to start, because this module knows nothing about the engine. */
export function loadPreset(id) {
  const preset = presets.find((p) => p.id === id);
  if (!preset) return null;
  // Re-sanitised against the current catalog: a preset can outlive a sound.
  mix = sanitise(catalogIds, preset.mix);
  activeId = preset.id;
  flush();
  return mix;
}

export function deletePreset(id) {
  presets = presets.filter((p) => p.id !== id);
  if (activeId === id) activeId = null;
  flush();
}
