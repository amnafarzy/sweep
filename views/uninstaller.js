// ================= UNINSTALLER =================
import { $, el, escapeHtml, fmtBytes, busy, confirmModal, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

async function uninstall(app) {
  try {
    toast('Finding related files…');
    const [leftovers, appSize] = await Promise.all([
      api.scanAppLeftovers(app.name, app.path),
      api.dirSize(app.path),
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

export function initUninstaller() {
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
      btn.onclick = busy(btn, () => uninstall(app));
      row.appendChild(info); row.appendChild(btn);
      list.appendChild(row);
    });
  });
}
