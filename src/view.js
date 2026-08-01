/* DOM only — no audio, no storage.
 *
 * mount() runs exactly once and nothing after it re-renders a row. Every later
 * update is a targeted attribute or class write. This is CLAUDE.md's "never
 * rebuild an input the user is focused in" applied before it can bite: a
 * re-render during a slider drag drops the drag, and on some Androids fires a
 * spurious change event on the way out.
 */

const rows = new Map();      // id -> { el, check, vol, note, value }
let resumeBanner = null;
let resumeCount = null;
let ui = null;               // the transport/preset elements, looked up once

function fill(input) {
  // WebKit paints the filled part of the track from this custom property.
  input.style.setProperty('--fill', `${input.value}%`);
}

function buildRow(sound, saved) {
  const li = document.createElement('li');
  li.className = 'srow';
  li.dataset.id = sound.id;
  /* Two separate controls, not one label wrapping everything. The checkbox is
   * on/off; the rest of the header is a button that selects this row as the one
   * whose volume is showing. They have to be separable, or the only way to
   * adjust a playing sound would be to switch it off and on again. */
  li.innerHTML = `
    <div class="srow-head">
      <label class="srow-switch"><input type="checkbox" class="srow-check"></label>
      <button type="button" class="srow-focus" aria-expanded="false">
        <svg class="srow-icon" aria-hidden="true" focusable="false"><use href="#${sound.icon}"></use></svg>
        <span class="srow-label"></span>
        <span class="srow-value"></span>
      </button>
    </div>
    ${sound.caption ? '<p class="srow-caption"></p>' : ''}
    <input type="range" class="srow-vol" min="0" max="100" step="1">
    <p class="srow-note" hidden></p>`;

  // textContent, not innerHTML — labels and captions are data.
  li.querySelector('.srow-label').textContent = sound.label;
  if (sound.caption) li.querySelector('.srow-caption').textContent = sound.caption;

  const check = li.querySelector('.srow-check');
  const focus = li.querySelector('.srow-focus');
  const vol = li.querySelector('.srow-vol');
  const note = li.querySelector('.srow-note');
  const value = li.querySelector('.srow-value');

  check.checked = saved.enabled;
  check.setAttribute('aria-label', `${sound.label} on/off`);
  focus.setAttribute('aria-label', `${sound.label} — show volume`);
  vol.value = saved.volume;
  vol.setAttribute('aria-label', `${sound.label} volume`);
  vol.disabled = true;                 // nothing is focused until something is tapped
  value.textContent = saved.volume;
  fill(vol);
  guardTrackTaps(vol);

  rows.set(sound.id, { el: li, check, focus, vol, note, value });
  return li;
}

/* Exactly one slider is visible at a time — the row you last selected — and
 * none at all after touching Play/Stop or Presets.
 *
 * This is the third iteration of the same fix. Sliders on every row, then
 * sliders on every enabled row, both still left enough draggable surface to
 * catch a thumb while scrolling and silently change the volume of something
 * that is already playing. One slider, on the row you just deliberately
 * touched, is the version that holds. */
export function setFocus(id) {
  for (const [rowId, row] of rows) {
    const on = rowId === id;
    row.el.classList.toggle('srow--open', on);
    row.vol.disabled = !on;            // also keeps it out of the tab order
    row.focus.setAttribute('aria-expanded', String(on));
  }
}

/* A range input takes its value from wherever the track is touched, so even one
 * visible slider can be nudged by a scroll that grazes it. Requiring the
 * gesture to START on the thumb removes that: dragging still works exactly as
 * before, but brushing the bar does nothing. */
function guardTrackTaps(vol) {
  vol.addEventListener('pointerdown', (e) => {
    const box = vol.getBoundingClientRect();
    const thumb = 24;                                     // matches the CSS
    const travel = box.width - thumb;
    const centre = box.left + thumb / 2 + (vol.value / 100) * travel;
    if (Math.abs(e.clientX - centre) > thumb) e.preventDefault();
  });
}

