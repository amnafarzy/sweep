const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { APP_BUNDLE_RE, ALLOWED_ROOTS, isStrictlyInside, assertSafeToRemove } = require('./lib/safety');
const { parseDuKb, splitNul, parseVmStat } = require('./lib/parse');
const { leftoverMatches } = require('./lib/match');

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
// The allowlist model and its rationale live in ./lib/safety.js (pure logic, so
// it can be unit-tested without Electron): a path may only be trashed if it sits
// *strictly inside* one of the directories Sweep scans, or is a single
// /Applications/*.app bundle. `assertSafeToRemove`, `ALLOWED_ROOTS`,
// `isStrictlyInside`, and `APP_BUNDLE_RE` are imported at the top of this file.
// ---------------------------------------------------------------------------
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
  return parseDuKb(stdout);
}

// ---------------------------------------------------------------------------
// SCANNERS (read-only)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SYSTEM JUNK ENGINE
//
// macOS lumps ~everything non-document into "System Data", and the bulk of it
// lives OUTSIDE ~/Library/Caches — in sandboxed container caches, developer
// junk, and per-app media caches buried in Group Containers. Scanning only
// ~/Library/Caches (as Sweep originally did) misses the vast majority of it.
//
// Like CleanMyMac, "smart" here is not guesswork: it's a curated ruleset of
// locations that hold regenerable data — caches, logs, transient UI state, and
// well-known re-downloadable media caches. Every item we surface is something
// the owning app rebuilds or refetches on demand; we never list user documents.
// The scanner is what defines "safe"; the trash guard (ALLOWED_ROOTS) is the
// independent second line of defense.
// ---------------------------------------------------------------------------
const LIB = path.join(HOME, 'Library');

