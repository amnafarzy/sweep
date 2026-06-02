# Sweep

A free, open Mac cleanup utility — the core of what CleanMyMac does, with a clean dark UI and no subscription.

## What it does

- **Smart Scan** — one click, scans every category and shows total reclaimable space
- **System Junk** — finds app caches (`~/Library/Caches`) and moves selected ones to Trash
- **Large Files** — scans Downloads / Desktop / Documents / Movies / Music / Pictures for files over a size threshold
- **Trash & Downloads** — shows sizes, empties the Trash, opens Downloads
- **Free Up RAM** — live memory pressure breakdown + `purge` (asks for your admin password)
- **Login Items** — lists user launch agents and lets you toggle them on/off (reversible)
- **Uninstaller** — removes an app *and* its leftover support files together (AppCleaner-style)

## Safety

This is the part most "cleaner" apps get wrong, so Sweep is conservative by design:

- **Everything is recoverable.** Caches, large files, and uninstalled apps are *moved to the Trash*, not permanently deleted. You can restore anything until you empty the Trash.
- **Scan first, clean second.** Nothing is touched until you review the list and confirm.
- **Hard path guards (allowlist).** The main process will only trash a path that sits *inside* one of the specific folders Sweep scans (e.g. `~/Library/Caches`, `~/Downloads`, `~/Library/LaunchAgents`) — never one of those folders itself, and never a system path — no matter what the UI sends. The only path allowed outside your home folder is a single `/Applications/Name.app` bundle (for uninstalls). Anything unrecognized is refused (fail-closed), which also avoids case-sensitivity tricks on macOS's case-insensitive filesystem.
- **No telemetry, no network calls, no bundled scanners.**

## Run it

You need [Node.js](https://nodejs.org) (v18+) installed.

```bash
cd sweep
npm install
npm start
```

That launches the app in development mode.

## Build a real .app / .dmg (optional)

```bash
npm run dist
```

The packaged app appears in `dist/`. On first launch, macOS Gatekeeper may warn it's from an unidentified developer — right-click the app → Open to bypass (it's unsigned because it's your own local build).

## Permissions

- **Full Disk Access** (recommended): System Settings → Privacy & Security → Full Disk Access → add the app (or your terminal, in dev mode). Without it, some caches and large files won't be visible.
- **Purge RAM** prompts for your admin password each time — it runs the system `purge` command via `osascript`.

## Notes

- Tested logic against macOS paths; the destructive operations all route through `assertSafeToRemove()` in `main.js`.
- Want a feature CleanMyMac has that's missing? The code is small and readable — `main.js` is all the system logic, `renderer.js` is all the UI behavior.

MIT licensed. Do whatever you want with it.
