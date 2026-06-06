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

module.exports = { scanSystemJunk };
