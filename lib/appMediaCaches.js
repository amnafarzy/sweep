// ---------------------------------------------------------------------------
// GROUP-CONTAINER MEDIA CACHES  (pure data — no Electron, no fs)
//
// ~/Library/Group Containers holds primary user data (Outlook's mail database,
// Telegram's message store), so it is NOT a generically-trashable root. The one
// thing Sweep's junk scan may remove there is a known re-downloadable media
// cache, and this list is the single source of truth for what counts as one:
// the System Junk scanner (scanners/systemJunk.js) uses it to find cache dirs,
// and the trash guard (lib/safety.js) uses it to validate them independently.
//
// Per rule:
//   container — RegExp over the group-container directory name
//   findPath  — find(1) -path pattern the scanner locates the cache dir with
//   cachePath — equivalent container-relative RegExp the guard validates with
// findPath and cachePath describe the same location — keep them in sync when
// adding rules.
// ---------------------------------------------------------------------------
const APP_MEDIA_CACHES = [
  {
    label: 'Telegram media',
    container: /\.ru\.keepcoder\.Telegram$/,
    findPath: '*/postbox/media',            // e.g. account-123…/postbox/media
    cachePath: /(?:^|\/)postbox\/media$/,   // never postbox itself or its db sibling
  },
];

module.exports = { APP_MEDIA_CACHES };
