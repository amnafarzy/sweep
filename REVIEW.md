# Sweep — Code Review

**Reviewer:** automated static review
**Date:** 2026-06-02
**Scope:** `main.js`, `preload.js`, `renderer.js`, `index.html`, `package.json`, `README.md`
**Platform caveat:** Reviewed statically on Linux. The macOS-specific commands
(`vm_stat`, `du`, `find`, `PlistBuddy`, `osascript`, `shell.trashItem`) could **not**
be executed at runtime. Findings about their output parsing are reasoned from the
documented macOS behaviour and are flagged where I could not verify them live.

---

## Summary

Sweep is, on the whole, **conservatively designed and the security fundamentals are
right**: every external command runs through `execFile` with argument arrays (no shell),
`contextIsolation` is on and `nodeIntegration` is off, the preload surface is minimal
and invoke-only, deletions go to the Trash (recoverable), and destructive actions are
gated behind a confirmation modal. There is a real `assertSafeToRemove` guard and it is
re-checked in the main process on every destructive call.

That said, the guard has a **case-sensitivity gap** that defeats its own denylist on a
default macOS filesystem, and the **uninstaller's leftover matching plus its
"show 20 but delete all" behaviour** is the highest data-loss risk in normal use. Neither
is catastrophic because everything is recoverable from the Trash, but both deserve a fix
before first run. Details and severities below.

---

## What's done well (verified)

- **No shell anywhere.** `run = promisify(execFile)` (`main.js:8`) and every call passes a
  binary + arg array — `du`, `vm_stat`, `find`, `PlistBuddy`, `osascript`. No string
  interpolation reaches a shell, so metacharacter / argument injection is not possible.
- **All dynamic args are absolute paths or sanitised integers**, so they can't be
  misread as flags (`du -sk <abs>`, `find <abs> -size +<int>M`). `scanLargeFiles`
  floors and bounds `minMB` (`main.js:105`).
- **Window hardening** is correct: `contextIsolation: true`, `nodeIntegration: false`
  (`main.js:271-272`), preload via `contextBridge` only.
- **Minimal preload** (`preload.js`): only `ipcRenderer.invoke` wrappers are exposed; no
  `ipcRenderer`, `require`, `fs`, or Node primitives leak to the renderer.
- **CSP present** (`index.html:5`): `default-src 'self'; script-src 'self'`.
- **Deletes are recoverable** — `moveToTrash` → `shell.trashItem` (`main.js:38-41`), never
  `fs.rm`/`unlink`. The one permanent action (Empty Trash) is clearly labelled and confirmed.
- **Destructive actions are confirmed** in the renderer modal (caches, large files, empty
  trash, uninstall). Login-item toggle is reversible by design, so no modal is reasonable.
- **Concurrency is bounded** (`mapLimit`, `main.js:44-52`) so `du` isn't fork-bombed.

---

## CRITICAL

None found that cause **unrecoverable** loss in normal single-user operation: the only
permanent deletion (`clean:emptyTrash`) is explicitly confirmed with "cannot be undone"
(`renderer.js:125`), and every other destructive path routes to the Trash. The items
below that touch data loss are ranked **High** because they are recoverable.

---

## HIGH

### H1 — `assertSafeToRemove` denylist is case-sensitive on a case-insensitive filesystem
**`main.js:14-36`**

macOS's default APFS volume is **case-insensitive but case-preserving**. The `FORBIDDEN`
set and the `/Applications/...\.app` regex compare with exact case:

```js
const FORBIDDEN = new Set(['/', HOME, '/System', '/Library', ...,
  path.join(HOME, 'Library'), path.join(HOME, 'Documents'), path.join(HOME, 'Desktop')]);
```

`path.resolve` is purely lexical and does **not** normalise case. So a path like
`~/library` (lowercase L) or `~/LIBRARY`:
- `FORBIDDEN.has('/Users/me/library')` → **false** (string mismatch), and
- `isInsideHome()` → **true** (it is lexically under HOME),

so the guard **passes it** and `shell.trashItem` would move the user's entire `~/Library`
(or `~/documents`, `~/desktop`) to the Trash — exactly the directories the denylist is
meant to protect. The README explicitly promises the guard holds "no matter what the UI
sends" (`README.md:21`), and this breaks that promise.

