// ================= DASHBOARD SMART SCAN =================
import { $, fmtBytes, showView, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';
import { runCancellableScan } from '../ui/scan.js';
import { populateSystemJunk } from './systemJunk.js';
import { populateLargeFiles } from './largeFiles.js';

export function initDashboard() {
  $('#smartScanBtn').onclick = async () => {
    const btn = $('#smartScanBtn');
    const res = await runCancellableScan(btn, $('#smartProgress'), () => api.scanSmart());
    if (res === undefined) return;                       // this click was the cancel
    if (res === null) { toast('Scan cancelled'); return; }
    const { junk: caches, large, trash, downloads: dl } = res;
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
    // Fill each view with the data we just gathered, so clicking a category opens
    // an already-populated list instead of an empty "Tap Scan to begin" view.
    populateSystemJunk(caches);
    $('#largeThreshold').value = '250';     // match the threshold Smart Scan used
    populateLargeFiles(large);
    $('#trashSize').textContent = fmtBytes(trash);
    $('#dlSize').textContent = fmtBytes(dl);
    btn.textContent = 'Run Smart Scan Again';
    toast('Scan complete');
    // The dashboard is the first thing users see, so flag missing Full Disk Access here too.
    try { $('#dashAccess').hidden = !!(await api.checkAccess()).fullDiskAccess; }
    catch { /* probe failed — leave the hint hidden */ }
  };
}
