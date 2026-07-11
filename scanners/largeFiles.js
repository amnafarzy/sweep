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

// `signal` cancels between roots and kills an in-flight find; `onProgress`
// fires as each root finishes. Both optional.
async function scanLargeFiles(minMB, { signal, onProgress } = {}) {
  const n = Number.isFinite(+minMB) && +minMB > 0 ? Math.floor(+minMB) : 100;
  const roots = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Music', 'Pictures']
    .map((d) => path.join(HOME, d));
  const results = [];
  let done = 0;
  for (const root of roots) {
    signal?.throwIfAborted();
    // runReadable keeps any files printed before find hit an unreadable subdir.
    const stdout = await runReadable(
      'find',
      [root, '-type', 'f', '-size', `+${n}M`, '-not', '-path', '*/.*', '-print0'],
      { maxBuffer: 1024 * 1024 * 16, signal }
    );
    // NUL-delimited so filenames containing newlines aren't split into bogus paths.
    const files = splitNul(stdout).slice(0, 300);
    for (const f of files) {
      try {
        const st = await fsp.stat(f);
        results.push({
          name: path.basename(f), path: f, size: st.size, dir: root.split('/').pop(),
          lastOpened: st.atime.getTime(), // atime: cheap and good enough for "last opened"
        });
      } catch { /* skip */ }
    }
    done += 1;
    onProgress?.({ phase: path.basename(root), done, total: roots.length });
  }
  return results.sort((a, b) => b.size - a.size).slice(0, 100);
}

module.exports = { scanLargeFiles };
