const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { setMaxListeners } = require('events');

const { run, dirSize, HOME } = require('./lib/exec');
const { assertSafeToRemove } = require('./lib/safety');
const { createIgnoreStore } = require('./lib/ignoreStore');

// Read-only scanners and the (validated) destructive toggles live in scanners/.
// main.js stays the Electron glue: it wires these to IPC channels and owns the
// app/window/menu lifecycle. Nothing here builds a shell string or trusts a path
// from the renderer — each handler re-validates through the imported guards.
const { scanSystemJunk, trashTotalSize } = require('./scanners/systemJunk');
const { scanLargeFiles } = require('./scanners/largeFiles');
const { getMemory } = require('./scanners/memory');
const { listLoginItems, toggleLoginItem } = require('./scanners/loginItems');
const { listInstalledApps, getAppsInfo, findAppLeftovers, isAppRunning, quitApp } = require('./scanners/apps');
const { hasFullDiskAccess } = require('./scanners/access');

app.setName('Sweep'); // shown in the macOS app menu / "About Sweep" / "Quit Sweep"

// ---------------------------------------------------------------------------
// SAFETY GUARD
//
// The allowlist model and its rationale live in ./lib/safety.js (pure logic, so
// it can be unit-tested without Electron): a path may only be trashed if it sits
// *strictly inside* one of the directories Sweep scans, or is a single
// /Applications/*.app bundle. assertSafeToRemove is the single chokepoint every
// destructive path passes through here.
// ---------------------------------------------------------------------------
async function moveToTrash(p) {
  const safe = assertSafeToRemove(p);
  await shell.trashItem(safe);
}

async function trashMany(paths) {
  const results = { ok: [], failed: [] };
  for (const p of paths || []) {
    try { await moveToTrash(p); results.ok.push(p); }
    catch (err) { results.failed.push({ path: p, error: err.message }); }
  }
  return results;
}

// ---------------------------------------------------------------------------
// CANCELLABLE SCANS
//
// One scan slot per window: starting a new cancellable scan aborts the previous
// one, and 'scan:cancel' aborts on user request. Progress flows back over
// webContents.send('scan:progress', {phase, done, total}); a cancelled scan
// resolves to null (never an error), which the renderer shows as "cancelled".
// ---------------------------------------------------------------------------
const activeScans = new Map(); // webContents id -> AbortController

// User-ignored paths, persisted under userData and stripped from System Junk /
// Large Files results. Created lazily so app.getPath sees the final app name.
let _ignores;
const ignores = () => (_ignores ??= createIgnoreStore(path.join(app.getPath('userData'), 'ignored.json')));

