# Packaging resources

These are the assets electron-builder consumes when you run `npm run dist`
(see the `build` field in `package.json`). They are committed so a clean
checkout can build a properly-branded `.app`/`.dmg` without any extra tooling.

| File | Purpose | Wired via |
|------|---------|-----------|
| `icon.icns` | macOS app icon | `build.mac.icon` + `build.dmg.icon` |
| `dmg-background.png` (+`@2x`) | DMG window backdrop | `build.dmg.background` |
| `icon.png` | 1024×1024 master (source of truth, also handy for docs/stores) | — |
| `make-icon.js` | regenerates everything below from the brand spec | — |
| `icon.iconset/` | Apple iconset (intermediate for the `iconutil` route) | gitignored; regenerable |

## The brand mark

The icon mirrors the in-app brand tile (`styles.css` `.brand-mark`): a
**mint → teal gradient rounded square holding a dark "S"**, sitting on the dark
app base. Colours come straight from `styles.css` `:root`:

- `--mint` `#3dd7a8` → `--mint-dim` `#1f8a6a` (145° gradient, same as the tile)
- base `--bg` `#0d1117` (fading a touch darker for depth)
- the "S" is `#04241a` — the exact ink colour `.brand-mark` uses

## Regenerating the assets

The generator is dependency-free (pure Node — no `sharp`, `canvas`, or
ImageMagick) so it runs anywhere, including off-Mac / in CI:

```bash
node build/make-icon.js
```

It renders a 2048×2048 supersampled master analytically (the "S" is drawn as
two stroked circular arcs — no font needed), box-downsamples to every required
size, and writes:

- `icon.png` — 1024×1024 master
- `icon.iconset/` — the 10 Apple-named PNGs (16…512, each + `@2x`)
- `icon.icns` — a valid PNG-backed `.icns` (assembled directly, see below)
- `dmg-background.png` and `dmg-background@2x.png`

### How `icon.icns` is built here (off-Mac)

`make-icon.js` writes the `.icns` container itself: the `icns` magic + total
length, then one chunk per OSType (`icp4/5/6`, `ic07–ic14`) whose payload is the
matching-size PNG. macOS reads PNG-backed `.icns` payloads natively, so this is
a valid icon file on any platform. You can sanity-check the structure with:

```bash
node -e 'const b=require("fs").readFileSync("build/icon.icns");
let o=8;while(o<b.length){const t=b.toString("ascii",o,o+4),l=b.readUInt32BE(o+4);
const d=b.slice(o+8,o+l);const w=d.readUInt32BE(16),h=d.readUInt32BE(20);
console.log(t,`${w}x${h}`);o+=l;}'
```

### The canonical Mac route (`iconutil`)

On a Mac you can rebuild `icon.icns` from the iconset with Apple's own tool —
this is the reference path and produces an equivalent file:

```bash
# regenerate the iconset first (or use any 1024² source rendered to icon.iconset)
node build/make-icon.js
iconutil -c icns build/icon.iconset -o build/icon.icns
```

If you'd rather start from a single PNG, `sips` can produce each iconset size:

```bash
mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s   $s   build/icon.png --out build/icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns build/icon.iconset -o build/icon.icns
```

## DMG presentation

`build.dmg` in `package.json` sets the Finder window to 540×380, a 96 px icon
size, and a side-by-side layout: the app at `(150, 200)` and the
`/Applications` drop-target at `(390, 200)`. `dmg-background.png` is sized to
the window (540×380, with an `@2x` at 1080×760) and draws a soft mint glow
pooled under each icon slot plus a mint arrow guiding app → Applications, so the
two slots line up with the artwork.

## Verified vs. needs-a-Mac

- **Verified off-Mac (Linux):** `npx electron-builder --mac --dir` loads the
  `build` config, packages `Sweep.app`, and embeds `icon.icns` into
  `Contents/Resources/` with `CFBundleIconFile=icon.icns` in `Info.plist`
  (only the macOS-only code-signing step is skipped). The `.icns` was parsed
  back and every chunk is a valid PNG at the expected size.
- **Needs a Mac to produce:** the actual `.dmg` (electron-builder shells out to
  `hdiutil`/`hfsplus` tooling that only exists on macOS), and the visual
  rendering of the icon in Finder/the Dock. The `iconutil` route above also
  requires macOS. The off-Mac `.icns` is structurally valid but its appearance
  in the macOS UI was not visually confirmed on a real Mac.
