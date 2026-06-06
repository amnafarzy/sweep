// ---------------------------------------------------------------------------
// FULL DISK ACCESS PROBE (read-only)
//
// Without Full Disk Access, macOS silently blocks reads of certain locations, so
// cache/large-file scans would be incomplete and look like "nothing found"
// rather than "couldn't read". These directories are readable only with Full
// Disk Access; a permission error on them means it's off.
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

const { HOME } = require('../lib/exec');

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

module.exports = { hasFullDiskAccess };
