const api = window.sweep;

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

function confirmModal(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalOk').textContent = okLabel;
    $('#modalBg').hidden = false;
    const cleanup = (val) => { $('#modalBg').hidden = true; $('#modalOk').onclick = null; $('#modalCancel').onclick = null; resolve(val); };
    $('#modalOk').onclick = () => cleanup(true);
    $('#modalCancel').onclick = () => cleanup(false);
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
    const row = el('div', 'row');
    const cb = el('input'); cb.type = 'checkbox'; cb.dataset.idx = idx;
    const info = el('div', '', `<div class="r-name">${escapeHtml(it.name)}</div><div class="r-path">${escapeHtml(it.path)}</div>`);
    info.style.flex = '1'; info.style.minWidth = '0';
    const size = el('div', 'r-size', fmtBytes(it.size));
    row.appendChild(cb);
    if (tag && it.dir) row.appendChild(el('div', 'r-tag', it.dir));
    row.appendChild(info);
    row.appendChild(size);
    container.appendChild(row);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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
$('#cachesScan').onclick = async () => {
  const list = $('#cachesList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Scanning caches…</p>';
  cachesData = await api.scanCaches();
  buildSelectableList(list, cachesData);
  getCachesSel = wireSelection(list, cachesData, $('#cachesTools'), $('#cachesSel'), $('#cachesAll'), $('#cachesClean'));
};
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
$('#largeScan').onclick = async () => {
  const list = $('#largeList');
  list.innerHTML = '<p class="empty"><span class="spinner"></span>Scanning your folders…</p>';
  largeData = await api.scanLargeFiles(+$('#largeThreshold').value);
  buildSelectableList(list, largeData, { tag: true });
  getLargeSel = wireSelection(list, largeData, $('#largeTools'), $('#largeSel'), $('#largeAll'), $('#largeClean'));
};
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
$('#loginScan').onclick = async () => {
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
    let cur = it.enabled, curPath = it.path;
    tog.onclick = async () => {
      const res = await api.toggleLoginItem(curPath, !cur);
      if (res.ok) {
        cur = !cur;
        curPath = res.path;
        pathDiv.textContent = curPath;
        tog.classList.toggle('on', cur);
        toast(cur ? 'Enabled' : 'Disabled');
      } else {
        toast('Failed: ' + (res.error || 'unknown error'));
      }
    };
    row.appendChild(info); row.appendChild(tog);
    list.appendChild(row);
  });
};

// ================= UNINSTALLER =================
$('#appsScan').onclick = async () => {
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
};
async function uninstall(app) {
  toast('Finding related files…');
  const leftovers = await api.scanAppLeftovers(app.name, app.path);
  const all = [{ path: app.path, size: 0 }, ...leftovers];
  const total = leftovers.reduce((s, x) => s + x.size, 0);
  const shown = all.slice(0, 20).map((x) => '• ' + x.path).join('\n');
  const more = all.length > 20 ? `\n…and ${all.length - 20} more` : '';
  const ok = await confirmModal(`Uninstall ${app.name}?`,
    `This moves the app and ${leftovers.length} related file(s) (${fmtBytes(total)}) to the Trash. Everything is recoverable from the Trash.\n\n${shown}${more}`,
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
  const pct = Math.min(100, Math.round((reclaimable / (50 * 1024 * 1024 * 1024)) * 100));
  $('#heroRing').style.setProperty('--deg', (pct * 3.6) + 'deg');
  const stats = [
    ['System junk', fmtBytes(cacheTotal)],
    ['In Trash', fmtBytes(trash)],
    ['Large files', fmtBytes(largeTotal)],
    ['Downloads', fmtBytes(dl)],
  ];
  $('#dashStats').innerHTML = stats.map(([k, v]) => `<div class="dash-stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  btn.disabled = false; btn.textContent = 'Run Smart Scan Again';
  toast('Scan complete');
};

// initial loads when a view is first shown
document.querySelector('[data-view="trash"]').addEventListener('click', () => { if ($('#trashSize').textContent === '—') refreshTrash(); });
document.querySelector('[data-view="memory"]').addEventListener('click', () => { if (!$('#memBar').children.length) refreshMem(); });