**Exploitability:** in normal flow the scanners emit correctly-cased paths, so this only
triggers if a malicious/incorrectly-cased path reaches IPC (e.g. a compromised renderer,
or a future caller). Recoverable from Trash. But it is the app's *last line of defense*
and it is bypassable.

**Fix:** normalise case for comparison on macOS, and compare against a canonical form
(e.g. `realpathSync` where the path exists, plus a lowercased compare for the denylist),
or, better, switch from a denylist to an **allowlist** of permitted roots
(`~/Library/Caches`, `~/Downloads`, the six large-file roots, `~/Library/LaunchAgents`,
`/Applications/*.app`) and reject everything else.

### H2 — Uninstaller deletes *all* matched leftovers but only shows the first 20
**`renderer.js:209-223`** (esp. `214-220`)

```js
const shown = all.slice(0, 20).map((x) => '• ' + x.path).join('\n');
const more  = all.length > 20 ? `\n…and ${all.length - 20} more` : '';
...
const res = await api.trashFiles(all.map((x) => x.path));   // trashes ALL, not just shown
```

The confirmation lists at most 20 paths, but `trashFiles` is given **every** matched
path. If the matcher over-collects (see H3), the user can approve the deletion of files
they never saw. Recoverable, but it undermines the "scan first, review, then clean"
guarantee.

**Fix:** either show all paths (scrollable list) or cap the *deletion* to what was
displayed; at minimum make the count explicit ("Move all N items, including N−20 not
shown").

### H3 — Leftover matching can sweep up unrelated files for short/generic app names
**`main.js:174-204`** (matcher `186-192`)

The matcher is more careful than a naïve `*name*` substring, but the bare-name rules:

```js
if (b === nameLc) return true;                                  // exact folder name
if (b.startsWith(nameLc + '.') || b.startsWith(nameLc + ' ')) return true;
```

are still risky for **common/short app names**. Examples:
- An app literally named **"Google"** would match `~/Library/Application Support/Google`,
  which is shared by Chrome, Drive, Earth, etc.
- Names like **"Player", "Update", "Helper", "Music", "Notes"** can exact-match directories
  owned by other vendors or by Apple.

Combined with H2, the user may not even see the over-matched entries. Recoverable, but a
user who then empties the Trash loses unrelated data.

**Fix:** prefer the **bundle-id** match as the primary signal; treat bare-name matches as
lower-confidence (e.g. only when no bundle id is available, and never for names shorter
than ~4 chars or on a small denylist of generic words). Always surface name-only matches
distinctly in the UI.

---

## MEDIUM

### M1 — Permission errors silently produce zero / missing results
**`main.js:57-65` (`dirSize`), `70-80` (`scanCaches`), `104-126` (`scanLargeFiles`)**

Without Full Disk Access, `du` exits non-zero on unreadable trees → `dirSize` `catch`es and
returns `0`. `scanCaches` then **filters out** anything with `size === 0` (`main.js:79`),
so protected caches simply vanish from the list rather than showing as "unknown / needs
permission". Likewise `find`/`readdir` failures are swallowed. The result is *silently
wrong* (under-reported), which the task explicitly asked to flag. README mentions FDA, but
the UI never tells the user results may be incomplete.

**Fix:** distinguish "0 bytes" from "couldn't read"; surface a banner when scans hit
`EACCES`/`EPERM`, prompting the user to grant Full Disk Access.

### M2 — Login-item toggle doesn't take effect until next login and won't unload running agents
**`main.js:243-257`, `listLoginItems` `131-147`**

Disabling renames `foo.plist` → `foo.plist.disabled`. `launchd` only reads the directory
at load time, so:
- A currently-running agent keeps running until logout/reboot (no `launchctl unload`/`bootout`).
- The canonical disable mechanisms (`launchctl disable`, the plist `Disabled` key) aren't used.
- `.plist.disabled` is a Sweep convention, not a macOS one.

It's reversible and safe, but the UI implies an immediate effect ("Disabled" toast,
`renderer.js:182`). Functionally misleading.

