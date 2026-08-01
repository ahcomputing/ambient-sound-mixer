/* Namespaced, versioned localStorage wrapper.
 *
 * Every app in this fleet re-invents this. It lives in the template so it stops
 * being re-invented, and so schema migration exists from day one — retrofitting
 * it later is how a v2 becomes a data-loss event.
 *
 * iOS caveat worth repeating in your app's README: Safari evicts all
 * script-writable storage after ~7 days without use UNLESS the PWA is installed
 * to the home screen. A user who visits in the browser and comes back next month
 * finds their data gone. That is platform behaviour, not a bug to hunt.
 */

const NAMESPACE = 'sounds';

/* Bump when the SHAPE of stored data changes, then handle the old shape in
 * migrate() below. Not related to CACHE_VERSION in sw.js — that's about code,
 * this is about data. */
export const SCHEMA_VERSION = 1;

const VERSION_KEY = `${NAMESPACE}:__schema`;
const key = (k) => `${NAMESPACE}:${k}`;

/* Called once on load when the stored schema version is behind SCHEMA_VERSION.
 * Return the migrated payload. Keep each step small and additive.
 *
 *   if (from < 2) data.notes = data.notes.map(n => ({ ...n, pinned: false }));
 */
function migrate(from, to, data) {
  return data;
}

export function get(k, fallback = null) {
  try {
    const raw = localStorage.getItem(key(k));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    // Corrupt value, quota-cleared, or storage disabled entirely (private mode,
    // embedded webview). A bad read must never white-screen the app.
    return fallback;
  }
}

export function set(k, value) {
  try {
    localStorage.setItem(key(k), JSON.stringify(value));
    return true;
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      console.warn(`[storage] quota exceeded writing "${k}"`);
    } else {
      console.warn(`[storage] write failed for "${k}"`, err);
    }
    return false;
  }
}

export function remove(k) {
  try { localStorage.removeItem(key(k)); } catch { /* nothing useful to do */ }
}

/* Every key this app owns, unprefixed. */
function ownKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full?.startsWith(`${NAMESPACE}:`) && full !== VERSION_KEY) {
        out.push(full.slice(NAMESPACE.length + 1));
      }
    }
  } catch { /* storage unavailable */ }
  return out;
}

/* For a local-first app with no backend this is the only backup that exists. */
export function exportAll() {
  const data = {};
  for (const k of ownKeys()) data[k] = get(k);
  return { app: NAMESPACE, schema: SCHEMA_VERSION, exported: new Date().toISOString(), data };
}

export function downloadExport(filename = `${NAMESPACE}-backup.json`) {
  const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Replaces everything this app owns. Returns { ok, error }. */
export function importAll(json) {
  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (!parsed || typeof parsed.data !== 'object' || parsed.data === null) {
    return { ok: false, error: 'Not an export from this app.' };
  }
  if (parsed.app && parsed.app !== NAMESPACE) {
    return { ok: false, error: `That backup is from "${parsed.app}".` };
  }

  let data = parsed.data;
  const from = Number(parsed.schema) || 1;
  if (from > SCHEMA_VERSION) {
    return { ok: false, error: 'That backup is from a newer version of this app.' };
  }
  if (from < SCHEMA_VERSION) data = migrate(from, SCHEMA_VERSION, data);

  for (const k of ownKeys()) remove(k);
  for (const [k, v] of Object.entries(data)) set(k, v);
  set('__schema', SCHEMA_VERSION);
  return { ok: true };
}

/* Run once at startup, before the app reads anything. */
export function init() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(VERSION_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  const from = Number(stored) || 0;

  if (from === 0) {
    set('__schema', SCHEMA_VERSION);          // fresh install, or pre-versioning
    return;
  }
  if (from === SCHEMA_VERSION) return;
  if (from > SCHEMA_VERSION) {
    console.warn(`[storage] data is schema v${from}, app expects v${SCHEMA_VERSION}`);
    return;
  }

  const data = {};
  for (const k of ownKeys()) data[k] = get(k);
  const migrated = migrate(from, SCHEMA_VERSION, data);
  for (const [k, v] of Object.entries(migrated)) set(k, v);
  set('__schema', SCHEMA_VERSION);
}
