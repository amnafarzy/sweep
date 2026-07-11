'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const { createIgnoreStore } = require('../lib/ignoreStore');

async function tmpStoreFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sweep-ignore-'));
  return path.join(dir, 'sub', 'ignored.json'); // parent dir doesn't exist yet — add() must create it
}

test('add / list / remove round-trip, sorted and deduplicated', async () => {
  const store = createIgnoreStore(await tmpStoreFile());
  assert.deepEqual(await store.list(), []);
  await store.add('/Users/x/Library/Caches/b');
  await store.add('/Users/x/Library/Caches/a');
  await store.add('/Users/x/Library/Caches/b'); // duplicate
  assert.deepEqual(await store.list(), ['/Users/x/Library/Caches/a', '/Users/x/Library/Caches/b']);
  await store.remove('/Users/x/Library/Caches/a');
  assert.deepEqual(await store.list(), ['/Users/x/Library/Caches/b']);
});

test('entries persist across store instances (the JSON file is the truth)', async () => {
  const file = await tmpStoreFile();
  await createIgnoreStore(file).add('/Users/x/Downloads/big.mov');
  assert.deepEqual(await createIgnoreStore(file).list(), ['/Users/x/Downloads/big.mov']);
});

test('filterItems drops ignored paths and keeps the rest', async () => {
  const store = createIgnoreStore(await tmpStoreFile());
  await store.add('/Users/x/Library/Caches/ignored');
  const items = [
    { path: '/Users/x/Library/Caches/ignored', size: 1 },
    { path: '/Users/x/Library/Caches/kept', size: 2 },
  ];
  assert.deepEqual(await store.filterItems(items), [{ path: '/Users/x/Library/Caches/kept', size: 2 }]);
  assert.deepEqual(await store.filterItems(null), []);
});

test('a corrupt or non-array store file starts empty instead of crashing', async () => {
  const file = await tmpStoreFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'not json at all {');
  assert.deepEqual(await createIgnoreStore(file).list(), []);
  await fsp.writeFile(file, '{"nope": true}');
  assert.deepEqual(await createIgnoreStore(file).list(), []);
  await fsp.writeFile(file, '["/ok", 42, null, "/also-ok"]'); // non-strings dropped
  assert.deepEqual(await createIgnoreStore(file).list(), ['/also-ok', '/ok']);
});

test('non-string input to add/remove is a no-op', async () => {
  const store = createIgnoreStore(await tmpStoreFile());
  for (const bad of [null, undefined, 42, {}, [], '']) await store.add(bad);
  await store.remove(null);
  assert.deepEqual(await store.list(), []);
});
