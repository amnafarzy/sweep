// ---------------------------------------------------------------------------
// MEMORY (read-only)
//
// Reads live memory pressure via `vm_stat` and turns it into a byte-denominated
// breakdown. The parsing lives in lib/parse.js (parseVmStat) so it can be
// unit-tested against captured sample output; this module just spawns the
// command and falls back to os-level numbers if it isn't available.
// ---------------------------------------------------------------------------
const os = require('os');

const { run } = require('../lib/exec');
const { parseVmStat } = require('../lib/parse');

async function getMemory() {
  try {
    const { stdout } = await run('vm_stat', []);
    // parseVmStat (lib/parse.js) turns the raw output into a byte-denominated
    // breakdown; see there for the "cached" approximation rationale.
    return parseVmStat(stdout, os.totalmem());
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, free, active: total - free, inactive: 0, wired: 0, compressed: 0, cached: 0 };
  }
}

module.exports = { getMemory };
