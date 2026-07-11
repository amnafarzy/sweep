const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');

const { run, dirSize, HOME } = require('./lib/exec');
const { assertSafeToRemove } = require('./lib/safety');

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
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('scan:dirSize', (_e, p) => { assertSafeToRemove(p); return dirSize(p); });
ipcMain.handle('scan:systemJunk', () => scanSystemJunk());
ipcMain.handle('scan:memory', () => getMemory());
ipcMain.handle('scan:largeFiles', (_e, minMB) => scanLargeFiles(minMB));
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
