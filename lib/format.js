// ---------------------------------------------------------------------------
// FORMAT HELPERS  (pure, environment-agnostic)
//
// UMD-ish wrapper so the same file works both in the Electron renderer (loaded
// via <script>, attaches to window as `SweepFormat`) and under Node's test
// runner (`require('./lib/format')`). Keeping one source of truth means the
// numbers the tests assert on are the exact ones the UI renders.
// ---------------------------------------------------------------------------
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (root) root.SweepFormat = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fmtBytes(n) {
    if (!n || n < 1) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }
  return { fmtBytes };
});
