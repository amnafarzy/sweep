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

  // Coarse file-kind classification by extension, for the Large Files filter.
  const FILE_KIND_EXTS = {
    video: ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'ts'],
    audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'aiff', 'aif', 'alac', 'wma', 'mid'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'webp', 'svg', 'psd', 'raw', 'cr2', 'nef', 'arw'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'txz', 'dmg', 'iso', 'pkg', 'xip'],
  };

  function fileKind(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    if (!m) return 'other';
    for (const kind of Object.keys(FILE_KIND_EXTS)) {
      if (FILE_KIND_EXTS[kind].includes(m[1])) return kind;
    }
    return 'other';
  }

  return { fmtBytes, fileKind };
});
