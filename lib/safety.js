// ---------------------------------------------------------------------------
// SAFETY GUARDS  (pure logic — no Electron, no fs; safe to unit-test)
//
// Allowlist model: a path may only be trashed if it sits *strictly inside* one
// of the directories Sweep actually scans, or is a single .app bundle at one of
// the exact depths APP_BUNDLE_RE allows. Everything else is refused — including
// the allowed roots themselves
// (so we never trash all of ~/Library/Caches, ~/Documents, etc.) and every
// protected system path.
//
// This fails CLOSED: a path we don't recognise is rejected, not allowed. It also
// closes the case-sensitivity gap of a denylist — macOS's default volume is
// case-insensitive, so a denylist keyed on exact casing ("/Library") could be
// slipped past with "/library". An allowlist of known-cased roots instead
// rejects any path whose casing doesn't match a root we scan, which is the safe
// outcome (a real path from a scan always has the correct casing).
// ---------------------------------------------------------------------------
const path = require('path');
const os = require('os');

const { APP_MEDIA_CACHES } = require('./appMediaCaches');

const HOME = os.homedir();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A trashable app bundle is exactly one of:
//   /Applications/X.app                      — top level
//   /Applications/<vendor folder>/X.app      — one level of vendor nesting; the
//                                              folder itself must not be a bundle,
//                                              so nothing inside another .app matches
//   ~/Applications/X.app                     — per-user apps, top level only
// Nothing deeper, and never a path inside a bundle (…/Contents etc.).
const APP_BUNDLE_RE = new RegExp(
  '^(?:'
  + '/Applications/[^/]+\\.app'
  + '|/Applications/[^/]+(?<!\\.app)/[^/]+\\.app'
  + '|' + escapeRe(path.join(HOME, 'Applications')) + '/[^/]+\\.app'
  + ')$',
);

const ALLOWED_ROOTS = [
  path.join(HOME, 'Library', 'Caches'),
  path.join(HOME, 'Library', 'Application Support'),
  path.join(HOME, 'Library', 'Preferences'),
  path.join(HOME, 'Library', 'Logs'),
  path.join(HOME, 'Library', 'Containers'),
  path.join(HOME, 'Library', 'Saved Application State'),
  path.join(HOME, 'Library', 'HTTPStorages'),
  path.join(HOME, 'Library', 'LaunchAgents'),
  path.join(HOME, 'Library', 'Application Scripts'), // per-app sandbox script dirs (named by bundle id)
  path.join(HOME, 'Library', 'WebKit'),              // per-app WebKit storage (named by bundle id)
  path.join(HOME, 'Library', 'Cookies'),             // per-app binarycookies (named by bundle id)
  path.join(HOME, 'Library', 'Developer'),        // Xcode DerivedData / DeviceSupport / simulator caches
  // Dev-tool cache homes, added deliberately and individually — never a broad
  // "any dotfile dir" rule. As with every root, only strict descendants are
  // trashable: ~/.npm/_cacache yes, ~/.npm itself (which also holds npm config
  // state on some setups) no.
  path.join(HOME, '.npm'),    // we only ever target _cacache inside
  path.join(HOME, '.cache'),  // XDG cache dir — scanner trashes its children, never the root
  path.join(HOME, '.gradle'), // we only ever target caches/ inside
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Movies'),
  path.join(HOME, 'Music'),
  path.join(HOME, 'Pictures'),
];

// Strictly inside = a descendant of `parent`, never `parent` itself.
function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ~/Library/Group Containers is deliberately NOT a generic allowed root: nested
// paths there are primary user data (Outlook's mail database, Telegram's
// message store), and "anything strictly inside" would let a scanner bug trash
// them. Only two shapes are allowed:
//   - a whole container (direct child): what the Uninstaller trashes after
//     matching the container to the app being removed, with the full path
//     shown in the confirmation dialog;
//   - a known regenerable media-cache path from lib/appMediaCaches.js (the
//     same rules the System Junk scanner emits from), or anything inside one.
// Every other nested path — databases, account data, preferences — is refused.
const GROUP_CONTAINERS = path.join(HOME, 'Library', 'Group Containers');

function groupContainerAllowed(resolved) {
  const rel = path.relative(GROUP_CONTAINERS, resolved);
  const segs = rel.split(path.sep);
  if (segs.length === 1) return true;                        // whole container (uninstall flow)
  const rule = APP_MEDIA_CACHES.find((r) => r.container.test(segs[0]));
  if (!rule) return false;
  const inner = segs.slice(1);
  for (let i = 1; i <= inner.length; i++) {                  // the cache dir itself or a descendant
    if (rule.cachePath.test(inner.slice(0, i).join('/'))) return true;
  }
  return false;
}

function assertSafeToRemove(p) {
  if (!p || typeof p !== 'string') throw new Error('Invalid path');
  const resolved = path.resolve(p);
  if (APP_BUNDLE_RE.test(resolved)) return resolved;            // a single app bundle
  if (isStrictlyInside(GROUP_CONTAINERS, resolved)) {           // pattern-gated, see above
    if (groupContainerAllowed(resolved)) return resolved;
    throw new Error(`Refusing to operate on a path outside Sweep's allowed areas (Group Containers holds app data — only whole containers or known media caches): ${resolved}`);
  }
  if (ALLOWED_ROOTS.some((root) => isStrictlyInside(root, resolved))) return resolved;
  throw new Error(`Refusing to operate on a path outside Sweep's allowed areas: ${resolved}`);
}

module.exports = { HOME, APP_BUNDLE_RE, ALLOWED_ROOTS, isStrictlyInside, assertSafeToRemove };
