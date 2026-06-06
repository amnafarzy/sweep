// ================= LARGE FILES =================
import { $, fmtBytes, busy, confirmModal, toast } from '../ui/dom.js';
import { buildSelectableList, wireSelection, maybeWarnAccess } from '../ui/list.js';
import { api } from '../ui/api.js';

let largeData = [], getLargeSel = () => [];

// Render a Large Files result set and wire its selection controls. Shared by the
// view's own Scan button and the dashboard Smart Scan.
export function populateLargeFiles(items) {
  const list = $('#largeList');
  largeData = items;
  buildSelectableList(list, largeData, { tag: true });
  getLargeSel = wireSelection(list, largeData, $('#largeTools'), $('#largeSel'), $('#largeAll'), $('#largeClean'));
  maybeWarnAccess(list);
}

export function initLargeFiles() {
  $('#largeScan').onclick = busy($('#largeScan'), async () => {
    $('#largeList').innerHTML = '<p class="empty"><span class="spinner"></span>Scanning your folders…</p>';
    populateLargeFiles(await api.scanLargeFiles(+$('#largeThreshold').value));
  });
  $('#largeClean').onclick = async () => {
    const btn = $('#largeClean');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      const sel = getLargeSel();
      const total = sel.reduce((s, x) => s + x.size, 0);
      const ok = await confirmModal('Move files to Trash?', `Move ${sel.length} file(s) (${fmtBytes(total)}) to the Trash? You can restore them from the Trash if needed.`, 'Move to Trash');
      if (!ok) return;
      const res = await api.trashFiles(sel.map((x) => x.path));
      toast(`Moved ${res.ok.length} file(s) to Trash${res.failed.length ? `, ${res.failed.length} failed` : ''}`);
      $('#largeScan').click();
    } finally {
      delete btn.dataset.busy;
      btn.disabled = getLargeSel().length === 0;
    }
  };
  };
}
