'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  HOME, APP_BUNDLE_RE, ALLOWED_ROOTS, isStrictlyInside, assertSafeToRemove,
} = require('../lib/safety');

test('accepts a path strictly inside every allowed root', () => {
  for (const root of ALLOWED_ROOTS) {
    const inside = path.join(root, 'some-app-folder');
    assert.equal(assertSafeToRemove(inside), inside);
    // and one level deeper still
    const deeper = path.join(root, 'a', 'b', 'c');
    assert.equal(assertSafeToRemove(deeper), deeper);
  }
});

test('accepts a single /Applications/*.app bundle (incl. names with spaces)', () => {
  assert.equal(assertSafeToRemove('/Applications/Foo.app'), '/Applications/Foo.app');
  assert.equal(assertSafeToRemove('/Applications/Google Chrome.app'), '/Applications/Google Chrome.app');
  assert.ok(APP_BUNDLE_RE.test('/Applications/Foo.app'));
});

test('accepts a bundle one vendor-folder deep inside /Applications', () => {
  assert.equal(assertSafeToRemove('/Applications/Utilities/Foo.app'), '/Applications/Utilities/Foo.app');
  assert.equal(
    assertSafeToRemove('/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app'),
    '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app',
  );
  assert.ok(APP_BUNDLE_RE.test('/Applications/Vendor/Foo.app'));
});

test('accepts a top-level ~/Applications/*.app bundle', () => {
  const p = path.join(HOME, 'Applications', 'Foo.app');
  assert.equal(assertSafeToRemove(p), p);
  const spaced = path.join(HOME, 'Applications', 'My Tool.app');
  assert.equal(assertSafeToRemove(spaced), spaced);
  assert.ok(APP_BUNDLE_RE.test(p));
});

test('rejects each allowed root itself (never trash the whole folder)', () => {
  for (const root of ALLOWED_ROOTS) {
    assert.throws(() => assertSafeToRemove(root), /allowed areas/);
  }
});

test('rejects protected system and home paths', () => {
  for (const p of ['/', HOME, '/System', '/Library', '/usr', '/etc',
                   path.join(HOME, 'Library')]) {
    assert.throws(() => assertSafeToRemove(p), /allowed areas/);
  }
});

test('rejects parent-traversal that escapes an allowed root', () => {
  const caches = path.join(HOME, 'Library', 'Caches');
  // ../.. climbs out of Caches up to HOME (forbidden) and beyond.
  assert.throws(() => assertSafeToRemove(path.join(caches, '..', '..')), /allowed areas/);
  assert.throws(
    () => assertSafeToRemove(path.join(caches, '..', '..', '..', '..', 'etc', 'passwd')),
    /allowed areas/,
  );
  // raw string form with ../ segments resolves and is then rejected
  assert.throws(() => assertSafeToRemove(caches + '/foo/../../../../../etc'), /allowed areas/);
});

test('rejects wrong-case variants on a case-insensitive filesystem', () => {
  // path.resolve is purely lexical and does not normalise case, so a lowercased
  // "library/caches" never matches the correctly-cased allowed root → rejected.
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'library', 'caches', 'foo')), /allowed areas/);
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'LIBRARY', 'Caches', 'foo')), /allowed areas/);
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'downloads', 'x')), /allowed areas/);
});

test('rejects empty / non-string input', () => {
  for (const bad of ['', null, undefined, 0, 123, {}, [], NaN]) {
    assert.throws(() => assertSafeToRemove(bad), /Invalid path/);
  }
});

test('rejects application paths outside the exact allowed bundle depths', () => {
  assert.throws(() => assertSafeToRemove('/Applications'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Foo.txt'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Foo.app/Contents'), /allowed areas/);
  // vendor folder itself, and non-bundle files inside one
  assert.throws(() => assertSafeToRemove('/Applications/Vendor'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Vendor/notes.txt'), /allowed areas/);
  // two levels of nesting is too deep
  assert.throws(() => assertSafeToRemove('/Applications/A/B/Foo.app'), /allowed areas/);
  // a bundle *inside* another bundle is bundle innards, not an app
  assert.throws(() => assertSafeToRemove('/Applications/Foo.app/Nested.app'), /allowed areas/);
  // ~/Applications: root itself, nested bundles, and bundle innards all refused
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'Applications')), /allowed areas/);
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'Applications', 'Sub', 'Foo.app')), /allowed areas/);
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'Applications', 'Foo.app', 'Contents')), /allowed areas/);
  // wrong-case variants never match (see case-insensitivity rationale above)
  assert.throws(() => assertSafeToRemove('/applications/Foo.app'), /allowed areas/);
  assert.throws(() => assertSafeToRemove(path.join(HOME, 'applications', 'Foo.app')), /allowed areas/);
  // a bare ".app" segment is not a bundle name
  assert.throws(() => assertSafeToRemove('/Applications/.app'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Vendor/.app'), /allowed areas/);
});

test('isStrictlyInside excludes the parent itself but includes descendants', () => {
  const root = path.join(HOME, 'Library', 'Caches');
  assert.equal(isStrictlyInside(root, root), false);
  assert.equal(isStrictlyInside(root, path.join(root, 'x')), true);
  assert.equal(isStrictlyInside(root, path.dirname(root)), false);
});
