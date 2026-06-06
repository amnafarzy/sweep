// ---------------------------------------------------------------------------
// LARGE FILES (read-only)
//
// Walks the user's personal folders for files over a size threshold. Results are
// capped so an enormous tree can't produce an unbounded list.
// ---------------------------------------------------------------------------
const path = require('path');
const fsp = require('fs/promises');

const { runReadable, HOME } = require('../lib/exec');
const { splitNul } = require('../lib/parse');

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

module.exports = { scanLargeFiles };
