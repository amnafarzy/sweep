// ================= LARGE FILES =================
import { $, fmtBytes, fileKind, confirmModal, toast } from '../ui/dom.js';
import { buildSelectableList, wireSelection, maybeWarnAccess } from '../ui/list.js';
import { runCancellableScan } from '../ui/scan.js';
import { api } from '../ui/api.js';

let largeData = [];        // full scan result
let getLargeSel = () => []; // selection over the currently rendered (filtered/sorted) subset
let sortKey = 'size', sortDir = -1; // size, biggest first

const COMPARATORS = {
  name: (a, b) => a.name.localeCompare(b.name),
  kind: (a, b) => fileKind(a.name).localeCompare(fileKind(b.name)),
  lastOpened: (a, b) => (a.lastOpened || 0) - (b.lastOpened || 0),
  size: (a, b) => a.size - b.size,
};

function metaText(it) {
  const opened = it.lastOpened ? new Date(it.lastOpened).toLocaleDateString() : '—';
  return `${fileKind(it.name)} · opened ${opened}`;
}

function render() {
  const kind = $('#largeKind').value;
  const view = largeData
    .filter((x) => kind === 'all' || fileKind(x.name) === kind)
    .sort((a, b) => COMPARATORS[sortKey](a, b) * sortDir);
  buildSelectableList($('#largeList'), view, {
    tag: true,
    meta: metaText,
    onIgnore: async (it) => {
      await api.addIgnore(it.path);
      largeData = largeData.filter((x) => x.path !== it.path);
      render();
      toast('Ignored — review under Settings');
    },
  });
  getLargeSel = wireSelection($('#largeList'), view, $('#largeTools'), $('#largeSel'), $('#largeAll'), $('#largeClean'));
  // sort indicators on the column headers
  $('#largeSortBar').querySelectorAll('button').forEach((b) => {
    b.textContent = b.dataset.label + (b.dataset.key === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
  });
}

// Render a Large Files result set and wire its selection controls. Shared by the
// view's own Scan button and the dashboard Smart Scan.
export function populateLargeFiles(items) {
  largeData = items;
  render();
  maybeWarnAccess($('#largeList'));
}

export function initLargeFiles() {
  $('#largeKind').onchange = render;
  $('#largeSortBar').querySelectorAll('button').forEach((b) => {
    b.dataset.label = b.textContent;
    b.onclick = () => {
      if (sortKey === b.dataset.key) {
        sortDir = -sortDir;                                   // same column: flip direction
      } else {
        sortKey = b.dataset.key;
        sortDir = sortKey === 'name' || sortKey === 'kind' ? 1 : -1; // text asc, numbers desc
      }
      render();
    };
  });
  $('#largeScan').onclick = async () => {
    const res = await runCancellableScan($('#largeScan'), $('#largeProgress'), () => {
      $('#largeList').innerHTML = '<p class="empty"><span class="spinner"></span>Scanning your folders…</p>';
      $('#largeTools').hidden = true;
      return api.scanLargeFiles(+$('#largeThreshold').value);
    });
    if (res === undefined) return;                       // this click was the cancel
    if (res === null) {
      $('#largeList').innerHTML = '<p class="empty">Scan cancelled.</p>';
      toast('Scan cancelled');
      return;
    }
    populateLargeFiles(res);
  };
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
}
