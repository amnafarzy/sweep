// ================= LOGIN ITEMS =================
import { $, el, escapeHtml, busy, toast } from '../ui/dom.js';
import { api } from '../ui/api.js';

export function initLoginItems() {
  $('#loginScan').onclick = busy($('#loginScan'), async () => {
    const list = $('#loginList');
    list.innerHTML = '<p class="empty"><span class="spinner"></span>Loading…</p>';
    const items = await api.scanLoginItems();
    list.innerHTML = '';
    if (!items.length) { list.appendChild(el('p', 'empty', 'No launch agents or daemons found.')); return; }
    items.forEach((it) => {
      const row = el('div', 'row');
      const info = el('div', ''); info.style.flex = '1'; info.style.minWidth = '0';
      const nameDiv = el('div', 'r-name', escapeHtml(it.name));
      const pathDiv = el('div', 'r-path', escapeHtml(it.path));
      info.appendChild(nameDiv); info.appendChild(pathDiv);
      // System-level agents/daemons are shown for the full picture but need
      // admin rights to change — no toggle, just a lock badge.
      if (it.scope === 'system') {
        const badge = el('div', 'r-tag', '🔒 admin — read-only');
        badge.title = 'System-level item in ' + (it.path.includes('LaunchDaemons') ? '/Library/LaunchDaemons' : '/Library/LaunchAgents') + ' — Sweep never modifies these.';
        row.appendChild(info); row.appendChild(badge);
        list.appendChild(row);
        return;
      }
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
}
