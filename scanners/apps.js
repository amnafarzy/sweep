// ---------------------------------------------------------------------------
// UNINSTALLER  (list apps + find leftovers)
//
// Lists /Applications and, for a chosen app, finds its leftover support files.
// `findAppLeftovers` receives an app path over IPC, so it re-validates that path
// against /Applications/*.app in this (main) process before feeding it to
// PlistBuddy. Bundle identifier is the high-confidence match signal; the
// conservative bare-name fallback lives in lib/match.js (leftoverMatches).
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

const { run, dirSize, HOME } = require('../lib/exec');
const { APP_BUNDLE_RE } = require('../lib/safety');
const { leftoverMatches } = require('../lib/match');

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

module.exports = { listInstalledApps, findAppLeftovers };
