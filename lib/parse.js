// ---------------------------------------------------------------------------
// OUTPUT PARSERS  (pure functions — no spawning, no fs; safe to unit-test)
//
// Each takes the raw stdout of a macOS command and turns it into plain data.
// Keeping the parsing here, separate from the spawning in main.js, lets us feed
// captured sample output to the parsers directly in tests.
// ---------------------------------------------------------------------------

// `du -sk` prints "<kb>\t<path>". Return bytes, or 0 if the line is unparseable
// (e.g. empty stdout from a fully-unreadable tree).
function parseDuKb(stdout) {
  const kb = parseInt(String(stdout).split('\t')[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// Split NUL-delimited (`-print0`) output into paths. NUL is the only byte that
// can't appear in a filename, so this is robust even for names with newlines.
function splitNul(stdout) {
  return String(stdout).split('\0').filter(Boolean);
}

// Parse `vm_stat` output into a byte-denominated memory breakdown. `totalmem`
// is the physical RAM total (os.totalmem()), passed in so this stays pure.
//
// "cached" is an approximation for an at-a-glance breakdown (not an exact
// Activity Monitor match): everything physical not otherwise accounted for,
// which folds in `inactive` and file-backed/speculative pages. `inactive` is
// parsed and returned for callers that want it, though the UI rolls it into
// "cached".
function parseVmStat(stdout, totalmem) {
  const s = String(stdout);
  const pageMatch = s.match(/page size of (\d+) bytes/);
  const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 4096;
  const get = (re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : 0; };
  const free = get(/Pages free:\s+(\d+)/) * pageSize;
  const active = get(/Pages active:\s+(\d+)/) * pageSize;
  const inactive = get(/Pages inactive:\s+(\d+)/) * pageSize;
  const wired = get(/Pages wired down:\s+(\d+)/) * pageSize;
  const compressed = get(/Pages occupied by compressor:\s+(\d+)/) * pageSize;
  const total = totalmem;
  const cached = Math.max(0, total - active - wired - compressed - free);
  return { total, free, active, inactive, wired, compressed, cached };
}

module.exports = { parseDuKb, splitNul, parseVmStat };