**Fix:** clarify in the UI that changes apply at next login, or actually
`launchctl bootout`/`bootstrap` the agent.

### M3 — `find` parsing breaks on filenames containing newlines
**`main.js:111-122`**

`stdout.split('\n')` (`main.js:116`) splits multi-line filenames into bogus paths; the
subsequent `fsp.stat` fails and the entry is skipped — so a legitimately large file with a
newline in its name is silently dropped, and a fragment path is briefly considered.

**Fix:** use `find … -print0` and split on `\0`.

### M4 — `scan:appLeftovers` / `getBundleId` read an arbitrary caller-supplied path
**`main.js:161-170, 216`**

`appPath` arrives over IPC and is fed to `PlistBuddy Print … <appPath>/Contents/Info.plist`
with no constraint to `/Applications`. In normal flow it comes from `listInstalledApps`,
but a compromised renderer could read any `Info.plist`'s `CFBundleIdentifier` (minor info
disclosure). Low impact, but the input is untrusted.

**Fix:** validate `appPath` matches `/^\/Applications\/[^/]+\.app$/` before use.

---

## LOW

### L1 — `escapeHtml` doesn't escape single quotes
**`renderer.js:60`** — escapes `& < > "` but not `'`. The escaped values are currently
only injected into element *content* (not attribute context), so this isn't exploitable
today, but it's a latent hazard if any of these values are ever placed in a single-quoted
attribute. Filenames are user-controlled (e.g. a downloaded file). Add `'` → `&#39;`.

### L2 — `inactive` memory is computed but unused / "App memory" is approximate
**`main.js:90, 95-96`, `renderer.js:139`** — `inactive` is parsed and returned but the UI
never displays it; it's folded into `cached` via the remainder calc (`main.js:95`).
Also, labelling `active` as "App memory" doesn't match Activity Monitor's definition. Not a
bug, but the breakdown is approximate; worth a comment or a tooltip. *(Page-size regex and
the period-terminated `vm_stat` numbers parse correctly — verified by inspection, not at
runtime.)*

### L3 — Dead / unused API: `open:path` / `openPath`
**`main.js:259`, `preload.js:18`** — exposed but never called from `renderer.js`. Either
wire up a "Reveal in Finder" affordance or drop it to keep the preload surface minimal.

### L4 — `resolved.length < 5` is a fragile heuristic
**`main.js:31`** — it happens to catch `/usr`, `/etc` (len 4) which are also in `FORBIDDEN`,
so it's redundant; and it would wrongly *reject* a legitimate short path if one ever
existed. Harmless today, but prefer explicit checks over a magic length.

### L5 — Renderer assumes `window.sweep` exists
**`renderer.js:1`** — if the preload ever fails to load, `api` is `undefined` and every
handler throws with no user-facing message. A small guard + visible error would help.

### L6 — Hardcoded 50 GB denominator for the dashboard ring
**`renderer.js:236`** — purely cosmetic (the reclaimable ring saturates at 50 GB), worth a
comment so it isn't mistaken for a real cap.

### L7 — Electron `sandbox` not set explicitly
**`main.js:269-273`** — modern Electron defaults `sandbox: true`, and the preload only uses
`require('electron')` (allowed in a sandboxed preload), so this is fine today. Setting it
explicitly documents intent and guards against a future default change.

---

## Things I could not verify at runtime (not on macOS)

- `vm_stat` output format and the `page size of N bytes` line — regex looks correct.
- `du -sk` tab-delimited output — parsing (`split('\t')[0]`) matches BSD `du`.
- `PlistBuddy` path and behaviour on apps with an unusual/missing `Info.plist`.
- `shell.trashItem` behaviour on **symlinks** and on **root-owned `/Applications` bundles**.
  *Note:* `trashItem` operates on the item itself (not the link target), so a symlink that
  lexically passes the home check would trash the *link*, not the protected target — so
  symlink escape is mitigated by the API, not by the guard. Root-owned bundles will likely
  land in the `failed` list (the UI already hints "may need admin", `renderer.js:221`).
- `osascript … "purge" with administrator privileges` (`main.js:238`) — static string, no
  injection; admin prompt behaviour unverified.

---

## Recommended fixes to approve before first run

