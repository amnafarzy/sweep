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
const path = require('path');
const fsp = require('fs/promises');

const { runReadable, mapLimit, dirSize, HOME, LIB } = require('../lib/exec');
const { splitNul } = require('../lib/parse');
const { APP_MEDIA_CACHES } = require('../lib/appMediaCaches');

// "Children" rules: every direct child of `base` is an independent junk item.
// `exclude` names children surfaced by another category instead (never twice);
// `warn` puts an explicit caution label on every item of the category.
const CHILD_JUNK = [
  { cat: 'User caches',        base: path.join(LIB, 'Caches'), exclude: ['CocoaPods'] }, // CocoaPods → Dev tool caches
  { cat: 'App logs',           base: path.join(LIB, 'Logs') },
  { cat: 'Saved app state',    base: path.join(LIB, 'Saved Application State') },
  { cat: 'Xcode derived data', base: path.join(LIB, 'Developer', 'Xcode', 'DerivedData') },
  { cat: 'Xcode archives',     base: path.join(LIB, 'Developer', 'Xcode', 'Archives') },
  { cat: 'iOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'iOS DeviceSupport') },
  { cat: 'watchOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'watchOS DeviceSupport') },
  { cat: 'tvOS device support', base: path.join(LIB, 'Developer', 'Xcode', 'tvOS DeviceSupport') },
  { cat: 'Simulator caches',   base: path.join(LIB, 'Developer', 'CoreSimulator', 'Caches') },
  // NOT regenerable: an iOS/iPadOS backup is the only copy of that device's
  // restore point. Surfaced for review like everything else (nothing is ever
  // pre-checked), but carries an explicit warning label in the UI.
  { cat: 'iOS backups',        base: path.join(LIB, 'Application Support', 'MobileSync', 'Backup'),
    warn: 'Device backup — deleting it removes your ability to restore that device' },
];

async function listChildJunk({ cat, base, exclude, warn }, signal) {
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const skip = new Set(exclude || []);
  const kids = entries.filter((e) => (e.isDirectory() || e.isFile()) && !skip.has(e.name));
  const sized = await mapLimit(kids, 8, async (e) => {
    const full = path.join(base, e.name);
    return { name: e.name, path: full, size: await dirSize(full, signal), category: cat, ...(warn ? { warn } : {}) };
  }, signal);
  return sized.filter((x) => x.size > 0);
}

// Single-location rules: one junk item per fixed path (when it exists).
const SINGLE_JUNK = [
  // Attachments Mail has already downloaded — re-fetched from the mail server.
  { cat: 'Mail downloads', name: 'Mail Downloads',
    p: path.join(LIB, 'Containers', 'com.apple.mail', 'Data', 'Library', 'Mail Downloads') },
  // Package-manager caches: pure re-downloadable artifacts.
  { cat: 'Dev tool caches', name: 'npm cache', p: path.join(HOME, '.npm', '_cacache') },
  { cat: 'Dev tool caches', name: 'Gradle caches', p: path.join(HOME, '.gradle', 'caches') },
  { cat: 'Dev tool caches', name: 'CocoaPods cache', p: path.join(LIB, 'Caches', 'CocoaPods') },
];

async function listSingleJunk(signal) {
  const sized = await mapLimit(SINGLE_JUNK, 4, async ({ cat, name, p }) => (
    { name, path: p, size: await dirSize(p, signal), category: cat }
  ), signal);
  return sized.filter((x) => x.size > 0);
}

// ~/.cache (the XDG cache dir many CLI tools share) is itself an allowed root,
// and roots are never trashable — so the row shows ~/.cache but carries its
// children in `paths`, the same expand-on-clean shape the grouped app rows use.
async function listDotCache(signal) {
  const base = path.join(HOME, '.cache');
  let entries = [];
  try { entries = await fsp.readdir(base); } catch { return []; }
  if (!entries.length) return [];
  const size = await dirSize(base, signal);
  if (size <= 0) return [];
  return [{
    name: 'User cache dir (~/.cache)', path: base,
    paths: entries.map((e) => path.join(base, e)),
    size, category: 'Dev tool caches',
  }];
}

// Sandboxed apps keep a private cache at Containers/<id>/Data/Library/Caches.
// macOS hides these from ~/Library/Caches, so they're a large blind spot. We
// target the per-app Caches dir only — never the sibling data the app relies on.
async function listContainerCaches(signal) {
  const base = path.join(LIB, 'Containers');
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory());
  const sized = await mapLimit(dirs, 8, async (e) => {
    const cacheDir = path.join(base, e.name, 'Data', 'Library', 'Caches');
    try { await fsp.access(cacheDir); } catch { return null; }      // app has no cache dir
    return { name: e.name, path: cacheDir, size: await dirSize(cacheDir, signal), category: 'Sandboxed app caches' };
  }, signal);
  return sized.filter((x) => x && x.size > 0);
}

// Per-app media caches: re-downloadable content some apps stash in their group
// container, which never shows up under ~/Library/Caches and can reach tens of
// GB. The rules live in lib/appMediaCaches.js — shared with the trash guard, so
// the scanner and lib/safety.js can never drift apart on what's removable here.
// We only ever touch the media cache, never the message database or account
// data sitting beside it; Telegram's account-*/postbox/media is the canonical
// example.
async function listAppMediaCaches(signal) {
  const base = path.join(LIB, 'Group Containers');
  let entries = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rule = APP_MEDIA_CACHES.find((r) => r.container.test(e.name));
    if (!rule) continue;
    const root = path.join(base, e.name);
    // -prune so find reports the matching dir without walking into it (du sizes it).
    const stdout = await runReadable(
      'find', [root, '-type', 'd', '-path', rule.findPath, '-prune', '-print0'],
      { maxBuffer: 1024 * 1024, signal }
    );
    const dirs = splitNul(stdout);
    const sized = await mapLimit(dirs, 4, async (d) => (
      { name: rule.label, path: d, size: await dirSize(d, signal), category: 'App media caches' }
    ), signal);
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
async function listAppSupportCaches(signal) {
  const base = path.join(LIB, 'Application Support');
  const nameArgs = [];
  CACHE_DIR_NAMES.forEach((n, i) => { if (i) nameArgs.push('-o'); nameArgs.push('-name', n); });
  // `( -name … ) -prune -print0`: print each matching cache dir without descending
  // into it (so nested caches aren't double-counted), and keep walking elsewhere.
  const stdout = await runReadable(
    'find', [base, '-maxdepth', '5', '-type', 'd', '(', ...nameArgs, ')', '-prune', '-print0'],
    { maxBuffer: 1024 * 1024 * 8, signal }
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
    const sizes = await mapLimit(paths, 4, (p) => dirSize(p, signal), signal);
    const size = sizes.reduce((s, n) => s + n, 0);
    // `paths` carries every subfolder to trash; `path` is the app dir, shown to the user.
    return { name: app, path: path.join(base, app), paths, size, category: 'App caches' };
  }, signal);
  return items.filter((x) => x.size > 0);
}

// Disk images and installer packages left in Downloads/Desktop after the app
// they carried is already installed — pure leftovers, safe to trash. Surfaced
// for review (unchecked by default) since they're loose user files.
async function listInstallers(signal) {
  const roots = [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop')];
  const out = [];
  for (const root of roots) {
    const stdout = await runReadable(
      'find', [root, '-maxdepth', '2', '-type', 'f', '(', '-iname', '*.dmg', '-o', '-iname', '*.pkg', ')', '-print0'],
      { maxBuffer: 1024 * 1024, signal }
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

// Full junk scan. `signal` (AbortSignal) cancels between du/find spawns and
// kills in-flight ones; `onProgress({phase, done, total})` fires as each
// category group completes, so the UI can show live progress. Both optional —
// a plain scanSystemJunk() behaves exactly as before.
async function scanSystemJunk({ signal, onProgress } = {}) {
  const tasks = [
    ...CHILD_JUNK.map((r) => ({ phase: r.cat, run: () => listChildJunk(r, signal) })),
    { phase: 'Mail & dev tool caches', run: () => listSingleJunk(signal) },
    { phase: 'User cache dir', run: () => listDotCache(signal) },
    { phase: 'Sandboxed app caches', run: () => listContainerCaches(signal) },
    { phase: 'App media caches', run: () => listAppMediaCaches(signal) },
    { phase: 'App caches', run: () => listAppSupportCaches(signal) },
    { phase: 'Installers & disk images', run: () => listInstallers(signal) },
  ];
  let done = 0;
  const groups = await Promise.all(tasks.map(async (t) => {
    const res = await t.run();
    done += 1;
    onProgress?.({ phase: t.phase, done, total: tasks.length });
    return res;
  }));
  return groups.flat().sort((a, b) => b.size - a.size);
}

// Every mounted volume keeps its own per-user trash at /Volumes/<vol>/.Trashes/<uid>.
// Sized here so the Trash view reports the real total; never trashed by Sweep
// itself (out of ALLOWED_ROOTS) — Finder's "empty trash" already covers external
// volumes, so the existing Empty Trash flow deletes these too.
async function trashTotalSize(signal) {
  const sizes = [dirSize(path.join(HOME, '.Trash'), signal)];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null) {
    let vols = [];
    try { vols = await fsp.readdir('/Volumes', { withFileTypes: true }); } catch { /* none */ }
    // real mount points are directories; skip the boot-volume symlink (→ /)
    for (const v of vols.filter((e) => e.isDirectory())) {
      const t = path.join('/Volumes', v.name, '.Trashes', String(uid));
      try { await fsp.access(t); sizes.push(dirSize(t, signal)); } catch { /* volume has no trash for us */ }
    }
  }
  return (await Promise.all(sizes)).reduce((s, n) => s + n, 0);
}

module.exports = { scanSystemJunk, trashTotalSize };
