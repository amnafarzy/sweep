// ================= UNINSTALLER =================
import { $, el, escapeHtml, fmtBytes, busy, confirmModal, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

// Per-app fields: size/lastUsed are `undefined` while the background info scan
// is still running and `null` when the answer is genuinely unknown (mdls has no
// last-used date for the bundle). The distinction drives the "…" vs "unknown"
// display and keeps unknowns out of the 6+ months filter.
let appsData = [];
let cells = new Map(); // path -> { sub, size, badge } elements of the rendered row
let offInfo = null;    // unsubscribe for the current apps:info listener

function isUnused(app) {
  return typeof app.lastUsed === 'number' && Date.now() - app.lastUsed > SIX_MONTHS_MS;
}

function lastUsedText(app) {
  if (app.lastUsed === undefined) return 'Last used: …';
  if (app.lastUsed === null) return 'Last used: unknown';
  return 'Last used: ' + new Date(app.lastUsed).toLocaleDateString();
}

async function uninstall(app) {
  try {
    toast('Finding related files…');
    const [leftovers, appSize] = await Promise.all([
      api.scanAppLeftovers(app.name, app.path),
      app.size != null ? app.size : api.dirSize(app.path),
    ]);
    const all = [{ path: app.path, size: appSize }, ...leftovers];
    const total = all.reduce((s, x) => s + x.size, 0);
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
  } catch (err) {
    toast('Error: ' + (err?.message || 'unknown error'));
  }
}

// Sort key for "last used": known dates oldest-first (the surface-unused order),
// then unknown, then still-loading.
function lastUsedKey(app) {
  if (typeof app.lastUsed === 'number') return app.lastUsed;
  return app.lastUsed === null ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
}

const COMPARATORS = {
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => (b.size ?? -1) - (a.size ?? -1), // biggest first; still-loading last
  lastUsed: (a, b) => lastUsedKey(a) - lastUsedKey(b),
};

function render() {
  const list = $('#appsList');
  list.innerHTML = '';
  cells = new Map();
  const apps = ($('#appsUnusedOnly').checked ? appsData.filter(isUnused) : appsData.slice())
    .sort(COMPARATORS[$('#appsSort').value] || COMPARATORS.name);
  if (!apps.length) {
    list.appendChild(el('p', 'empty', appsData.length
      ? 'No apps match — none have gone unused for 6+ months (apps still loading, or without usage data, aren\'t counted).'
      : 'No apps found in /Applications or ~/Applications.'));
    return;
  }
  apps.forEach((app) => {
    const row = el('div', 'row');
    const info = el('div', ''); info.style.flex = '1'; info.style.minWidth = '0';
    const name = el('div', 'r-name', escapeHtml(app.name));
    const badge = el('span', 'r-badge', 'Unused 6+ months');
    badge.hidden = !isUnused(app);
    name.appendChild(badge);
    const sub = el('div', 'r-path', escapeHtml(lastUsedText(app)));
    info.appendChild(name); info.appendChild(sub);
    const size = el('div', 'r-size', app.size != null ? fmtBytes(app.size) : '…');
    const btn = el('button', 'btn btn-danger', 'Uninstall'); btn.style.padding = '6px 14px'; btn.style.fontSize = '12px';
    btn.onclick = busy(btn, () => uninstall(app));
    row.appendChild(info); row.appendChild(size); row.appendChild(btn);
    list.appendChild(row);
    cells.set(app.path, { sub, size, badge });
  });
}

// One apps:info event per app arrives while the background scan runs. Update
// the row in place (no re-sort mid-load — rows jumping under the cursor is
// worse than a briefly stale order); render() runs again when the batch ends.
function applyInfo(info) {
  const app = appsData.find((a) => a.path === info.path);
  if (!app) return;
  app.size = info.size;
  app.lastUsed = info.lastUsed;
  const c = cells.get(app.path);
  if (!c) return; // row currently filtered out
  c.size.textContent = fmtBytes(app.size);
  c.sub.textContent = lastUsedText(app);
  c.badge.hidden = !isUnused(app);
}

export function initUninstaller() {
  $('#appsSort').onchange = render;
  $('#appsUnusedOnly').onchange = render;
  $('#appsScan').onclick = busy($('#appsScan'), async () => {
    const list = $('#appsList');
    list.innerHTML = '<p class="empty"><span class="spinner"></span>Loading apps…</p>';
    const apps = await api.scanApps();
    appsData = apps.map((a) => ({ ...a, size: undefined, lastUsed: undefined }));
    render();
    if (!appsData.length) return;
    offInfo?.();
    offInfo = api.onAppInfo(applyInfo);
    try {
      await api.scanAppsInfo(appsData.map((a) => a.path));
    } finally {
      offInfo?.(); offInfo = null;
    }
    render(); // final pass so an active size/last-used sort or filter sees complete data
  });
}
