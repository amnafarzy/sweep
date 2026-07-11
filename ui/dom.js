// ---------------------------------------------------------------------------
// DOM / UI PRIMITIVES
//
// Generic, app-state-free helpers shared by every view: element lookup/creation,
// byte formatting, HTML escaping, the toast, the busy-button wrapper, programmatic
// navigation, and the confirmation modal. No view-specific logic lives here.
// ---------------------------------------------------------------------------

// fmtBytes is defined in lib/format.js (a UMD loaded via a classic <script> just
// before this module) so the same implementation is shared with — and unit-tested
// by — the Node test suite. It attaches to window as SweepFormat.
export const { fmtBytes, fileKind } = window.SweepFormat;

export function $(s) { return document.querySelector(s); }

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Wrap an async click handler so its button is disabled while it runs — prevents
// double-clicks kicking off overlapping scans.
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(...args); }
    finally { btn.disabled = false; }
  };
}

// Programmatic navigation that reuses the nav buttons (so their lazy-load
// listeners fire too).
export function showView(view) {
  const nav = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nav) nav.click();
}

// Render the modal body. `body` is either a plain string (prose only) or
// { text, sections: [{ heading, paths, tone }] } — prose plus one or more
// labelled path lists. Every value goes in as textContent: paths are untrusted
// filenames and must never be parsed as HTML.
function renderModalBody(host, body) {
  host.innerHTML = '';
  const { text, sections = [] } = typeof body === 'string' ? { text: body } : body;
  if (text) {
    const p = el('p', 'modal-prose');
    p.textContent = text;
    host.appendChild(p);
  }
  if (!sections.length) return false;
  const wrap = el('div', 'modal-sections');
  sections.forEach((s) => {
    const sec = el('div', 'modal-section' + (s.tone ? ' tone-' + s.tone : ''));
    const head = el('div', 'modal-section-head');
    head.textContent = s.heading;
    const ul = el('ul', 'path-list');
    (s.paths || []).forEach((path) => {
      const li = el('li');
      li.textContent = path;
      ul.appendChild(li);
    });
    sec.appendChild(head);
    sec.appendChild(ul);
    wrap.appendChild(sec);
  });
  host.appendChild(wrap);
  return true;
}

export function confirmModal(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const bg = $('#modalBg');
    const modal = bg.querySelector('.modal');
    const prevFocus = document.activeElement; // restore focus here when we close
    $('#modalTitle').textContent = title;
    // Path lists need the room; a plain yes/no prompt stays compact.
    modal.classList.toggle('modal-wide', renderModalBody($('#modalBody'), body));
    $('#modalOk').textContent = okLabel;
    bg.hidden = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    };
    const cleanup = (val) => {
      bg.hidden = true;
      $('#modalOk').onclick = null; $('#modalCancel').onclick = null; bg.onmousedown = null;
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    $('#modalOk').onclick = () => cleanup(true);
    $('#modalCancel').onclick = () => cleanup(false);
    // Click on the dim backdrop (but not the dialog itself) cancels.
    bg.onmousedown = (e) => { if (e.target === bg) cleanup(false); };
    document.addEventListener('keydown', onKey);
    // Focus the safe default so an inadvertent Enter/Space doesn't confirm.
    $('#modalCancel').focus();
  });
}
