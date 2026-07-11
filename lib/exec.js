// ---------------------------------------------------------------------------
// EXEC + SIZE HELPERS  (the only place that spawns processes)
//
// Shared by every scanner module. Keeping the process-spawning primitives here
// — and nowhere else — means the "no shell, ever" invariant lives in one file:
// `run` is promisified `execFile` (a binary + an argument array, never a shell
// string), and `runReadable` is its permission-tolerant sibling. The scanners in
// scanners/ import from here so they never reach for child_process directly.
// ---------------------------------------------------------------------------
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { parseDuKb } = require('./parse');

const run = promisify(execFile); // runs a binary directly — NO shell, so no metacharacter injection
const HOME = os.homedir();
const LIB = path.join(HOME, 'Library');

// Like `run`, but tolerant: read-only commands such as `du` and `find` exit
// non-zero the moment they touch an unreadable subpath, yet still print useful
// partial output on stdout. Return that stdout instead of throwing, so a single
// permission error deep in a tree doesn't discard the entire result. The one
// error that must NOT be swallowed is an abort (`opts.signal` fired — execFile
// kills the child): cancellation has to propagate, not read as empty output.
async function runReadable(cmd, args, opts) {
  try {
    const { stdout } = await run(cmd, args, opts);
    return stdout;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return typeof err?.stdout === 'string' ? err.stdout : '';
  }
}

// Small concurrency-limited map so we don't spawn hundreds of `du` at once.
// An optional AbortSignal is checked before each item, so a cancelled scan
// stops between spawns instead of grinding through the whole list.
async function mapLimit(arr, limit, fn, signal) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length || 1) }, async () => {
    while (i < arr.length) {
      signal?.throwIfAborted();
      const idx = i++;
      ret[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

// SIZE HELPER (all paths here are absolute, so they never look like a flag)
async function dirSize(p, signal) {
  // `du -sk` prints "<kb>\t<path>"; even on a partial (permission-limited) walk
  // it still reports a running total, which runReadable preserves.
  const stdout = await runReadable('du', ['-sk', p], { signal });
  return parseDuKb(stdout);
}

module.exports = { run, runReadable, mapLimit, dirSize, HOME, LIB };
