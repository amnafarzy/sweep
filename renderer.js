// ---------------------------------------------------------------------------
// RENDERER ENTRY
//
// Loaded as an ES module (<script type="module">). It checks the preload bridge,
// wires the sidebar navigation, then hands each view its own module to initialize.
// All the per-view behavior lives in views/*; the shared DOM/UI helpers live in
// ui/dom.js (with ui/list.js and ui/api.js for list machinery and the bridge).
// ---------------------------------------------------------------------------
import { api } from './ui/api.js';
import { $ } from './ui/dom.js';
import { initDashboard } from './views/dashboard.js';
import { initSystemJunk } from './views/systemJunk.js';
import { initLargeFiles } from './views/largeFiles.js';
import { initTrash } from './views/trash.js';
import { initMemory } from './views/memory.js';
import { initLoginItems } from './views/loginItems.js';
import { initUninstaller } from './views/uninstaller.js';

// If the preload bridge failed to load, the app can do nothing useful — surface
// a clear message instead of throwing an opaque error on every interaction.
if (!api) {
  document.body.innerHTML =
    '<div style="padding:48px;font-family:-apple-system,sans-serif;color:#f5b94d">' +
    'Sweep failed to initialize: the preload bridge did not load. Try restarting the app.' +
    '</div>';
  throw new Error('preload bridge (window.sweep) unavailable');
}

// ---- nav ----
document.querySelectorAll('.nav-item').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#view-' + b.dataset.view).classList.add('active');
  };
});

// ---- wire each view ----
initDashboard();
initSystemJunk();
initLargeFiles();
initTrash();
initMemory();
initLoginItems();
initUninstaller();
