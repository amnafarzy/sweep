'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fmtBytes, fileKind } = require('../lib/format');

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

test('fileKind classifies by extension, case-insensitively', () => {
  assert.equal(fileKind('Holiday.MOV'), 'video');
  assert.equal(fileKind('clip.mp4'), 'video');
  assert.equal(fileKind('song.flac'), 'audio');
  assert.equal(fileKind('photo.HEIC'), 'image');
  assert.equal(fileKind('backup.tar.gz'), 'archive');
  assert.equal(fileKind('installer.dmg'), 'archive');
  assert.equal(fileKind('report.pdf'), 'other');
  assert.equal(fileKind('Makefile'), 'other');       // no extension
  assert.equal(fileKind(''), 'other');
  assert.equal(fileKind('archive.zip.download'), 'other'); // only the final extension counts
});
