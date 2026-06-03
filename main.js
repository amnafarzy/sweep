const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile); // runs a binary directly — NO shell, so no metacharacter injection
const HOME = os.homedir();

app.setName('Sweep'); // shown in the macOS app menu / "About Sweep" / "Quit Sweep"

// Like `run`, but tolerant: read-only commands such as `du` and `find` exit
// non-zero the moment they touch an unreadable subpath, yet still print useful
// partial output on stdout. Return that stdout instead of throwing, so a single
// permission error deep in a tree doesn't discard the entire result.
async function runReadable(cmd, args, opts) {
  try {
    const { stdout } = await run(cmd, args, opts);
    return stdout;
  } catch (err) {
    return typeof err?.stdout === 'string' ? err.stdout : '';
  }
}

// ---------------------------------------------------------------------------
// SAFETY GUARDS
//
// Allowlist model: a path may only be trashed if it sits *strictly inside* one
// of the directories Sweep actually scans, or is a single /Applications/*.app
// bundle. Everything else is refused — including the allowed roots themselves
// (so we never trash all of ~/Library/Caches, ~/Documents, etc.) and every
// protected system path.
//
// This fails CLOSED: a path we don't recognise is rejected, not allowed. It also
// closes the case-sensitivity gap of a denylist — macOS's default volume is
// case-insensitive, so a denylist keyed on exact casing ("/Library") could be
// slipped past with "/library". An allowlist of known-cased roots instead
// rejects any path whose casing doesn't match a root we scan, which is the safe
// outcome (a real path from a scan always has the correct casing).
// ---------------------------------------------------------------------------
const APP_BUNDLE_RE = /^\/Applications\/[^/]+\.app$/;

const ALLOWED_ROOTS = [
  path.join(HOME, 'Library', 'Caches'),
  path.join(HOME, 'Library', 'Application Support'),
  path.join(HOME, 'Library', 'Preferences'),
  path.join(HOME, 'Library', 'Logs'),
  path.join(HOME, 'Library', 'Containers'),
  path.join(HOME, 'Library', 'Saved Application State'),
  path.join(HOME, 'Library', 'HTTPStorages'),
  path.join(HOME, 'Library', 'LaunchAgents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Movies'),
  path.join(HOME, 'Music'),
  path.join(HOME, 'Pictures'),
];

// Strictly inside = a descendant of `parent`, never `parent` itself.
function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertSafeToRemove(p) {
  if (!p || typeof p !== 'string') throw new Error('Invalid path');
  const resolved = path.resolve(p);
  if (APP_BUNDLE_RE.test(resolved)) return resolved;            // a single app bundle
  if (ALLOWED_ROOTS.some((root) => isStrictlyInside(root, resolved))) return resolved;
  throw new Error(`Refusing to operate on a path outside Sweep's allowed areas: ${resolved}`);
}

async function moveToTrash(p) {
  const safe = assertSafeToRemove(p);
  await shell.trashItem(safe);
}

// small concurrency-limited map so we don't spawn hundreds of `du` at once
async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length || 1) }, async () => {
    while (i < arr.length) { const idx = i++; ret[idx] = await fn(arr[idx], idx); }
  });
  await Promise.all(workers);
  return ret;
}

