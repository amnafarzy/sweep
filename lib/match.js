// ---------------------------------------------------------------------------
// APP LEFTOVER MATCHER  (pure logic — no fs; safe to unit-test)
//
// Decides whether a file/dir entry under ~/Library belongs to a given app.
// Bundle identifier is the primary (high-confidence) signal. App-name matching
// is only a fallback and is deliberately conservative — never a loose "*name*"
// substring, and never for short or generic names — so it can't sweep up files
// belonging to other apps.
// ---------------------------------------------------------------------------

// Names too short or too generic to be a reliable signal on their own — matching
// these by name alone would sweep up unrelated vendors' files (e.g. an app called
// "Google" matching the shared ~/Library/Application Support/Google).
const GENERIC_NAMES = new Set([
  'app', 'apps', 'player', 'update', 'updater', 'helper', 'agent', 'service',
  'music', 'tv', 'notes', 'mail', 'calendar', 'photos', 'home', 'store', 'books',
  'news', 'stocks', 'clock', 'files', 'preview', 'pro', 'lite', 'free', 'beta',
  'google', 'microsoft', 'adobe', 'apple', 'data', 'cache', 'common', 'shared',
]);

// Does directory/file entry `entryName` look like it belongs to the app
// identified by `appName` / `bundleId`? `bundleId` may be '' when unavailable.
function leftoverMatches(entryName, appName, bundleId) {
  const b = String(entryName).toLowerCase();
  const nameLc = String(appName).toLowerCase();
  const bid = String(bundleId || '').toLowerCase();
  // A bare app name is only trustworthy if it's specific enough.
  const nameUsable = nameLc.length >= 4 && !GENERIC_NAMES.has(nameLc);
  if (bid && b.includes(bid)) return true;                     // com.vendor.app(.plist/.savedState/…)
  if (!nameUsable) return false;                               // name too weak to trust alone
  if (b === nameLc) return true;                               // "Slack"
  if (b.startsWith(nameLc + '.') || b.startsWith(nameLc + ' ')) return true; // "Slack.plist", "Slack Helper"
  return false;
}

module.exports = { GENERIC_NAMES, leftoverMatches };
