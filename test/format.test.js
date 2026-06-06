'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fmtBytes } = require('../lib/format');

test('zero and sub-1-byte values render as "0 B"', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(0.5), '0 B');
  assert.equal(fmtBytes(-5), '0 B');
  assert.equal(fmtBytes(undefined), '0 B');
  assert.equal(fmtBytes(null), '0 B');
  assert.equal(fmtBytes(NaN), '0 B');
});

test('bytes below 1 KB have no decimal places', () => {
  assert.equal(fmtBytes(1), '1 B');
  assert.equal(fmtBytes(1023), '1023 B');
});

test('exact KB / MB / GB / TB boundaries', () => {
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1024 ** 2), '1.0 MB');
  assert.equal(fmtBytes(1024 ** 3), '1.0 GB');
  assert.equal(fmtBytes(1024 ** 4), '1.0 TB');
});

test('non-boundary values round to one decimal', () => {
  assert.equal(fmtBytes(1536), '1.5 KB');           // 1.5 * 1024
  assert.equal(fmtBytes(1024 * 1024 * 2.5), '2.5 MB');
});