In priority order:

1. **H1** — Fix the case-insensitive denylist bypass in `assertSafeToRemove` (ideally
   convert to an allowlist of permitted roots). *Highest leverage: it's the safety net.*
2. **H3 + H2** — Make leftover matching bundle-id-first and downgrade bare-name matches;
   show (or cap deletion to) every path the user is about to trash.
3. **M1** — Surface permission/Full-Disk-Access failures instead of silently reporting 0.
4. **M3** — Switch `find` to `-print0` for filename robustness.
5. **M4 / L1** — Validate `appPath` over IPC; escape `'` in `escapeHtml`.

The rest (M2, L2–L7) are quality/clarity improvements that can follow.

---

## Fixes applied (2026-06-02)

All findings above were implemented in a follow-up commit:

| ID | Fix |
|----|-----|
| **H1** | `assertSafeToRemove` rewritten as a fail-closed **allowlist** of scanned roots + `/Applications/*.app`; rejects the roots themselves, system paths, `..` traversal, and wrong-case paths. Verified with a 17-case test. `main.js:11-58` |
| **H2** | Uninstaller now lists **every** path it will trash (modal body already scrolls) and states the full count. `renderer.js` `uninstall()` |
| **H3** | Leftover matching is **bundle-id-first**; bare-name matches are skipped for names < 4 chars or on a generic-name denylist. `main.js` `findAppLeftovers` / `GENERIC_NAMES` |
| **M1** | Added `hasFullDiskAccess()` probe + `scan:access` IPC; cache/large-file scans show an amber **Full Disk Access** banner when results may be incomplete. `main.js`, `preload.js`, `renderer.js`, `styles.css` |
| **M2** | Login-item UI now states changes apply at next login (lead text + toast). `index.html`, `renderer.js` |
| **M3** | `find` switched to `-print0` / NUL split for filenames with newlines. `main.js` `scanLargeFiles` |
| **M4** | `findAppLeftovers` validates `appPath` against `/^\/Applications\/[^/]+\.app$/` before use. `main.js` |
| **L1** | `escapeHtml` now also escapes `'`. `renderer.js` |
| **L2** | Memory breakdown documented as approximate; `inactive` behaviour commented. `main.js` `getMemory` |
| **L3** | Unused `open:path` / `openPath` API removed (preload surface trimmed). `preload.js`, `main.js` |
| **L4** | `resolved.length < 5` heuristic removed (subsumed by the allowlist). `main.js` |
| **L5** | Renderer shows a clear message if the preload bridge fails to load. `renderer.js` |
| **L6** | Dashboard-ring 50 GB reference point documented. `renderer.js` |
| **L7** | `sandbox: true` set explicitly in `webPreferences`. `main.js` |

README's safety section updated to describe the allowlist model.

---

## Second pass — additional improvements (2026-06-03)

A further sweep for bugs and polish:

**Backend correctness**
- **Partial-output recovery (bug):** `du` and `find` exit non-zero the instant they
  touch an unreadable subpath but still print useful partial output. The old code
  `catch`-discarded it, so one permission error inside `~/Documents` dropped *every*
  large file found there, and a partially-readable cache reported `0` (then got
  filtered out). Added `runReadable()`, which returns the command's stdout even on a
  non-zero exit; `dirSize` and `scanLargeFiles` now use it. Verified with a test that a
  command exiting `1` with partial stdout is still parsed correctly.

**Main process**
- Standard macOS application menu (`appMenu`/`editMenu`/`windowMenu` roles) so Cmd+Q,
  Cmd+W, Cmd+M and copy/paste work and the app name shows as "Sweep" (`app.setName`).
- Window uses `show: false` + `ready-to-show` to avoid a flash on launch.

**UX / visual**
- Smart Scan stat cards are now buttons that jump to the matching view; a Full Disk
  Access hint also appears on the dashboard when access is off.
- Confirmation modal: Escape and backdrop-click cancel; the **Cancel** button is focused
  by default so a stray Enter/Space can't trigger a destructive action.
- Scan buttons are disabled while a scan is in flight (`busy()` wrapper) to prevent
  overlapping runs from double-clicks.