// "Children" rules: every direct child of `base` is an independent junk item.
const CHILD_JUNK = [
  { cat: 'User caches',        base: path.join(LIB, 'Caches') },
  { cat: 'App logs',           base: path.join(LIB, 'Logs') },
  { cat: 'Saved app state',    base: path.join(LIB, 'Saved Application State') },
  { cat: 'Xcode derived data', base: path.join(LIB, 'Developer', 'Xcode', 'DerivedData') },
  { cat: 'iOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'iOS DeviceSupport') },
  { cat: 'watchOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'watchOS DeviceSupport') },
  { cat: 'tvOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'tvOS DeviceSupport') },
  { cat: 'Simulator caches',   base: path.join(LIB, 'Developer', 'CoreSimulator', 'Caches') },
];

async function listChildJunk(cat, base) {
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const kids = entries.filter((e) => e.isDirectory() || e.isFile());
  const sized = await mapLimit(kids, 8, async (e) => {
    const full = path.join(base, e.name);
    return { name: e.name, path: full, size: await dirSize(full), category: cat };
  });
  return sized.filter((x) => x.size > 0);
}

// Sandboxed apps keep a private cache at Containers/<id>/Data/Library/Caches.
// macOS hides these from ~/Library/Caches, so they're a large blind spot. We
// target the per-app Caches dir only — never the sibling data the app relies on.
async function listContainerCaches() {
  const base = path.join(LIB, 'Containers');
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory());
  const sized = await mapLimit(dirs, 8, async (e) => {
    const cacheDir = path.join(base, e.name, 'Data', 'Library', 'Caches');
    try { await fsp.access(cacheDir); } catch { return null; }      // app has no cache dir
    return { name: e.name, path: cacheDir, size: await dirSize(cacheDir), category: 'Sandboxed app caches' };
  });
  return sized.filter((x) => x && x.size > 0);
}

// Per-app media caches: re-downloadable content some apps stash in their group
// container, which never shows up under ~/Library/Caches and can reach tens of
// GB. Matched by group-container id and a path pattern so we only ever touch the
// media cache, never the message database or account data sitting beside it.
// Telegram's account-*/postbox/media is the canonical example.
const APP_MEDIA_CACHES = [
  { label: 'Telegram media', match: /\.ru\.keepcoder\.Telegram$/, findPath: '*/postbox/media' },
];

async function listAppMediaCaches() {
  const base = path.join(LIB, 'Group Containers');
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rule = APP_MEDIA_CACHES.find((r) => r.match.test(e.name));
    if (!rule) continue;
    const root = path.join(base, e.name);
    // -prune so find reports the matching dir without walking into it (du sizes it).
    const stdout = await runReadable(
      'find', [root, '-type', 'd', '-path', rule.findPath, '-prune', '-print0'],
      { maxBuffer: 1024 * 1024 }
    );
    const dirs = splitNul(stdout);
    const sized = await mapLimit(dirs, 4, async (d) => (
      { name: rule.label, path: d, size: await dirSize(d), category: 'App media caches' }
    ));
    out.push(...sized.filter((x) => x.size > 0));
  }
  return out;
}

// Universal Chromium/Electron cache directory names. Every browser and Electron
// app (Claude, Slack, Discord, Edge, VS Code, Google, …) stores regenerable web
// caches in folders with these exact names — clearing any of them just forces a
// rebuild/refetch, never data loss. We deliberately exclude data-bearing siblings
// (Local Storage, IndexedDB, Cookies, Session Storage, Network) so logins and
// settings survive.
const CACHE_DIR_NAMES = [
  'Cache', 'Code Cache', 'CachedData', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'ScriptCache',
  'blob_storage', 'Crashpad',
  // VS Code & its forks (Cursor, Antigravity, Codex…): re-downloadable extension
  // installers and per-profile derived data — distinctively named, safe to clear.
  'CachedExtensionVSIXs', 'CachedProfilesData',
];

// App-specific regenerable blobs that AREN'T named like a standard cache but are
// safe to remove because the app re-downloads them on demand. Keyed by the
// Application Support folder name. This is where most of CleanMyMac's per-app
// "smarts" live — extend it as new heavy apps are identified.
const APP_SUPPORT_EXTRAS = [
  { app: 'Claude', sub: 'vm_bundles' },                  // Claude Code sandbox VM images — refetched when needed
  { app: 'Spotify', sub: 'PersistentCache' },            // streaming media cache — re-streamed on demand
  { app: 'Adobe', sub: 'Common/Media Cache Files' },     // Premiere/After Effects media cache — regenerated
  { app: 'Adobe', sub: 'Common/Media Cache' },           // peak/conformed media cache — regenerated
];

// Sweep Application Support for the universal cache folders above (at any depth
// down to browser profiles, e.g. "Edge/Default/Cache"), then roll every cache
// dir up under its owning app so the user sees one row per app — like CleanMyMac.
async function listAppSupportCaches() {
  const base = path.join(LIB, 'Application Support');
  const nameArgs = [];
  CACHE_DIR_NAMES.forEach((n, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', n); });
  // `( -name … ) -prune -print0`: print each matching cache dir without descending
  // into it (so nested caches aren't double-counted), and keep walking elsewhere.
  const stdout = await runReadable(
    'find', [base, '-maxdepth', '5', '-type', 'd', '(', ...nameArgs, ')', '-prune', '-print0'],
    { maxBuffer: 1024 * 1024 * 8 }
  );
  const dirs = splitNul(stdout);
  const groups = new Map(); // app folder name -> Set of cache dir paths
  for (const d of dirs) {
    const app = path.relative(base, d).split(path.sep)[0];
    if (!app) continue;
    if (!groups.has(app)) groups.set(app, new Set());
    groups.get(app).add(d);
  }
  for (const ex of APP_SUPPORT_EXTRAS) {
    const full = path.join(base, ex.app, ex.sub);
    try { await fsp.access(full); } catch { continue; }
    if (!groups.has(ex.app)) groups.set(ex.app, new Set());
    groups.get(ex.app).add(full);
  }
  const items = await mapLimit([...groups.entries()], 6, async ([app, set]) => {
    const paths = [...set];
    const sizes = await mapLimit(paths, 4, (p) => dirSize(p));
    const size = sizes.reduce((s, n) => s + n, 0);
    // `paths` carries every subfolder to trash; `path` is the app dir, shown to the user.
    return { name: app, path: path.join(base, app), paths, size, category: 'App caches' };
  });
  return items.filter((x) => x.size > 0);
}

// Disk images and installer packages left in Downloads/Desktop after the app
// they carried is already installed — pure leftovers, safe to trash. Surfaced
// for review (unchecked by default) since they're loose user files.
async function listInstallers() {
  const roots = [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop')];
  const out = [];
  for (const root of roots) {
    const stdout = await runReadable(
      'find', [root, '-maxdepth', '2', '-type', 'f', '(', '-iname', '*.dmg', '-o', '-iname', '*.pkg', ')', '-print0'],
      { maxBuffer: 1024 * 1024 }
    );
    for (const f of splitNul(stdout)) {
      try {
        const st = await fsp.stat(f);
        out.push({ name: path.basename(f), path: f, size: st.size, category: 'Installers & disk images' });
      } catch { /* skip */ }
    }
  }
  return out.filter((x) => x.size > 0);
}

async function scanSystemJunk() {
  const groups = await Promise.all([
    ...CHILD_JUNK.map((r) => listChildJunk(r.cat, r.base)),
    listContainerCaches(),
    listAppMediaCaches(),
    listAppSupportCaches(),
    listInstallers(),
  ]);
  return groups.flat().sort((a, b) => b.size - a.size);
}

async function getMemory() {
  try {
    const { stdout } = await run('vm_stat', []);
    // parseVmStat (lib/parse.js) turns the raw output into a byte-denominated
    // breakdown; see there for the "cached" approximation rationale.
    return parseVmStat(stdout, os.totalmem());
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
    const files = splitNul(stdout).slice(0, 300);
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
  return false;                          // all probes inconclusive — assume denied (safer)
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

// Precise leftover finder: bundle identifier is the primary (high-confidence)
// signal. App-name matching is only used as a fallback and is deliberately
// conservative — never a loose "*name*" substring, and never for short or
// generic names — so it can't sweep up files belonging to other apps. The match
// rule itself lives in ./lib/match.js (leftoverMatches) so it can be unit-tested.
async function findAppLeftovers(appName, appPath) {
  // Defense-in-depth: appPath arrives over IPC. In normal flow it comes from the
  // /Applications listing, but constrain it before feeding it to PlistBuddy.
  if (!APP_BUNDLE_RE.test(path.resolve(String(appPath || '')))) return [];

  const bundleId = (await getBundleId(appPath)).toLowerCase();
  const searchDirs = [
    path.join(HOME, 'Library', 'Application Support'),
    path.join(HOME, 'Library', 'Caches'),
    path.join(HOME, 'Library', 'Preferences'),
    path.join(HOME, 'Library', 'Logs'),
    path.join(HOME, 'Library', 'Containers'),
    path.join(HOME, 'Library', 'Saved Application State'),
    path.join(HOME, 'Library', 'HTTPStorages'),
  ];
  const found = new Map();
  for (const d of searchDirs) {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!leftoverMatches(e.name, appName, bundleId)) continue;
      const full = path.join(d, e.name);
      if (!found.has(full)) found.set(full, await dirSize(full));
    }
  }
  return [...found.entries()].map(([p, size]) => ({ path: p, size })).sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('scan:dirSize', (_e, p) => { assertSafeToRemove(p); return dirSize(p); });
ipcMain.handle('scan:systemJunk', () => scanSystemJunk());
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
    const launchAgents = path.join(HOME, 'Library', 'LaunchAgents');
    if (!isStrictlyInside(launchAgents, path.resolve(base))) throw new Error('Path is not a LaunchAgents file');
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
