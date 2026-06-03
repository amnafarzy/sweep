const api = window.sweep;

// If the preload bridge failed to load, the app can do nothing useful — surface
// a clear message instead of throwing an opaque error on every interaction.
if (!api) {
  document.body.innerHTML =
    '<div style="padding:48px;font-family:-apple-system,sans-serif;color:#f5b94d">' +
    'Sweep failed to initialize: the preload bridge did not load. Try restarting the app.' +
    '</div>';
  throw new Error('preload bridge (window.sweep) unavailable');
}

// ---- helpers ----
function fmtBytes(n) {
  if (!n || n < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function $(s) { return document.querySelector(s); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Wrap an async click handler so its button is disabled while it runs — prevents
// double-clicks kicking off overlapping scans.
function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(...args); }
    finally { btn.disabled = false; }
  };
}

// Programmatic navigation that reuses the nav buttons (so their lazy-load
// listeners fire too).
function showView(view) {
  const nav = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nav) nav.click();
}

function confirmModal(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const bg = $('#modalBg');
    const prevFocus = document.activeElement; // restore focus here when we close
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalOk').textContent = okLabel;
    bg.hidden = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    };
    const cleanup = (val) => {
      bg.hidden = true;
      $('#modalOk').onclick = null; $('#modalCancel').onclick = null; bg.onmousedown = null;
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    $('#modalOk').onclick = () => cleanup(true);
    $('#modalCancel').onclick = () => cleanup(false);
    // Click on the dim backdrop (but not the dialog itself) cancels.
    bg.onmousedown = (e) => { if (e.target === bg) cleanup(false); };
    document.addEventListener('keydown', onKey);
    // Focus the safe default so an inadvertent Enter/Space doesn't confirm.
    $('#modalCancel').focus();
  });
}

// ---- nav ----
document.querySelectorAll('.nav-item').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#view-' + b.dataset.view).classList.add('active');
  };
});