// ---------------------------------------------------------------------------
// SIZE HELPERS  (all paths here are absolute, so they never look like a flag)
// ---------------------------------------------------------------------------
async function dirSize(p) {
  // `du -sk` prints "<kb>\t<path>"; even on a partial (permission-limited) walk
  // it still reports a running total, which runReadable preserves.
  const stdout = await runReadable('du', ['-sk', p]);
  const kb = parseInt(stdout.split('\t')[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// ---------------------------------------------------------------------------
// SCANNERS (read-only)
// ---------------------------------------------------------------------------
async function scanCaches() {
  const base = path.join(HOME, 'Library', 'Caches');
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory() || e.isFile());
  const sized = await mapLimit(dirs, 8, async (e) => {
    const full = path.join(base, e.name);
    return { name: e.name, path: full, size: await dirSize(full) };
  });
  return sized.filter((x) => x.size > 0).sort((a, b) => b.size - a.size);
}

async function getMemory() {
  try {
    const { stdout } = await run('vm_stat', []);
    const pageMatch = stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 4096;
    const get = (re) => { const m = stdout.match(re); return m ? parseInt(m[1], 10) : 0; };
    const free = get(/Pages free:\s+(\d+)/) * pageSize;
    const active = get(/Pages active:\s+(\d+)/) * pageSize;
    const inactive = get(/Pages inactive:\s+(\d+)/) * pageSize;
    const wired = get(/Pages wired down:\s+(\d+)/) * pageSize;
    const compressed = get(/Pages occupied by compressor:\s+(\d+)/) * pageSize;
    const total = os.totalmem();
    // Approximation for an at-a-glance breakdown (not an exact Activity Monitor
    // match): "cached" is everything physical not otherwise accounted for, which
    // folds in `inactive` and file-backed/speculative pages. `inactive` is parsed
    // and returned for callers that want it, though the UI rolls it into "cached".
    const cached = Math.max(0, total - active - wired - compressed - free);
    return { total, free, active, inactive, wired, compressed, cached };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, free, active: total - free, inactive: 0, wired: 0, compressed: 0, cached: 0 };
  }
}

async function scanLargeFiles(minMB) {
  const n = Number.isFinite(+minMB) && +minMB > 0 ? Math.floor(+minMB) : 100;
  const roots = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Music', 'Pictures']
    .map((d) => path.join(HOME, d));
  const results = [];
  for (const root of roots) {
    // runReadable keeps any files printed before find hit an unreadable subdir.
    const stdout = await runReadable(
      'find',
      [root, '-type', 'f', '-size', `+${n}M`, '-not', '-path', '*/.*', '-print0'],
      { maxBuffer: 1024 * 1024 * 16 }
    );
    // NUL-delimited so filenames containing newlines aren't split into bogus paths.
    const files = stdout.split('\0').filter(Boolean).slice(0, 300);
    for (const f of files) {
      try {
        const st = await fsp.stat(f);
        results.push({ name: path.basename(f), path: f, size: st.size, dir: root.split('/').pop() });
      } catch { /* skip */ }
    }
  }
  return results.sort((a, b) => b.size - a.size).slice(0, 100);
}

async function getTrashSize() { return dirSize(path.join(HOME, '.Trash')); }
async function getDownloadsSize() { return dirSize(path.join(HOME, 'Downloads')); }

// Probe whether the app has Full Disk Access. Without it, macOS silently blocks
// reads of certain locations, so cache/large-file scans would be incomplete and
// look like "nothing found" rather than "couldn't read". These directories are
// readable only with Full Disk Access; a permission error on them means it's off.
async function hasFullDiskAccess() {
  const probes = [
    path.join(HOME, 'Library', 'Safari'),
    path.join(HOME, 'Library', 'Application Support', 'com.apple.TCC'),
    path.join(HOME, 'Library', 'Cookies'),
  ];
  for (const probe of probes) {
    try {
      await fsp.readdir(probe);
      return true;                       // could read a protected dir → access granted
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') return false;
      // ENOENT / other → inconclusive, try the next probe
    }
  }
  return true;                           // nothing was conclusively denied — assume OK
}

async function listLoginItems() {
  const dir = path.join(HOME, 'Library', 'LaunchAgents');
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return out; }
  for (const f of entries) {
    const isPlist = f.endsWith('.plist');
    const isDisabled = f.endsWith('.plist.disabled');
    if (!isPlist && !isDisabled) continue;
    out.push({
      name: f.replace(/\.plist(\.disabled)?$/, ''),
      path: path.join(dir, f),
      enabled: isPlist,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstalledApps() {
  const dir = '/Applications';
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith('.app')) continue;
    out.push({ name: f.replace(/\.app$/, ''), path: path.join(dir, f) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getBundleId(appPath) {
  try {
    const { stdout } = await run('/usr/libexec/PlistBuddy', [
      '-c', 'Print CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist'),
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}

// Names too short or too generic to be a reliable signal on their own — matching
// these by name alone would sweep up unrelated vendors' files (e.g. an app called
// "Google" matching the shared ~/Library/Application Support/Google).
const GENERIC_NAMES = new Set([
  'app', 'apps', 'player', 'update', 'updater', 'helper', 'agent', 'service',
  'music', 'tv', 'notes', 'mail', 'calendar', 'photos', 'home', 'store', 'books',
  'news', 'stocks', 'clock', 'files', 'preview', 'pro', 'lite', 'free', 'beta',
  'google', 'microsoft', 'adobe', 'apple', 'data', 'cache', 'common', 'shared',
]);

// Precise leftover finder: bundle identifier is the primary (high-confidence)
// signal. App-name matching is only used as a fallback and is deliberately
// conservative — never a loose "*name*" substring, and never for short or
// generic names — so it can't sweep up files belonging to other apps.
async function findAppLeftovers(appName, appPath) {
  // Defense-in-depth: appPath arrives over IPC. In normal flow it comes from the
  // /Applications listing, but constrain it before feeding it to PlistBuddy.
  if (!APP_BUNDLE_RE.test(path.resolve(String(appPath || '')))) return [];

  const bundleId = (await getBundleId(appPath)).toLowerCase();
  const nameLc = String(appName).toLowerCase();
  // A bare app name is only trustworthy if it's specific enough.
  const nameUsable = nameLc.length >= 4 && !GENERIC_NAMES.has(nameLc);
  const searchDirs = [
    path.join(HOME, 'Library', 'Application Support'),
    path.join(HOME, 'Library', 'Caches'),
    path.join(HOME, 'Library', 'Preferences'),
    path.join(HOME, 'Library', 'Logs'),
    path.join(HOME, 'Library', 'Containers'),
    path.join(HOME, 'Library', 'Saved Application State'),
    path.join(HOME, 'Library', 'HTTPStorages'),
  ];
  const matches = (base) => {
    const b = base.toLowerCase();
    if (bundleId && b.includes(bundleId)) return true;       // com.vendor.app(.plist/.savedState/…)
    if (!nameUsable) return false;                            // name too weak to trust alone
    if (b === nameLc) return true;                            // "Slack"
    if (b.startsWith(nameLc + '.') || b.startsWith(nameLc + ' ')) return true; // "Slack.plist", "Slack Helper"
    return false;
  };
  const found = new Map();
  for (const d of searchDirs) {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!matches(e.name)) continue;
      const full = path.join(d, e.name);
      if (!found.has(full)) found.set(full, await dirSize(full));
    }
  }
  return [...found.entries()].map(([p, size]) => ({ path: p, size })).sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('scan:caches', () => scanCaches());
ipcMain.handle('scan:memory', () => getMemory());
ipcMain.handle('scan:largeFiles', (_e, minMB) => scanLargeFiles(minMB));
ipcMain.handle('scan:trash', () => getTrashSize());
ipcMain.handle('scan:downloads', () => getDownloadsSize());
ipcMain.handle('scan:loginItems', () => listLoginItems());
ipcMain.handle('scan:apps', () => listInstalledApps());
ipcMain.handle('scan:appLeftovers', (_e, name, appPath) => findAppLeftovers(name, appPath));
ipcMain.handle('scan:access', async () => ({ fullDiskAccess: await hasFullDiskAccess() }));

async function trashMany(paths) {
  const results = { ok: [], failed: [] };
  for (const p of paths || []) {
    try { await moveToTrash(p); results.ok.push(p); }
    catch (err) { results.failed.push({ path: p, error: err.message }); }
  }
  return results;
}
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

ipcMain.handle('toggle:loginItem', async (_e, p, enable) => {
  try {
    const base = p.replace(/\.disabled$/, '');
    assertSafeToRemove(base);
    // The rename is the durable, reversible mechanism (controls load at next login).
    // We also ask launchctl to load/unload now so the change takes effect immediately;
    // that call is best-effort (runReadable swallows its errors — e.g. agent not
    // currently loaded), so it can never break the safe rename behaviour.
    if (enable && p.endsWith('.disabled')) {
      await fsp.rename(p, base);
      await runReadable('launchctl', ['load', base]);
      return { ok: true, path: base };
    }
    if (!enable && !p.endsWith('.disabled')) {
      await runReadable('launchctl', ['unload', p]); // unload before the file moves
      await fsp.rename(p, p + '.disabled');
      return { ok: true, path: p + '.disabled' };
    }
    return { ok: true, path: p };
  } catch (err) { return { ok: false, error: err.message }; }
});

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