- Login-item toggles gained `aria-label` / `aria-pressed` / tooltips and are disabled
  during the toggle round-trip.
- Dark-themed scrollbars, a `prefers-reduced-motion` guard, and hover/active states on
  the dashboard cards.

---

## Third pass — remaining items (2026-06-03)

- **Login items now take effect immediately.** The toggle still renames the plist (the
  durable, reversible mechanism that controls load at next login), but it now also runs
  `launchctl load`/`unload` so the change applies right away. That call is best-effort
  (`runReadable` swallows its errors), so it can't break the safe rename. UI copy and the
  toast updated accordingly. *(launchctl behaviour unverified — not on macOS.)*
- **Row-click selection** in the caches/large-file lists — clicking anywhere on a row
  toggles its checkbox (with a pointer cursor and hover state), not just the tiny box.
- **Accessibility:** modal marked `role="dialog"` / `aria-modal` / `aria-labelledby`;
  toast marked `role="status"` / `aria-live="polite"`; modal restores focus to the
  triggering element on close.

### Intentionally left as-is (evaluated, not bugs)
- **Trash size vs. Empty Trash scope:** `getTrashSize` measures `~/.Trash`, while macOS's
  "Empty Trash" also clears per-volume `.Trashes` on external drives. For the common
  single-volume case these match; multi-volume trash scanning would read other (possibly
  network) volumes for little benefit, so it was left out.
- **`find` depth:** no `-maxdepth` cap was added — a limit would silently miss legitimately
  deep large files, which is worse than the current (already result-capped) full walk.

---

## Fourth pass — testability refactor + real tests (2026-06-06)

The earlier passes referenced test harnesses that were never committed and there was no
`npm test`. This pass makes the testing real, **without changing app behavior**.

**Refactor (behavior-preserving):** the pure, environment-free logic was lifted out of
`main.js` into small importable modules. Anything needing Electron/`fs` stays in `main.js`,
which now imports from these:

| Module | Exports | Was |
|--------|---------|-----|
| `lib/safety.js` | `assertSafeToRemove`, `isStrictlyInside`, `ALLOWED_ROOTS`, `APP_BUNDLE_RE`, `HOME` | inline SAFETY GUARDS block |
| `lib/parse.js` | `parseDuKb`, `splitNul`, `parseVmStat` | inline parsing in `dirSize`, `getMemory`, and the four `find … -print0` callers |
| `lib/match.js` | `leftoverMatches`, `GENERIC_NAMES` | the `matches()` closure + `GENERIC_NAMES` inside `findAppLeftovers` |
| `lib/format.js` | `fmtBytes` (UMD: `require()` in Node, `window.SweepFormat` in the renderer) | a private copy in `renderer.js` |

`renderer.js` now consumes the shared `fmtBytes` (one source of truth) via a new
`<script src="lib/format.js">` tag added before `renderer.js` in `index.html`. The function
body is byte-for-byte the same, so rendered output is unchanged. The CSP (`script-src 'self'`)
already permits the local script.

