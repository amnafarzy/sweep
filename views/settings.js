// ================= SETTINGS (ignore list review) =================
import { $, el, escapeHtml, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

async function refreshIgnores() {
  const list = $('#ignoreList');
  const paths = await api.listIgnores();
  list.innerHTML = '';
  if (!paths.length) {
    list.appendChild(el('p', 'empty',
      'Nothing ignored. Use the "Ignore" button on a System Junk or Large Files row to exclude a path from future scans.'));
    return;
  }
  paths.forEach((p) => {
    const row = el('div', 'row');
    const info = el('div', ''); info.style.flex = '1'; info.style.minWidth = '0';
    const parts = p.split('/');
    info.innerHTML = `<div class="r-name">${escapeHtml(parts[parts.length - 1] || p)}</div><div class="r-path">${escapeHtml(p)}</div>`;
    const btn = el('button', 'btn', 'Un-ignore');
    btn.onclick = async () => {
      btn.disabled = true;
      await api.removeIgnore(p);
      toast('Un-ignored — it will show up in future scans');
      refreshIgnores();
    };
    row.appendChild(info); row.appendChild(btn);
    list.appendChild(row);
  });
}

export function initSettings() {
  $('#ignoreRefresh').onclick = refreshIgnores;
  // Load fresh every time the view is opened — cheap, and always current.
  document.querySelector('[data-view="settings"]').addEventListener('click', refreshIgnores);
}
