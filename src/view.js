/* DOM only — no audio, no storage.
 *
 * mount() runs exactly once and nothing after it re-renders a row. Every later
 * update is a targeted attribute or class write. This is CLAUDE.md's "never
 * rebuild an input the user is focused in" applied before it can bite: a
 * re-render during a slider drag drops the drag, and on some Androids fires a
 * spurious change event on the way out.
 */

const rows = new Map();      // id -> { el, check, vol, note }
let resumeBanner = null;
let resumeCount = null;

function fill(input) {
  // WebKit paints the filled part of the track from this custom property.
  input.style.setProperty('--fill', `${input.value}%`);
}

function buildRow(sound, saved) {
  const li = document.createElement('li');
  li.className = 'srow';
  li.dataset.id = sound.id;
  li.innerHTML = `
    <label class="srow-head">
      <input type="checkbox" class="srow-check">
      <svg class="srow-icon" aria-hidden="true" focusable="false"><use href="#${sound.icon}"></use></svg>
      <span class="srow-label"></span>
      <span class="srow-value"></span>
    </label>
    ${sound.caption ? '<p class="srow-caption"></p>' : ''}
    <input type="range" class="srow-vol" min="0" max="100" step="1">
    <p class="srow-note" hidden></p>`;

  // textContent, not innerHTML — labels and captions are data.
  li.querySelector('.srow-label').textContent = sound.label;
  if (sound.caption) li.querySelector('.srow-caption').textContent = sound.caption;

  const check = li.querySelector('.srow-check');
  const vol = li.querySelector('.srow-vol');
  const note = li.querySelector('.srow-note');

  check.checked = saved.enabled;
  check.setAttribute('aria-label', sound.label);
  vol.value = saved.volume;
  vol.setAttribute('aria-label', `${sound.label} volume`);
  li.querySelector('.srow-value').textContent = saved.volume;
  fill(vol);

  rows.set(sound.id, { el: li, check, vol, note });
  return li;
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

  resumeBanner = document.getElementById('resume-banner');
  resumeCount = document.getElementById('resume-count');
  document.getElementById('resume-button')
    ?.addEventListener('click', () => handlers.onResume());
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
