// ---------------------------------------------------------------------------
// LOGIN ITEMS  (list + reversible toggle)
//
// Lists the user's LaunchAgents and toggles them by renaming the plist (the
// durable, reversible mechanism launchd reads at login). `toggleLoginItem`
// accepts a path over IPC, so it validates that path in this (main) process —
// it must live inside ~/Library/LaunchAgents and pass assertSafeToRemove —
// before touching the filesystem. The renderer is never trusted.
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

const { runReadable, HOME } = require('../lib/exec');
const { isStrictlyInside, assertSafeToRemove } = require('../lib/safety');

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

async function toggleLoginItem(p, enable) {
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
}

module.exports = { listLoginItems, toggleLoginItem };
