// ---------------------------------------------------------------------------
// RENDERER PARSE CHECK
//
// The unit tests (`node --test`) only exercise lib/, so a syntax error in the
// renderer modules (renderer.js, views/*, ui/*) would sail through CI and only
// blow up when the app is actually opened. This script dynamically imports each
// renderer module under plain Node: parse/early errors (SyntaxError, duplicate
// exports, bad import syntax) fail the process, while expected runtime errors —
// these modules assume a browser (`window`, `document`, window.SweepFormat from
// a classic <script>) — are ignored, since reaching evaluation means the file
// parsed cleanly.
//
// Run via `npm run check:renderer` (also part of `npm test`).
// ---------------------------------------------------------------------------
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function jsFilesIn(dir) {
  const entries = await readdir(path.join(root, dir));
  return entries.filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f));
}

const files = ['renderer.js', ...(await jsFilesIn('ui')), ...(await jsFilesIn('views'))];

// A module that reaches evaluation parsed fine; only errors raised before
// evaluation (or clearly parse-shaped ones rethrown from a dependency) count.
function isParseError(err) {
  if (err instanceof SyntaxError) return true;
  const msg = String(err && err.message);
  return /Unexpected token|Unexpected reserved word|Unexpected identifier/.test(msg);
}

let failures = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(path.join(root, file)).href);
    console.log(`ok      ${file}`);
  } catch (err) {
    if (isParseError(err)) {
      failures++;
      console.error(`FAIL    ${file}`);
      console.error(`        ${err.constructor.name}: ${err.message}`);
    } else {
      // Expected outside a browser: `window is not defined`, missing
      // window.SweepFormat / window.sweep, etc. The file still parsed.
      console.log(`ok      ${file} (runtime error ignored: ${String(err && err.message).split('\n')[0]})`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} renderer module(s) failed to parse.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} renderer modules parsed cleanly.`);