function cancellableScan(e, fn) {
  const senderId = e.sender.id; // capture: e.sender.id is unreadable once destroyed
  activeScans.get(senderId)?.abort();
  const ctrl = new AbortController();
  // One scan's signal is handed to every du/find spawn, and execFile registers an
  // abort listener per child — mapLimit's concurrency alone blows past the default
  // cap of 10 and Node warns about a leak. Nothing actually leaks (each listener
  // comes off when its child exits), so lift the cap on this signal only.
  setMaxListeners(0, ctrl.signal); // 0 = unlimited
  activeScans.set(senderId, ctrl);
  // If the window closes mid-scan, nobody is listening — abort so du/find stop
  // spawning instead of grinding on for minutes into the void.
  const onDestroyed = () => ctrl.abort();
  e.sender.once('destroyed', onDestroyed);
  const onProgress = (p) => { if (!e.sender.isDestroyed()) e.sender.send('scan:progress', p); };
  return fn(ctrl.signal, onProgress)
    .catch((err) => {
      if (err?.name === 'AbortError') return null;
      throw err;
    })
    .finally(() => {
      try { e.sender.removeListener('destroyed', onDestroyed); } catch { /* already torn down */ }
      if (activeScans.get(senderId) === ctrl) activeScans.delete(senderId);
    });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('scan:dirSize', (_e, p) => { assertSafeToRemove(p); return dirSize(p); });
ipcMain.handle('scan:systemJunk', (e) => cancellableScan(e, async (signal, onProgress) => (
  ignores().filterItems(await scanSystemJunk({ signal, onProgress }))
)));
ipcMain.handle('scan:memory', () => getMemory());
ipcMain.handle('scan:largeFiles', (e, minMB) => cancellableScan(e, async (signal, onProgress) => (
  ignores().filterItems(await scanLargeFiles(minMB, { signal, onProgress }))
)));
// The dashboard's combined Smart Scan: one cancellable pass over everything.
// Each stage reports its own done/total; the stage name is prefixed onto the
// phase so the single progress line stays self-explanatory.
ipcMain.handle('scan:smart', (e) => cancellableScan(e, async (signal, onProgress) => {
  const junk = await scanSystemJunk({
    signal, onProgress: (p) => onProgress({ ...p, phase: 'System junk — ' + p.phase }),
  });
  signal.throwIfAborted();
  const large = await scanLargeFiles(250, {
    signal, onProgress: (p) => onProgress({ ...p, phase: 'Large files — ' + p.phase }),
  });
  signal.throwIfAborted();
  onProgress({ phase: 'Trash & Downloads', done: 0, total: 1 });
  const [trash, downloads] = await Promise.all([
    trashTotalSize(signal), dirSize(path.join(HOME, 'Downloads'), signal),
  ]);
  onProgress({ phase: 'Trash & Downloads', done: 1, total: 1 });
  return {
    junk: await ignores().filterItems(junk),
    large: await ignores().filterItems(large),
    trash, downloads,
  };
}));
ipcMain.handle('scan:cancel', (e) => { activeScans.get(e.sender.id)?.abort(); });

// Ignore list: hides paths from scan results only — grants nothing, so the
// paths need no allowlist validation.
ipcMain.handle('ignore:add', (_e, p) => ignores().add(p));
ipcMain.handle('ignore:remove', (_e, p) => ignores().remove(p));
ipcMain.handle('ignore:list', () => ignores().list());
ipcMain.handle('scan:trash', () => trashTotalSize()); // ~/.Trash plus /Volumes/*/.Trashes/<uid>
ipcMain.handle('scan:downloads', () => dirSize(path.join(HOME, 'Downloads')));
ipcMain.handle('scan:loginItems', () => listLoginItems());
ipcMain.handle('scan:apps', () => listInstalledApps());
// Streams one 'apps:info' event per app as its size/last-used lands, so the
// renderer can fill the (already rendered) list in lazily. getAppsInfo
// re-validates every path against APP_BUNDLE_RE before touching it.
ipcMain.handle('scan:appsInfo', (e, paths) => getAppsInfo(paths, (info) => {
  if (!e.sender.isDestroyed()) e.sender.send('apps:info', info);
}));
ipcMain.handle('scan:appLeftovers', (_e, name, appPath) => findAppLeftovers(name, appPath));
ipcMain.handle('scan:appRunning', (_e, appPath) => isAppRunning(appPath));
ipcMain.handle('app:quit', (_e, appPath) => quitApp(appPath));
ipcMain.handle('scan:access', async () => ({ fullDiskAccess: await hasFullDiskAccess() }));

ipcMain.handle('clean:caches', (_e, paths) => trashMany(paths));
ipcMain.handle('clean:trashFiles', (_e, paths) => trashMany(paths));

ipcMain.handle('clean:emptyTrash', async () => {
  try {
    await run('osascript', ['-e', 'tell application "Finder" to empty trash']);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('clean:purgeMemory', async () => {
  try {
    await run('osascript', ['-e', 'do shell script "purge" with administrator privileges']);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('toggle:loginItem', (_e, p, enable) => toggleLoginItem(p, enable));

ipcMain.handle('open:downloads', () => { shell.openPath(path.join(HOME, 'Downloads')); });

// ---------------------------------------------------------------------------
// WINDOW
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1040, height: 680, minWidth: 860, minHeight: 560,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0d1117',
    show: false, // reveal only once the first paint is ready, to avoid a flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Standard macOS menu so the app name, Quit/Hide, copy-paste, and window
// shortcuts (Cmd+Q, Cmd+W, Cmd+M, Cmd+C/V) all work. Built from roles only —
// no custom destructive actions live here.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
