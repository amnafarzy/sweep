// ---------------------------------------------------------------------------
// UNINSTALLER  (list apps + find leftovers)
//
// Lists installed app bundles and, for a chosen app, finds its leftover support
// files. `findAppLeftovers` receives an app path over IPC, so it re-validates
// that path against APP_BUNDLE_RE in this (main) process before feeding it to
// PlistBuddy. Bundle identifier is the high-confidence match signal; the
// conservative bare-name fallback lives in lib/match.js (leftoverMatches).
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

const { run, dirSize, mapLimit, HOME } = require('../lib/exec');
const { APP_BUNDLE_RE } = require('../lib/safety');
const { leftoverMatches, crashReportMatches } = require('../lib/match');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lists app bundles from the exact locations APP_BUNDLE_RE (lib/safety.js)
// allows: /Applications top level, one level of vendor subfolders inside it
// (many vendors nest their .app in a folder), and ~/Applications top level.
// Fast on purpose — no sizes or dates here, so the list renders immediately;
// getAppsInfo fills those in afterwards.
async function listInstalledApps() {
  const out = [];
  const seen = new Set();
  const add = (file, dir) => {
    const full = path.join(dir, file);
    if (seen.has(full)) return;
    seen.add(full);
    out.push({ name: file.replace(/\.app$/, ''), path: full });
  };
  // A bundle is a directory (or a symlink a user pointed at one); a plain FILE
  // named *.app is not an app and would confuse everything downstream.
  const looksLikeBundle = (e) => e.name.endsWith('.app') && (e.isDirectory() || e.isSymbolicLink());
  for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (looksLikeBundle(e)) { add(e.name, dir); continue; }
      if (dir !== '/Applications' || !e.isDirectory() || e.name.endsWith('.app')) continue; // vendor nesting: /Applications only
      const sub = path.join(dir, e.name);
      let subEntries = [];
      try { subEntries = await fsp.readdir(sub, { withFileTypes: true }); } catch { continue; }
      for (const f of subEntries) if (looksLikeBundle(f)) add(f.name, sub);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Spotlight's last-used date for a bundle. `mdls -raw` prints "(null)" when the
// attribute is missing (never opened, or not indexed) — report that as null so
// the UI can say "unknown" instead of inventing a date.
async function getAppLastUsed(appPath) {
  try {
    const { stdout } = await run('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', appPath]);
    const s = stdout.trim();
    if (!s || s === '(null)') return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t; // epoch ms — serializes cleanly over IPC
  } catch {
    return null;
  }
}