export function mount(root, catalog, state, handlers) {
  root.textContent = '';

  if (!catalog.manifestOk) {
    const notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent =
      'Could not load the audio list, so the recorded sounds are unavailable. '
      + 'The theta tone is generated live and still works.';
    root.appendChild(notice);
  }

  for (const group of catalog.groups) {
    const ids = [...catalog.sounds.values()].filter((s) => s.group === group.id);
    if (!ids.length) continue;

    const section = document.createElement('section');
    section.className = 'mix-section';
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = group.title;
    const list = document.createElement('ul');
    list.className = 'srow-list';
    for (const sound of ids) list.appendChild(buildRow(sound, state[sound.id]));
    section.append(h, list);
    root.appendChild(section);
  }

  for (const sound of catalog.sounds.values()) {
    if (sound.missing) setMissing(sound.id, sound.missingReason);
  }

  if (catalog.credits.length) {
    const p = document.createElement('p');
    p.className = 'credit-line';
    // CC BY compliance surface — deploy.sh strips *.md, so this is where the
    // attribution has to live to actually ship.
    p.append('Audio credits: ');
    catalog.credits.forEach((c, i) => {
      if (i) p.append(' · ');
      const a = document.createElement('a');
      a.href = c.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = c.credit;
      p.append(`${c.label}: `, a, ` (${c.license})`);
    });
    root.appendChild(p);
  }

  // Two delegated listeners for the whole list, so rows carry no listeners of
  // their own and nothing leaks if one is ever replaced.
  root.addEventListener('change', (e) => {
    const row = e.target.closest?.('.srow');
    if (!row || !e.target.classList.contains('srow-check')) return;
    handlers.onToggle(row.dataset.id, e.target.checked);
  });

  root.addEventListener('input', (e) => {
    const row = e.target.closest?.('.srow');
    if (!row || !e.target.classList.contains('srow-vol')) return;
    fill(e.target);
    row.querySelector('.srow-value').textContent = e.target.value;
    handlers.onVolume(row.dataset.id, Number(e.target.value));
  });

  root.addEventListener('click', (e) => {
    // The checkbox's own click bubbles here too; only the focus button counts.
    const btn = e.target.closest?.('.srow-focus');
    if (!btn) return;
    handlers.onFocusRow(btn.closest('.srow').dataset.id);
  });

  resumeBanner = document.getElementById('resume-banner');
  resumeCount = document.getElementById('resume-count');
  document.getElementById('resume-button')
    ?.addEventListener('click', () => handlers.onResume());

  ui = {
    master: document.getElementById('master-toggle'),
    masterLabel: document.getElementById('master-label'),
    presetName: document.getElementById('preset-name'),
    presetState: document.getElementById('preset-state'),
    presetToggle: document.getElementById('preset-toggle'),
    panel: document.getElementById('preset-panel'),
    list: document.getElementById('preset-list'),
    form: document.getElementById('preset-form'),
    input: document.getElementById('preset-input'),
  };

  ui.master.addEventListener('click', () => handlers.onMasterToggle());

  ui.presetToggle.addEventListener('click', () => {
    handlers.onClearFocus();          // presets are not a sound; hide the slider
    const open = ui.panel.hidden;
    ui.panel.hidden = !open;
    ui.presetToggle.setAttribute('aria-expanded', String(open));
    if (open) ui.input.focus();
  });

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ui.input.value.trim();
    if (!name) return;
    handlers.onSavePreset(name);
    ui.input.value = '';
    ui.input.blur();          // dismiss the phone keyboard
  });

  // Delegated, because the list is the one part of the UI that is re-rendered.
  ui.list.addEventListener('click', (e) => {
    const item = e.target.closest('.preset-item');
    if (!item) return;
    handlers.onClearFocus();
    if (e.target.closest('.preset-delete')) {
      /* Two taps to delete, with the button latching in between. A confirm()
       * dialog in a standalone PWA is jarring, and an undo would need history
       * this app has no other use for. */
      const btn = e.target.closest('.preset-delete');
      if (btn.getAttribute('aria-pressed') === 'true') {
        handlers.onDeletePreset(item.dataset.id);
      } else {
        ui.list.querySelectorAll('.preset-delete[aria-pressed="true"]')
          .forEach((b) => { b.setAttribute('aria-pressed', 'false'); b.textContent = '×'; });
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = 'Delete?';
      }
      return;
    }
    if (e.target.closest('.preset-load')) handlers.onLoadPreset(item.dataset.id);
  });
}

