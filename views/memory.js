// ================= MEMORY =================
import { $, el, fmtBytes, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

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

export function initMemory() {
  $('#memRefresh').onclick = refreshMem;
  $('#purgeBtn').onclick = async () => {
    toast('Requesting admin rights…');
    const res = await api.purgeMemory();
    toast(res.ok ? 'Inactive memory purged' : 'Cancelled or failed');
    if (res.ok) setTimeout(refreshMem, 800);
  };
  // Lazy initial load the first time the view is opened.
  document.querySelector('[data-view="memory"]').addEventListener('click', () => { if (!$('#memBar').children.length) refreshMem(); });
}
