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

test('rejects an /Applications path that is not a single *.app bundle', () => {
  assert.throws(() => assertSafeToRemove('/Applications'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Foo.txt'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Foo.app/Contents'), /allowed areas/);
  assert.throws(() => assertSafeToRemove('/Applications/Nested/Foo.app'), /allowed areas/);
});

test('isStrictlyInside excludes the parent itself but includes descendants', () => {
  const root = path.join(HOME, 'Library', 'Caches');
  assert.equal(isStrictlyInside(root, root), false);
  assert.equal(isStrictlyInside(root, path.join(root, 'x')), true);
  assert.equal(isStrictlyInside(root, path.dirname(root)), false);
});