// Size + last-used for a batch of app paths, a few at a time (du on a big app
// takes a moment; don't spawn one per installed app all at once). Paths arrive
// over IPC, so re-validate each against APP_BUNDLE_RE before touching it.
// `onInfo` fires per app as its result lands, letting the UI fill in lazily.
async function getAppsInfo(paths, onInfo) {
  const valid = (Array.isArray(paths) ? paths : [])
    .map((p) => path.resolve(String(p || '')))
    .filter((p) => APP_BUNDLE_RE.test(p));
  return mapLimit(valid, 4, async (p) => {
    const [size, lastUsed] = await Promise.all([dirSize(p), getAppLastUsed(p)]);
    const info = { path: p, size, lastUsed };
    try { onInfo?.(info); } catch { /* a dead window must not kill the batch */ }
    return info;
  });
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

// Helpers nested inside a bundle (login items, Electron/other helper apps in
// Frameworks, XPC services) carry their own bundle identifiers, and their
// leftovers (LaunchAgents, containers, preferences) are named after *those* —
// collect them all so leftoverMatches can match on any of them.
async function collectBundleIds(appPath) {
  const ids = new Set();
  const mainId = (await getBundleId(appPath)).toLowerCase();
  if (mainId) ids.add(mainId);
  const nestDirs = [
    path.join(appPath, 'Contents', 'Library', 'LoginItems'),
    path.join(appPath, 'Contents', 'Frameworks'),
    path.join(appPath, 'Contents', 'XPCServices'),
  ];
  for (const dir of nestDirs) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.app') && !e.endsWith('.xpc')) continue;
      const id = (await getBundleId(path.join(dir, e))).toLowerCase();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

// User-level leftover locations — everything found here is offered for trashing,
// so each entry must sit inside an ALLOWED_ROOT in lib/safety.js.
const USER_LEFTOVER_DIRS = [
  path.join(HOME, 'Library', 'Application Support'),
  path.join(HOME, 'Library', 'Caches'),
  path.join(HOME, 'Library', 'Preferences'),
  path.join(HOME, 'Library', 'Logs'),
  path.join(HOME, 'Library', 'Containers'),
  path.join(HOME, 'Library', 'Saved Application State'),
  path.join(HOME, 'Library', 'HTTPStorages'),
  path.join(HOME, 'Library', 'Group Containers'),
  path.join(HOME, 'Library', 'Application Scripts'),
  path.join(HOME, 'Library', 'LaunchAgents'),
  path.join(HOME, 'Library', 'WebKit'),
  path.join(HOME, 'Library', 'Cookies'),
];

// System-level locations are scanned READ-ONLY: matches are reported so the
// user knows they exist (shown in a "requires admin" section of the confirm
// dialog) but are never trashed — they are deliberately NOT in ALLOWED_ROOTS,
// so assertSafeToRemove would refuse them anyway.
const SYSTEM_LEFTOVER_DIRS = [
  '/Library/Application Support',
  '/Library/LaunchAgents',
  '/Library/LaunchDaemons',
];

// Precise leftover finder: bundle identifiers (the app's own plus its nested
// helpers') are the primary high-confidence signal. App-name matching is only
// used as a fallback and is deliberately conservative — never a loose "*name*"
// substring, and never for short or generic names — so it can't sweep up files
// belonging to other apps. The match rules live in ../lib/match.js
// (leftoverMatches / crashReportMatches) so they can be unit-tested.
// Returns { leftovers, systemLeftovers }: only the former is ever trashed.
async function findAppLeftovers(appName, appPath) {
  // Defense-in-depth: appPath arrives over IPC. In normal flow it comes from the
  // app listing, but constrain it before feeding it to PlistBuddy.
  if (!APP_BUNDLE_RE.test(path.resolve(String(appPath || '')))) {
    return { leftovers: [], systemLeftovers: [] };
  }

  const bundleIds = await collectBundleIds(appPath);

  async function scanDirs(dirs, matches) {
    const found = new Map();
    for (const d of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(d); } catch { continue; }
      for (const name of entries) {
        if (!matches(name)) continue;
        const full = path.join(d, name);
        if (!found.has(full)) found.set(full, await dirSize(full));
      }
    }
    return found;
  }
  const toList = (m) => [...m.entries()].map(([p, size]) => ({ path: p, size })).sort((a, b) => b.size - a.size);

  const found = await scanDirs(USER_LEFTOVER_DIRS, (n) => leftoverMatches(n, appName, bundleIds));
  // Crash/diagnostic reports are named by process, not bundle id, and live in a
  // subfolder of Logs (still inside the Logs allowed root, so trashable).
  const diag = await scanDirs(
    [path.join(HOME, 'Library', 'Logs', 'DiagnosticReports')],
    (n) => crashReportMatches(n, appName),
  );
  for (const [p, size] of diag) if (!found.has(p)) found.set(p, size);

  const sysFound = await scanDirs(SYSTEM_LEFTOVER_DIRS, (n) => leftoverMatches(n, appName, bundleIds));
  return { leftovers: toList(found), systemLeftovers: toList(sysFound) };
}

// Is any process from this bundle running? Trashing a running app fails, so the
// UI checks this first. pgrep -f takes a regex over the full command line —
// escape the bundle path and anchor on its Contents/MacOS/ executable dir so
// helpers running from inside the bundle count too.
async function isAppRunning(appPath) {
  const resolved = path.resolve(String(appPath || ''));
  if (!APP_BUNDLE_RE.test(resolved)) return false;
  try {
    const { stdout } = await run('pgrep', ['-f', escapeRe(path.join(resolved, 'Contents', 'MacOS') + '/')]);
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

// Ask the app to quit gracefully (AppleScript `quit`, addressed by bundle id so
// the name never needs quoting), then poll until its processes are gone. The
// bundle id is interpolated into the AppleScript source, so refuse anything
// that isn't plain reverse-DNS — a hostile Info.plist must not become script.
async function quitApp(appPath) {
  const resolved = path.resolve(String(appPath || ''));
  if (!APP_BUNDLE_RE.test(resolved)) return { ok: false, error: 'Not an app bundle' };
  const bundleId = await getBundleId(resolved);
  if (!/^[A-Za-z0-9.\-]+$/.test(bundleId)) return { ok: false, error: 'App has no usable bundle identifier' };
  try {
    await run('osascript', ['-e', `tell application id "${bundleId}" to quit`], { timeout: 10000 });
  } catch { /* app may show a save dialog or not be scriptable — the poll below decides */ }
  for (let i = 0; i < 10; i++) {
    if (!(await isAppRunning(resolved))) return { ok: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: 'Still running' };
}

module.exports = { listInstalledApps, getAppsInfo, findAppLeftovers, isAppRunning, quitApp };
