'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { leftoverMatches, GENERIC_NAMES } = require('../lib/match');

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