// ---- generic selectable list ----
function buildSelectableList(container, items, { tag } = {}) {
  container.innerHTML = '';
  if (!items.length) { container.appendChild(el('p', 'empty', 'Nothing found — you\'re clean here.')); return; }
  items.forEach((it, idx) => {
    const row = el('div', 'row selectable');
    const cb = el('input'); cb.type = 'checkbox'; cb.dataset.idx = idx;
    const info = el('div', '', `<div class="r-name">${escapeHtml(it.name)}</div><div class="r-path">${escapeHtml(it.path)}</div>`);
    info.style.flex = '1'; info.style.minWidth = '0';
    const size = el('div', 'r-size', fmtBytes(it.size));
    row.appendChild(cb);
    if (tag && it.dir) row.appendChild(el('div', 'r-tag', it.dir));
    row.appendChild(info);
    row.appendChild(size);
    // Clicking anywhere on the row toggles its checkbox (the checkbox itself
    // still works natively — guard against double-toggling).
    row.onclick = (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    };
    container.appendChild(row);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// When Full Disk Access is off, scans silently miss files — warn rather than let
// an incomplete result look like "nothing found". Fire-and-forget; prepends a
// banner to the list once the probe resolves.
async function maybeWarnAccess(listEl) {
  try {
    const { fullDiskAccess } = await api.checkAccess();
    if (fullDiskAccess) return;
    const note = el('div', 'notice',
      '⚠️ Full Disk Access appears to be off, so some files may be hidden from this scan. ' +
      'Grant it in System Settings → Privacy &amp; Security → Full Disk Access, then scan again.');
    listEl.prepend(note);
  } catch { /* probe failed — don't block the scan */ }
}

function wireSelection(listEl, items, toolsEl, selEl, allEl, cleanBtn) {
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

// ================= CACHES =================
let cachesData = [], getCachesSel;
$('#cachesScan').onclick = busy($('#cachesScan'), async () => {
  const list = $('#cachesList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Scanning caches…</p>';
  cachesData = await api.scanCaches();
  buildSelectableList(list, cachesData);
  getCachesSel = wireSelection(list, cachesData, $('#cachesTools'), $('#cachesSel'), $('#cachesAll'), $('#cachesClean'));
  maybeWarnAccess(list);
});
$('#cachesClean').onclick = async () => {
  const sel = getCachesSel();
  const total = sel.reduce((s, x) => s + x.size, 0);
  const ok = await confirmModal('Clear caches?', `Move ${sel.length} cache folder(s) (${fmtBytes(total)}) to the Trash? Apps will rebuild these automatically. Nothing is permanently deleted.`, 'Move to Trash');
  if (!ok) return;
  const res = await api.cleanCaches(sel.map((x) => x.path));
  toast(`Cleared ${res.ok.length} item(s)${res.failed.length ? `, ${res.failed.length} failed` : ''}`);
  $('#cachesScan').click();
};

// ================= LARGE FILES =================
let largeData = [], getLargeSel;
$('#largeScan').onclick = busy($('#largeScan'), async () => {
  const list = $('#largeList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Scanning your folders…</p>';
  largeData = await api.scanLargeFiles(+$('#largeThreshold').value);
  buildSelectableList(list, largeData, { tag: true });
  getLargeSel = wireSelection(list, largeData, $('#largeTools'), $('#largeSel'), $('#largeAll'), $('#largeClean'));
  maybeWarnAccess(list);
});
$('#largeClean').onclick = async () => {
  const sel = getLargeSel();
  const total = sel.reduce((s, x) => s + x.size, 0);
  const ok = await confirmModal('Move files to Trash?', `Move ${sel.length} file(s) (${fmtBytes(total)}) to the Trash? You can restore them from the Trash if needed.`, 'Move to Trash');
  if (!ok) return;
  const res = await api.trashFiles(sel.map((x) => x.path));
  toast(`Moved ${res.ok.length} file(s) to Trash${res.failed.length ? `, ${res.failed.length} failed` : ''}`);
  $('#largeScan').click();
};

// ================= TRASH & DOWNLOADS =================
async function refreshTrash() {
  $('#trashSize').textContent = '…'; $('#dlSize').textContent = '…';
  const [t, d] = await Promise.all([api.scanTrash(), api.scanDownloads()]);
  $('#trashSize').textContent = fmtBytes(t);
  $('#dlSize').textContent = fmtBytes(d);
}
$('#trashRefresh').onclick = refreshTrash;
$('#emptyTrashBtn').onclick = async () => {
  const ok = await confirmModal('Empty the Trash?', 'This permanently deletes everything in your Trash. This cannot be undone.', 'Empty Trash');
  if (!ok) return;
  const res = await api.emptyTrash();
  toast(res.ok ? 'Trash emptied' : 'Failed: ' + res.error);
  refreshTrash();
};
$('#openDlBtn').onclick = () => api.openDownloads();

// ================= MEMORY =================
const MEM_COLORS = { app: '#3dd7a8', wired: '#f5b94d', compressed: '#7c8cff', cached: '#3a4a5e', free: '#212d3d' };
async function refreshMem() {
  const m = await api.scanMemory();
  const total = m.total || 1;
  const segs = [
    { k: 'App memory', v: m.active || 0, c: MEM_COLORS.app },
    { k: 'Wired', v: m.wired || 0, c: MEM_COLORS.wired },
    { k: 'Compressed', v: m.compressed || 0, c: MEM_COLORS.compressed },
    { k: 'Cached files', v: m.cached || 0, c: MEM_COLORS.cached },
    { k: 'Free', v: m.free || 0, c: MEM_COLORS.free },
  ];
  const bar = $('#memBar'); bar.innerHTML = '';
  const leg = $('#memLegend'); leg.innerHTML = '';
  segs.forEach((s) => {
    const seg = el('div', 'mem-seg'); seg.style.width = (100 * s.v / total) + '%'; seg.style.background = s.c; bar.appendChild(seg);
    const li = el('div', 'li'); li.innerHTML = `<span class="dot" style="background:${s.c}"></span>${s.k} — ${fmtBytes(s.v)}`; leg.appendChild(li);
  });
}
$('#memRefresh').onclick = refreshMem;
$('#purgeBtn').onclick = async () => {
  toast('Requesting admin rights…');
  const res = await api.purgeMemory();
  toast(res.ok ? 'Inactive memory purged' : 'Cancelled or failed');
  if (res.ok) setTimeout(refreshMem, 800);
};

// ================= LOGIN ITEMS =================
$('#loginScan').onclick = busy($('#loginScan'), async () => {
  const list = $('#loginList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Loading…</p>';
  const items = await api.scanLoginItems();
  list.innerHTML = '';
  if (!items.length) { list.appendChild(el('p', 'empty', 'No user launch agents found.')); return; }
  items.forEach((it) => {
    const row = el('div', 'row');
    const info = el('div', ''); info.style.flex = '1'; info.style.minWidth = '0';
    const nameDiv = el('div', 'r-name', escapeHtml(it.name));
    const pathDiv = el('div', 'r-path', escapeHtml(it.path));
    info.appendChild(nameDiv); info.appendChild(pathDiv);
    const tog = el('button', 'toggle' + (it.enabled ? ' on' : ''));
    tog.setAttribute('aria-label', 'Toggle login item ' + it.name);
    tog.setAttribute('aria-pressed', String(it.enabled));
    tog.title = it.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
    let cur = it.enabled, curPath = it.path;
    tog.onclick = async () => {
      tog.disabled = true;
      const res = await api.toggleLoginItem(curPath, !cur);
      tog.disabled = false;
      if (res.ok) {
        cur = !cur;
        curPath = res.path;
        pathDiv.textContent = curPath;
        tog.classList.toggle('on', cur);
        tog.setAttribute('aria-pressed', String(cur));
        tog.title = cur ? 'Enabled — click to disable' : 'Disabled — click to enable';
        toast(cur ? 'Login item enabled' : 'Login item disabled');
      } else {
        toast('Failed: ' + (res.error || 'unknown error'));
      }
    };
    row.appendChild(info); row.appendChild(tog);
    list.appendChild(row);
  });
});

// ================= UNINSTALLER =================
$('#appsScan').onclick = busy($('#appsScan'), async () => {
  const list = $('#appsList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Loading apps…</p>';
  const apps = await api.scanApps();
  list.innerHTML = '';
  if (!apps.length) { list.appendChild(el('p', 'empty', 'No apps found in /Applications.')); return; }
  apps.forEach((app) => {
    const row = el('div', 'row');
    const info = el('div', ''); info.style.flex = '1'; info.style.minWidth = '0';
    info.innerHTML = `<div class="r-name">${escapeHtml(app.name)}</div>`;
    const btn = el('button', 'btn btn-danger', 'Uninstall'); btn.style.padding = '6px 14px'; btn.style.fontSize = '12px';
    btn.onclick = () => uninstall(app);
    row.appendChild(info); row.appendChild(btn);
    list.appendChild(row);
  });
});
async function uninstall(app) {
  toast('Finding related files…');
  const leftovers = await api.scanAppLeftovers(app.name, app.path);
  const all = [{ path: app.path, size: 0 }, ...leftovers];
  const total = leftovers.reduce((s, x) => s + x.size, 0);
  // List EVERY path that will be trashed — never hide items the user is approving.
  // The modal body scrolls, so a long list stays reviewable.
  const list = all.map((x) => '• ' + x.path).join('\n');
  const ok = await confirmModal(`Uninstall ${app.name}?`,
    `This moves the app and ${leftovers.length} related file(s) (${fmtBytes(total)}) to the Trash — all ${all.length} item(s) are listed below. Everything is recoverable from the Trash.\n\n${list}`,
    'Move all to Trash');
  if (!ok) return;
  const res = await api.trashFiles(all.map((x) => x.path));
  toast(`Removed ${res.ok.length} item(s)${res.failed.length ? `, ${res.failed.length} failed (may need admin)` : ''}`);
  $('#appsScan').click();
}

// ================= DASHBOARD SMART SCAN =================
$('#smartScanBtn').onclick = async () => {
  const btn = $('#smartScanBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Scanning…';
  const [caches, large, trash, dl] = await Promise.all([
    api.scanCaches(), api.scanLargeFiles(250), api.scanTrash(), api.scanDownloads(),
  ]);
  const cacheTotal = caches.reduce((s, x) => s + x.size, 0);
  const largeTotal = large.reduce((s, x) => s + x.size, 0);
  const reclaimable = cacheTotal + trash;
  $('#heroNum').textContent = fmtBytes(reclaimable);
  // The ring is purely cosmetic: it fills proportionally up to a 50 GB reference
  // point (not a real cap on what can be cleaned), then saturates at 100%.
  const pct = Math.min(100, Math.round((reclaimable / (50 * 1024 * 1024 * 1024)) * 100));
  $('#heroRing').style.setProperty('--deg', (pct * 3.6) + 'deg');
  const stats = [
    ['System junk', fmtBytes(cacheTotal), 'caches'],
    ['In Trash', fmtBytes(trash), 'trash'],
    ['Large files', fmtBytes(largeTotal), 'large'],
    ['Downloads', fmtBytes(dl), 'trash'],
  ];
  $('#dashStats').innerHTML = stats
    .map(([k, v, view]) => `<button class="dash-stat" data-view="${view}"><div class="v">${v}</div><div class="k">${k} ›</div></button>`)
    .join('');
  $('#dashStats').querySelectorAll('.dash-stat').forEach((s) => { s.onclick = () => showView(s.dataset.view); });
  btn.disabled = false; btn.textContent = 'Run Smart Scan Again';
  toast('Scan complete');
  // The dashboard is the first thing users see, so flag missing Full Disk Access here too.
  try { $('#dashAccess').hidden = !!(await api.checkAccess()).fullDiskAccess; }
  catch { /* probe failed — leave the hint hidden */ }
};

// initial loads when a view is first shown
document.querySelector('[data-view="trash"]').addEventListener('click', () => { if ($('#trashSize').textContent === '—') refreshTrash(); });
document.querySelector('[data-view="memory"]').addEventListener('click', () => { if (!$('#memBar').children.length) refreshMem(); });
