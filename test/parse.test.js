'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseDuKb, splitNul, parseVmStat } = require('../lib/parse');

test('parseDuKb turns "<kb>\\t<path>" into bytes', () => {
  assert.equal(parseDuKb('123456\t/Users/me/Library/Caches/foo\n'), 123456 * 1024);
  assert.equal(parseDuKb('0\t/x'), 0);
});

test('parseDuKb returns 0 for empty / unparseable output', () => {
  assert.equal(parseDuKb(''), 0);
  assert.equal(parseDuKb('not-a-number\t/x'), 0);
  assert.equal(parseDuKb('\t/x'), 0);
});

test('splitNul splits NUL-delimited output and drops the trailing empty', () => {
  assert.deepEqual(splitNul('a\0b\0c'), ['a', 'b', 'c']);
  assert.deepEqual(splitNul('a\0b\0'), ['a', 'b']);
  assert.deepEqual(splitNul(''), []);
});

test('splitNul keeps a filename containing a newline intact', () => {
  // The whole point of -print0: a newline in a name must NOT split the path.
  assert.deepEqual(
    splitNul('/Movies/foo\nbar.mov\0/Movies/baz.txt\0'),
    ['/Movies/foo\nbar.mov', '/Movies/baz.txt'],
  );
});

// A captured-style vm_stat sample with a non-default page size.
const PAGE = 16384;
const VM_SAMPLE = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               100.',
  'Pages active:                             200.',
  'Pages inactive:                           50.',
  'Pages speculative:                        10.',
  'Pages throttled:                          0.',
  'Pages wired down:                         80.',
  'Pages purgeable:                          5.',
  'Pages occupied by compressor:             30.',
  '',
].join('\n');

test('parseVmStat parses the page size and each field into bytes', () => {
  const total = 1000 * PAGE;
  const r = parseVmStat(VM_SAMPLE, total);
  assert.equal(r.total, total);
  assert.equal(r.free, 100 * PAGE);
  assert.equal(r.active, 200 * PAGE);
  assert.equal(r.inactive, 50 * PAGE);
  assert.equal(r.wired, 80 * PAGE);
  assert.equal(r.compressed, 30 * PAGE);
  // cached = total minus everything else, clamped at 0
  assert.equal(r.cached, total - (200 + 80 + 30 + 100) * PAGE);
});

test('parseVmStat falls back to a 4096-byte page when the header is missing', () => {
  const r = parseVmStat('Pages free: 5.', 4096 * 10);
  assert.equal(r.free, 5 * 4096);
  assert.equal(r.active, 0); // missing fields → 0
});

test('parseVmStat clamps cached to 0 instead of going negative', () => {
  const r = parseVmStat('(page size of 4096 bytes)\nPages active: 1000.', 100);
  assert.equal(r.cached, 0);
});