**Tests** (`test/*.test.js`, run with Node's built-in `node:test`/`node:assert`, no new deps):
- `safety.test.js` (9 cases): accepts paths strictly inside every `ALLOWED_ROOT` and a
  single `/Applications/*.app`; rejects each root itself, `/`, `HOME`, `/System`, `/Library`,
  `..`-traversal that escapes, wrong-case variants, empty/non-string input, and
  `/Applications` paths that aren't a lone `*.app`.
- `parse.test.js`: `parseDuKb` (incl. unparseable→0), `splitNul` (incl. a filename
  containing a newline staying intact), and `parseVmStat` against a captured sample
  (page-size parsing, per-field bytes, default-page fallback, cached-clamp-to-0).
- `match.test.js`: bundle-id match (incl. winning over a generic name), exact/prefixed
  name match, rejection of generic names, names < 4 chars, and unrelated/substring names.
- `format.test.js`: `fmtBytes` edge cases (0, <1, negatives/NaN/undefined, sub-KB no-decimal,
  exact KB/MB/GB/TB boundaries, one-decimal rounding).

`"test": "node --test"` added to `package.json`. **All 25 tests pass locally** (run on this
machine, so `lib/safety` and `lib/format` ran for real; macOS-only *commands* like `vm_stat`
are still tested via captured-string parsing, not by spawning them).

**CI:** `.github/workflows/test.yml` runs `npm ci && npm test` on `macos-latest` and
`ubuntu-latest` for pushes to `main` and all PRs.

*Could not verify at runtime (not exercised here):* the Electron app still launching and the
renderer picking up `window.SweepFormat` — this needs a macOS GUI session. The change is a
mechanical extract-and-reuse with an identical `fmtBytes` body and an added local
`<script>` tag, so the risk is low, but the live renderer load was not run.

---

## Fifth pass — modularize main.js and renderer.js (2026-06-06)

Both source files had grown into single large files. This pass splits each along the
boundaries laid out in the task, with **no behavior change** — same IPC channels, same
preload surface, same UI, same safety invariants. The split is purely structural.

**Main process** — `main.js` now owns only the Electron app/window/menu lifecycle, the
`moveToTrash`/`trashMany` trash chokepoint, and the IPC registrations, which delegate to:

| Module | Exports | Imports |
|--------|---------|---------|
| `lib/exec.js` | `run`, `runReadable`, `mapLimit`, `dirSize`, `HOME`, `LIB` | `lib/parse` (`parseDuKb`) |
| `scanners/systemJunk.js` | `scanSystemJunk` (+ all the curated rules/helpers) | `lib/exec`, `lib/parse` |
| `scanners/largeFiles.js` | `scanLargeFiles` | `lib/exec`, `lib/parse` |
| `scanners/memory.js` | `getMemory` | `lib/exec`, `lib/parse` |
| `scanners/loginItems.js` | `listLoginItems`, `toggleLoginItem` | `lib/exec`, `lib/safety` |
| `scanners/apps.js` | `listInstalledApps`, `findAppLeftovers` | `lib/exec`, `lib/safety`, `lib/match` |
| `scanners/access.js` | `hasFullDiskAccess` | `lib/exec` |

`lib/exec.js` is now the **only** module that touches `child_process`, so the "binary +
arg array, never a shell" invariant lives in one place. The two destructive handlers that
accept a path still validate in the main process: `toggle:loginItem` re-checks
`isStrictlyInside(LaunchAgents, …)` + `assertSafeToRemove` inside `scanners/loginItems.js`,
and `scan:appLeftovers` re-checks `APP_BUNDLE_RE` inside `scanners/apps.js` — both run in
the main process (these modules are `require`d by `main.js`, not the preload). The trivial
`scan:trash` / `scan:downloads` size queries stay inline in `main.js` as one-liners over
`dirSize`. `assertSafeToRemove` remains the single guard every trash path passes through.

**Renderer** — `renderer.js` is now an ES-module entry (`<script type="module">`) that
checks the preload bridge, wires the sidebar nav, and calls each view's `init*()`:

| Module | Role |
|--------|------|
| `ui/api.js` | the `window.sweep` bridge |
| `ui/dom.js` | `$`, `el`, `fmtBytes`, `escapeHtml`, `toast`, `busy`, `confirmModal`, `showView` |
| `ui/list.js` | `buildSelectableList`, `wireSelection`, `maybeWarnAccess` |
| `views/{dashboard,systemJunk,largeFiles,trash,memory,loginItems,uninstaller}.js` | one per view |

The `fmtBytes` source of truth is unchanged: `lib/format.js` stays a classic `<script>`
that runs during parse (setting `window.SweepFormat`) before the deferred renderer module
reads it. **CSP unchanged** (`script-src 'self'`): module scripts and their relative
imports are all same-origin.

**Verified at runtime on macOS (this pass *was* run on a Mac):**
- `npm test` — 25/25 pass, before and after.
- A probe confirmed Electron 31 loads `<script type="module">` and relative `import`s over
  `file://` under `script-src 'self'` (the usual file:// module CORS gotcha does **not**
  bite here with `loadFile`).
- A headless harness loaded the **real** `index.html` + `preload.js` with the real
  read-only scanners wired and **every destructive channel stubbed** (nothing was trashed),
  then drove the UI: the preload bridge and `window.SweepFormat.fmtBytes` resolve; all
  seven nav views activate; Smart Scan completes (hero total `14.8 GB`, 4 stat cards, 100
  system-junk rows, large-files list built); Login Items lists 5 agents; Uninstaller lists
  23 apps; the memory bar renders 5 segments; and "select all" in System Junk reports
  `14.8 GB selected` and enables the clean button. **No renderer console errors.**

*Not exercised:* the actual destructive paths (trash/empty/purge/login-toggle) were stubbed
during verification to avoid moving real files — their code is byte-for-byte the pre-split
logic, just relocated, and `assertSafeToRemove` is still covered by the unit tests.

---

## Sixth pass — app icon + DMG presentation (2026-06-07)

**Task P3.** The packaged app used the default Electron icon and an unstyled DMG. This pass
adds a branded icon and a laid-out DMG. **No runtime/app code changed** — purely packaging
resources plus `package.json` `build` config, so none of the safety invariants are touched
(no new commands, no IPC, no filesystem paths; `main.js`/`preload.js`/scanners untouched).

**What I did**
- **`build/make-icon.js`** — a dependency-free Node generator (no `sharp`/`canvas`/
  ImageMagick/`iconutil` available here, since I'm off-Mac). It renders the mark
  analytically: a mint→teal **145° gradient rounded square** holding a dark **"S"** on the
  dark app base, using the exact `styles.css` `:root` colours (`--mint #3dd7a8`,
  `--mint-dim #1f8a6a`, base `#0d1117`, ink `#04241a`) — i.e. the in-app `.brand-mark`
  enlarged. The "S" is drawn as two stroked circular arcs (rounded caps via endpoint
  distance), so no font is needed. It supersamples a 2048² master, box-downsamples to every
  size, and writes `icon.png` (1024²), `icon.iconset/` (10 Apple PNGs), `icon.icns`, and
  `dmg-background.png` (+`@2x`).
- **`build/icon.icns`** — assembled directly in Node as a PNG-backed ICNS (`icp4/5/6`,
  `ic07–ic14`). Validated by parsing it back: magic + declared length match, all 11 chunks
  are valid PNGs at the expected dimensions.
- **`package.json`** — wired `build.mac.icon` → `build/icon.icns`, and added `build.dmg`
  (window 540×380, `iconSize` 96, app at `(150,200)` + `/Applications` link at `(390,200)`,
  `background: build/dmg-background.png`). The background draws a soft mint glow under each
  icon slot and a guide arrow aligned to those coordinates.
- **`.gitignore`** — `build/` was previously fully ignored; switched to committing the
  packaging resources while still ignoring `dist/`, `out/`, and the regenerable
  `build/icon.iconset/`.
- **`build/README.md`** — documents the brand spec, the `node build/make-icon.js`
  regeneration, the off-Mac ICNS assembly, and the canonical `iconutil`/`sips` Mac route.
- Updated the main `README.md` build section.

**Verified (off-Mac, Linux)**
- `npx electron-builder --mac --dir` loads the `build` config and packages `Sweep.app`
  with **`icon.icns` embedded** in `Contents/Resources/` and `CFBundleIconFile=icon.icns`
  in `Info.plist` (the only skipped step is macOS-only code signing). So the
  electron-builder config is valid and the icon is picked up.
- The 1024² master was rendered and eyeballed — the "S" reads cleanly and the gradient/
  rounded-square/base match the in-app brand.
- `icon.icns` structure validated chunk-by-chunk.

**macOS-runtime assumptions I could NOT verify (not on a Mac)**
- **The actual `.dmg`** can't be produced off-Mac — electron-builder shells out to
  `hdiutil`/HFS tooling that only exists on macOS. I validated the DMG *config* and the
  background image, but the rendered DMG window (icon placement vs. the background, arrow
  alignment, exact title-bar offset) needs a Mac to confirm; the `(x,y)` may want a few px
  of nudging once seen in Finder.
- **Icon appearance in Finder/Dock** at each size, and the `iconutil` route, were not run
  on a real Mac. The off-Mac `.icns` is a structurally valid PNG-backed container that
  macOS reads natively, but its on-screen rendering wasn't visually confirmed there.
