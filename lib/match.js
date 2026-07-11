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

// A bundle id is only a trustworthy `includes` needle when it looks like a real
// reverse-DNS identifier. Ids are read from Info.plists (including nested
// helpers'), and a degenerate one ("com", "app") would match half of ~/Library.
function usableBundleId(id) {
  const s = String(id || '').toLowerCase();
  return s.length >= 6 && s.includes('.');
}

// Does directory/file entry `entryName` look like it belongs to the app
// identified by `appName` / `bundleIds`? `bundleIds` may be a single id string
// (possibly '') or an array of ids — an app's own id plus any collected from
// its nested helper bundles.
function leftoverMatches(entryName, appName, bundleIds) {
  const b = String(entryName).toLowerCase();
  const nameLc = String(appName).toLowerCase();
  const ids = (Array.isArray(bundleIds) ? bundleIds : [bundleIds])
    .map((id) => String(id || '').toLowerCase())
    .filter(usableBundleId);
  // A bare app name is only trustworthy if it's specific enough.
  const nameUsable = nameLc.length >= 4 && !GENERIC_NAMES.has(nameLc);
  if (ids.some((id) => b.includes(id))) return true;           // com.vendor.app(.plist/.savedState/…), TEAMID.com.vendor.app
  if (!nameUsable) return false;                               // name too weak to trust alone
  if (b === nameLc) return true;                               // "Slack"
  if (b.startsWith(nameLc + '.') || b.startsWith(nameLc + ' ')) return true; // "Slack.plist", "Slack Helper"
  return false;
}

// Crash/diagnostic reports in ~/Library/Logs/DiagnosticReports are named after
// the *process*, e.g. "Slack_2026-05-01-123456_Mac.crash", "Slack-2026….ips",
// "Slack Helper (Renderer)_2026….crash". Match by app-name prefix followed by a
// separator, with the same too-short/too-generic guard as leftoverMatches, and
// only for known report extensions — never a bare prefix on arbitrary files.
const CRASH_REPORT_EXT_RE = /\.(crash|ips|diag|spin|hang)$/;

function crashReportMatches(fileName, appName) {
  const f = String(fileName).toLowerCase();
  const nameLc = String(appName).toLowerCase();
  if (!CRASH_REPORT_EXT_RE.test(f)) return false;
  if (nameLc.length < 4 || GENERIC_NAMES.has(nameLc)) return false;
  if (!f.startsWith(nameLc)) return false;
  const next = f[nameLc.length];
  return next === '_' || next === '-' || next === '.' || next === ' ';
}

module.exports = { GENERIC_NAMES, usableBundleId, leftoverMatches, crashReportMatches };
