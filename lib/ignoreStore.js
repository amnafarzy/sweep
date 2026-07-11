// ---------------------------------------------------------------------------
// IGNORE LIST STORE
//
// Persistent set of absolute paths the user excluded from System Junk and
// Large Files results ("Ignore" on a row; reviewed/un-ignored in Settings).
// Stored as a plain JSON array in one file — main.js injects a path under
// Electron's userData dir, so this module stays Electron-free and unit-testable
// with a temp file. Ignoring only ever *hides* paths from scan results; it
// grants nothing, so entries need no validation beyond being strings.
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

function createIgnoreStore(file) {
  let cache = null; // Set of absolute paths, loaded once per process

  async function load() {
    if (cache) return cache;
    try {
      const arr = JSON.parse(await fsp.readFile(file, 'utf8'));
      cache = new Set((Array.isArray(arr) ? arr : []).filter((s) => typeof s === 'string'));
    } catch {
      cache = new Set(); // missing or corrupt file -> start empty
    }
    return cache;
  }

  async function persist() {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify([...cache].sort(), null, 2) + '\n');
  }

  return {
    async list() { return [...(await load())].sort(); },
    async add(p) {
      if (typeof p !== 'string' || !p) return;
      (await load()).add(path.resolve(p));
      await persist();
    },
    async remove(p) {
      if (typeof p !== 'string') return;
      (await load()).delete(path.resolve(p));
      await persist();
    },
    // Drop ignored entries from a scan result ({path, …} items).
    async filterItems(items) {
      const s = await load();
      return (items || []).filter((x) => !s.has(x.path));
    },
  };
}

module.exports = { createIgnoreStore };
