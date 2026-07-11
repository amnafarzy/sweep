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
const { leftoverMatches } = require('../lib/match');

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
  for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.endsWith('.app')) { add(e.name, dir); continue; }
      if (dir !== '/Applications' || !e.isDirectory()) continue; // vendor nesting: /Applications only
      const sub = path.join(dir, e.name);
      let subEntries = [];
      try { subEntries = await fsp.readdir(sub); } catch { continue; }
      for (const f of subEntries) if (f.endsWith('.app')) add(f, sub);
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

// Precise leftover finder: bundle identifier is the primary (high-confidence)
// signal. App-name matching is only used as a fallback and is deliberately
// conservative — never a loose "*name*" substring, and never for short or
// generic names — so it can't sweep up files belonging to other apps. The match
// rule itself lives in ../lib/match.js (leftoverMatches) so it can be unit-tested.
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

module.exports = { listInstalledApps, getAppsInfo, findAppLeftovers };