/* Bulk row update, for loading a preset.
 *
 * This is the one place that writes input.value after mount, which mount()'s
 * header warns against. It is safe here and only here: a preset load is an
 * explicit tap on a different control, so no slider can be mid-drag. It is
 * still not a re-render — the elements are the same ones, only their values
 * change. */
export function applyMix(mix) {
  for (const [id, row] of rows) {
    const entry = mix[id];
    if (!entry) continue;
    if (!row.check.disabled) row.check.checked = entry.enabled;
    row.vol.value = entry.volume;
    row.value.textContent = entry.volume;
    fill(row.vol);
  }
  // Loading a preset is not selecting a sound, so nothing is left showing.
  setFocus(null);
}

/* mode: 'playing' | 'ready' | 'empty' */
export function setMaster(mode) {
  if (!ui) return;
  ui.master.setAttribute('aria-pressed', String(mode === 'playing'));
  ui.master.disabled = mode === 'empty';
  ui.masterLabel.textContent = mode === 'playing' ? 'Stop' : 'Play';
}

export function setNowPlaying(name, detail) {
  if (!ui) return;
  ui.presetName.textContent = name;
  ui.presetState.textContent = detail;
}

export function renderPresets(presets, activeId) {
  if (!ui) return;
  ui.list.textContent = '';
  for (const preset of presets) {
    const li = document.createElement('li');
    li.className = 'preset-item';
    li.dataset.id = preset.id;

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'preset-load';
    load.textContent = preset.name;
    if (preset.id === activeId) load.setAttribute('aria-current', 'true');
    const count = document.createElement('span');
    count.className = 'preset-count';
    count.textContent = preset.count === 1 ? '1 sound' : `${preset.count} sounds`;
    load.appendChild(count);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-delete';
    del.setAttribute('aria-pressed', 'false');
    del.setAttribute('aria-label', `Delete ${preset.name}`);
    del.textContent = '×';

    li.append(load, del);
    ui.list.appendChild(li);
  }
}

export function setPlaying(id, on) {
  const row = rows.get(id);
  if (!row) return;
  row.el.classList.toggle('srow--playing', on);
  if (on) row.el.classList.remove('srow--pending');
}

export function setPending(id, on) {
  rows.get(id)?.el.classList.toggle('srow--pending', on);
}

export function setBusy(id, on) {
  rows.get(id)?.el.classList.toggle('srow--busy', on);
}

/* Permanent for this session: the file is not going to appear. */
export function setMissing(id, message) {
  const row = rows.get(id);
  if (!row) return;
  row.el.classList.add('srow--missing');
  row.el.classList.remove('srow--pending', 'srow--playing');
  row.check.checked = false;
  row.check.disabled = true;
  row.focus.disabled = true;
  row.el.classList.remove('srow--open');
  row.vol.disabled = true;
  setNote(id, message);
}

/* Transient: says what happened without disabling the row, so a row that failed
 * because the phone was offline can simply be tapped again later. */
export function setNote(id, message) {
  const row = rows.get(id);
  if (!row) return;
  row.note.textContent = message ?? '';
  row.note.hidden = !message;
}

export function setChecked(id, on) {
  const row = rows.get(id);
  if (row) row.check.checked = on;
}

export function showResume(count) {
  if (!resumeBanner) return;
  resumeCount.textContent = count === 1 ? '1 sound' : `${count} sounds`;
  resumeBanner.hidden = false;
}

export function hideResume() {
  if (resumeBanner) resumeBanner.hidden = true;
}

export function showFatal(message) {
  const root = document.getElementById('mixer');
  if (!root) return;
  root.textContent = '';
  const p = document.createElement('p');
  p.className = 'notice';
  p.textContent = message;
  root.appendChild(p);
}
