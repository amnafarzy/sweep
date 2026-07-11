'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  leftoverMatches, crashReportMatches, usableBundleId, GENERIC_NAMES,
} = require('../lib/match');

test('matches on bundle id (the high-confidence signal)', () => {
  assert.equal(leftoverMatches('com.tinyspeck.slackmacgap', 'Slack', 'com.tinyspeck.slackmacgap'), true);
  assert.equal(leftoverMatches('com.tinyspeck.slackmacgap.savedState', 'Slack', 'com.tinyspeck.slackmacgap'), true);
  // bundle id wins even when the name alone would be too generic to trust
  assert.equal(leftoverMatches('com.apple.notes.plist', 'Notes', 'com.apple.notes'), true);
});

test('matches an exact or prefixed folder/file name', () => {
  assert.equal(leftoverMatches('Slack', 'Slack', ''), true);            // exact
  assert.equal(leftoverMatches('slack', 'Slack', ''), true);            // case-insensitive
  assert.equal(leftoverMatches('Slack.plist', 'Slack', ''), true);     // "name." prefix
  assert.equal(leftoverMatches('Slack Helper', 'Slack', ''), true);    // "name " prefix
});

test('rejects generic names matched by name alone', () => {
  assert.equal(leftoverMatches('Google', 'Google', ''), false);
  assert.equal(leftoverMatches('Notes', 'Notes', ''), false);
  assert.equal(leftoverMatches('Player', 'Player', ''), false);
  // sanity: every listed generic name is rejected on a bare-name match
  for (const g of GENERIC_NAMES) assert.equal(leftoverMatches(g, g, ''), false);
});

test('rejects names shorter than 4 characters', () => {
  assert.equal(leftoverMatches('TV', 'TV', ''), false);
  assert.equal(leftoverMatches('Zo', 'Zo', ''), false);
});

test('rejects unrelated files', () => {
  assert.equal(leftoverMatches('release-notes.txt', 'Notes', ''), false);
  assert.equal(leftoverMatches('release-notes.txt', 'Slack', ''), false);
  assert.equal(leftoverMatches('com.other.vendor', 'Slack', 'com.tinyspeck.slackmacgap'), false);
  // a substring that is NOT a prefix must not match (no loose *name* matching)
  assert.equal(leftoverMatches('NotSlack', 'Slack', ''), false);
  assert.equal(leftoverMatches('MySlackThing', 'Slack', ''), false);
});

test('matches on any of several bundle ids (main app + nested helpers)', () => {
  const ids = ['com.tinyspeck.slackmacgap', 'com.tinyspeck.slack-loginhelper'];
  assert.equal(leftoverMatches('com.tinyspeck.slack-loginhelper.plist', 'Slack', ids), true);
  assert.equal(leftoverMatches('com.tinyspeck.slackmacgap.savedState', 'Slack', ids), true);
  // team-id-prefixed Group Containers entries still hit via `includes`
  assert.equal(leftoverMatches('AB12CD34EF.com.tinyspeck.slackmacgap', 'Slack', ids), true);
  assert.equal(leftoverMatches('com.other.vendor', 'Slack', ids), false);
  // empty array behaves like no bundle id at all
  assert.equal(leftoverMatches('Slack.plist', 'Slack', []), true);
  assert.equal(leftoverMatches('com.tinyspeck.slackmacgap', 'Zo', []), false);
});

test('ignores degenerate bundle ids that would over-match', () => {
  // a hostile/broken Info.plist yielding "com" must not sweep up com.apple.*
  assert.equal(leftoverMatches('com.apple.dock.plist', 'Zo', ['com']), false);
  assert.equal(leftoverMatches('com.apple.dock.plist', 'Zo', ['apple']), false);
  assert.equal(leftoverMatches('com.apple.dock.plist', 'Zo', ['']), false);
  assert.equal(usableBundleId('com'), false);
  assert.equal(usableBundleId('helper'), false);   // no dot — not reverse-DNS
  assert.equal(usableBundleId('c.a'), false);      // too short
  assert.equal(usableBundleId('com.tinyspeck.slackmacgap'), true);
});

test('crashReportMatches accepts app/process-name-prefixed reports', () => {
  assert.equal(crashReportMatches('Slack_2026-05-01-123456_Mac.crash', 'Slack'), true);
  assert.equal(crashReportMatches('Slack-2026-05-01-123456.ips', 'Slack'), true);
  assert.equal(crashReportMatches('slack.cpu_resource.diag', 'Slack'), true);
  assert.equal(crashReportMatches('Slack Helper (Renderer)_2026-05-01.crash', 'Slack'), true);
});

test('crashReportMatches rejects wrong prefixes, extensions, and weak names', () => {
  assert.equal(crashReportMatches('Slacker_2026-05-01.crash', 'Slack'), false);   // prefix must end at a separator
  assert.equal(crashReportMatches('NotSlack_2026-05-01.crash', 'Slack'), false);
  assert.equal(crashReportMatches('Slack_2026-05-01.txt', 'Slack'), false);       // not a report extension
  assert.equal(crashReportMatches('Slack', 'Slack'), false);
  assert.equal(crashReportMatches('Notes_2026-05-01.crash', 'Notes'), false);     // generic name
  assert.equal(crashReportMatches('Zo_2026-05-01.crash', 'Zo'), false);           // too-short name
});
