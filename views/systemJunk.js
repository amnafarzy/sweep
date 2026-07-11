// ================= SYSTEM JUNK (grouped by category) =================
import { $, el, fmtBytes, escapeHtml, confirmModal, toast } from '../ui/dom.js';
import { maybeWarnAccess } from '../ui/list.js';
import { runCancellableScan } from '../ui/scan.js';
import { api } from '../ui/api.js';

let cachesData = [], getCachesSel = () => [];
const collapsedCats = new Set(); // categories the user has collapsed — remembered across rescans

// Render a System Junk result set into the view and wire its controls. Shared by
// the view's own Scan button and the dashboard Smart Scan, so results gathered on
// the dashboard show up immediately when you open this view — no second scan.
export function populateSystemJunk(items) {
  const list = $('#cachesList');
  cachesData = items;
  renderSystemJunk(cachesData);
  $('#cachesAll').onchange = () => {
    list.querySelectorAll('.item-chk').forEach((c) => { c.checked = $('#cachesAll').checked; });
    updateJunkSel();
  };
  maybeWarnAccess(list);
}

function renderSystemJunk(items) {
  const list = $('#cachesList');
  list.innerHTML = '';
  if (!items.length) { list.appendChild(el('p', 'empty', 'Nothing found — you\'re clean here.')); $('#cachesTools').hidden = true; return; }

  // Group by category, then order categories by how much they'd reclaim.
  const byCat = new Map();
  items.forEach((it, idx) => {
    const c = it.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({ it, idx });
  });
  const cats = [...byCat.entries()]
    .map(([cat, arr]) => ({ cat, arr, total: arr.reduce((s, x) => s + x.it.size, 0) }))
    .sort((a, b) => b.total - a.total);

  cats.forEach(({ cat, arr, total }) => {
    const sec = el('div', 'jcat');
    if (collapsedCats.has(cat)) sec.classList.add('collapsed');

    const head = el('div', 'jcat-head');
    const cb = el('input'); cb.type = 'checkbox'; cb.className = 'cat-chk';
    cb.setAttribute('aria-label', 'Select all in ' + cat);
    const caret = el('span', 'caret', '▾');
    const title = el('div', 'jcat-title', `${escapeHtml(cat)}<span class="jcat-count">${arr.length}</span>`);
    title.style.flex = '1';
    const sub = el('div', 'jcat-sub', fmtBytes(total));
    head.append(cb, caret, title, sub);
    // Click the header (but not its checkbox) to collapse/expand; remember the choice.
    head.onclick = (e) => {
      if (e.target === cb) return;
      sec.classList.toggle('collapsed');
      if (sec.classList.contains('collapsed')) collapsedCats.add(cat); else collapsedCats.delete(cat);
    };

    const body = el('div', 'jcat-items');
    arr.forEach(({ it, idx }) => {
      const row = el('div', 'row selectable');
      const icb = el('input'); icb.type = 'checkbox'; icb.className = 'item-chk'; icb.dataset.idx = idx;
      // `warn` marks items that are NOT regenerable (e.g. iOS device backups) —
      // show the caution inline so it's visible before anything is selected.
      const warnBadge = it.warn ? `<span class="r-badge">⚠ ${escapeHtml(it.warn)}</span>` : '';
      const info = el('div', '', `<div class="r-name">${escapeHtml(it.name)}${warnBadge}</div><div class="r-path">${escapeHtml(it.path)}</div>`);
      info.style.flex = '1'; info.style.minWidth = '0';
      const size = el('div', 'r-size', fmtBytes(it.size));
      const ig = el('button', 'btn btn-ghost', 'Ignore');
      ig.title = 'Hide this path from future scans (review in Settings)';
      ig.onclick = async (e) => {
        e.stopPropagation();
        await api.addIgnore(it.path);
        cachesData = cachesData.filter((x) => x !== it);
        renderSystemJunk(cachesData);
        toast('Ignored — review under Settings');
      };
      row.append(icb, info, size, ig);
      row.onclick = (e) => { if (e.target === icb || e.target.closest('button')) return; icb.checked = !icb.checked; icb.dispatchEvent(new Event('change')); };
      body.appendChild(row);
    });

    cb.onchange = () => { body.querySelectorAll('.item-chk').forEach((c) => { c.checked = cb.checked; }); updateJunkSel(); };
    sec.append(head, body);
    list.appendChild(sec);
  });

  list.querySelectorAll('.item-chk').forEach((c) => (c.onchange = updateJunkSel));
  $('#cachesTools').hidden = false;
  getCachesSel = () => [...list.querySelectorAll('.item-chk')].filter((c) => c.checked).map((c) => items[+c.dataset.idx]);
  updateJunkSel();
}

// Recompute selected total, the clean button, the global "select all", and each
// category checkbox's checked/indeterminate state from the live checkboxes.
function updateJunkSel() {
  const list = $('#cachesList');
  const checks = [...list.querySelectorAll('.item-chk')];
  const sel = checks.filter((c) => c.checked);
  const total = sel.reduce((s, c) => s + (cachesData[+c.dataset.idx]?.size || 0), 0);
  $('#cachesSel').textContent = fmtBytes(total) + ' selected';
  $('#cachesClean').disabled = sel.length === 0;
  $('#cachesAll').checked = checks.length > 0 && sel.length === checks.length;
  list.querySelectorAll('.jcat').forEach((sec) => {
    const cc = sec.querySelector('.cat-chk');
    const its = [...sec.querySelectorAll('.item-chk')];
    const on = its.filter((c) => c.checked).length;
    cc.checked = its.length > 0 && on === its.length;
    cc.indeterminate = on > 0 && on < its.length;
  });
}

export function initSystemJunk() {
  $('#cachesScan').onclick = async () => {
    const res = await runCancellableScan($('#cachesScan'), $('#cachesProgress'), () => {
      $('#cachesList').innerHTML = '<p class="empty"><span class="spinner"></span>Scanning system junk…</p>';
      $('#cachesTools').hidden = true;
      return api.scanSystemJunk();
    });
    if (res === undefined) return;                       // this click was the cancel
    if (res === null) {
      $('#cachesList').innerHTML = '<p class="empty">Scan cancelled.</p>';
      toast('Scan cancelled');
      return;
    }
    populateSystemJunk(res);
  };
  $('#cachesClean').onclick = async () => {
    const btn = $('#cachesClean');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      const sel = getCachesSel();
      const total = sel.reduce((s, x) => s + x.size, 0);
      const ok = await confirmModal('Clear system junk?', `Move ${sel.length} item(s) (${fmtBytes(total)}) to the Trash? Apps rebuild or re-download these as needed. Nothing is permanently deleted.`, 'Move to Trash');
      if (!ok) return;
      // A grouped app item carries several cache subfolders in `paths`; expand those.
      const res = await api.cleanCaches(sel.flatMap((x) => x.paths || [x.path]));
      toast(`Cleared ${fmtBytes(total)}${res.failed.length ? `, ${res.failed.length} folder(s) failed` : ''}`);
      $('#cachesScan').click();
    } finally {
      delete btn.dataset.busy;
      updateJunkSel();
    }
  };
}
