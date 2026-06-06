// ================= TRASH & DOWNLOADS =================
import { $, fmtBytes, confirmModal, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

async function refreshTrash() {
  $('#trashSize').textContent = '…'; $('#dlSize').textContent = '…';
  const [t, d] = await Promise.all([api.scanTrash(), api.scanDownloads()]);
  $('#trashSize').textContent = fmtBytes(t);
  $('#dlSize').textContent = fmtBytes(d);
}

export function initTrash() {
  $('#trashRefresh').onclick = refreshTrash;
  $('#emptyTrashBtn').onclick = async () => {
    const btn = $('#emptyTrashBtn');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      const ok = await confirmModal('Empty the Trash?', 'This permanently deletes everything in your Trash. This cannot be undone.', 'Empty Trash');
      if (!ok) return;
      const res = await api.emptyTrash();
      toast(res.ok ? 'Trash emptied' : 'Failed: ' + res.error);
      await refreshTrash();
    } finally {
      delete btn.dataset.busy;
      btn.disabled = false;
    }
  };
  $('#openDlBtn').onclick = () => api.openDownloads();
  // Lazy initial load the first time the view is opened.
  document.querySelector('[data-view="trash"]').addEventListener('click', () => { if ($('#trashSize').textContent === '—') refreshTrash(); });
}
