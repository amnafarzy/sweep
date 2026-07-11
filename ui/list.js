// ---------------------------------------------------------------------------
// SELECTABLE-LIST HELPERS
//
// Shared list machinery: a generic checkbox list (used by Large Files), its
// selection accounting, and the Full Disk Access banner (used by both System
// Junk and Large Files). System Junk renders its own grouped variant in its own
// module, but reuses the access banner from here.
// ---------------------------------------------------------------------------
import { el, escapeHtml, fmtBytes } from './dom.js';
import { api } from './api.js';

// Options: `tag` shows the category/dir chip; `meta(it)` adds a dim fixed
// column (e.g. kind + last-opened date); `onIgnore(it)` adds a per-row Ignore
// button for the persistent ignore list.
export function buildSelectableList(container, items, { tag, meta, onIgnore } = {}) {
  container.innerHTML = '';
  if (!items.length) { container.appendChild(el('p', 'empty', 'Nothing found — you\'re clean here.')); return; }
  items.forEach((it, idx) => {
    const row = el('div', 'row selectable');
    const cb = el('input'); cb.type = 'checkbox'; cb.dataset.idx = idx;
    const info = el('div', '', `<div class="r-name">${escapeHtml(it.name)}</div><div class="r-path">${escapeHtml(it.path)}</div>`);
    info.style.flex = '1'; info.style.minWidth = '0';
    const size = el('div', 'r-size', fmtBytes(it.size));
    row.appendChild(cb);
    const tagText = it.category || it.dir;
    if (tag && tagText) row.appendChild(el('div', 'r-tag', escapeHtml(tagText)));
    row.appendChild(info);
    if (meta) row.appendChild(el('div', 'r-meta', escapeHtml(meta(it))));
    row.appendChild(size);
    if (onIgnore) {
      const ig = el('button', 'btn btn-ghost', 'Ignore');
      ig.title = 'Hide this path from future scans (review in Settings)';
      ig.onclick = (e) => { e.stopPropagation(); onIgnore(it); };
      row.appendChild(ig);
    }
    // Clicking anywhere on the row toggles its checkbox (the checkbox itself
    // still works natively, and buttons keep their own clicks).
    row.onclick = (e) => {
      if (e.target === cb || e.target.closest('button')) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    };
    container.appendChild(row);
  });
}

// When Full Disk Access is off, scans silently miss files — warn rather than let
// an incomplete result look like "nothing found". Fire-and-forget; prepends a
// banner to the list once the probe resolves.
export async function maybeWarnAccess(listEl) {
  try {
    const { fullDiskAccess } = await api.checkAccess();
    if (fullDiskAccess) return;
    const note = el('div', 'notice',
      '⚠️ Full Disk Access appears to be off, so some files may be hidden from this scan. ' +
      'Grant it in System Settings → Privacy &amp; Security → Full Disk Access, then scan again.');
    listEl.prepend(note);
  } catch { /* probe failed — don't block the scan */ }
}

export function wireSelection(listEl, items, toolsEl, selEl, allEl, cleanBtn) {
  function update() {
    const checks = [...listEl.querySelectorAll('input[type=checkbox]')];
    const sel = checks.filter((c) => c.checked);
    const total = sel.reduce((s, c) => s + (items[+c.dataset.idx]?.size || 0), 0);
    selEl.textContent = fmtBytes(total) + ' selected';
    cleanBtn.disabled = sel.length === 0;
    allEl.checked = sel.length === checks.length && checks.length > 0;
  }
  listEl.querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = update));
  allEl.onchange = () => { listEl.querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = allEl.checked)); update(); };
  toolsEl.hidden = items.length === 0;
  update();
  return () => [...listEl.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => items[+c.dataset.idx]);
}
