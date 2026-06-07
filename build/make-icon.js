#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Sweep — app icon + DMG asset generator (zero dependencies)
//
// Renders the brand mark analytically (no fonts, no native image libs) and
// writes:
//   build/icon.png            1024x1024 master
//   build/icon.iconset/*.png  the Apple iconset (for the iconutil route)
//   build/icon.icns           a valid PNG-backed .icns (for `npm run dist`)
//   build/dmg-background.png   the DMG window backdrop (+ @2x)
//
// The mark mirrors the in-app brand tile (styles.css .brand-mark): a
// mint -> teal gradient rounded square holding a dark "S", sitting on the
// dark app base. Colours are pulled straight from styles.css :root.
//
// Run:  node build/make-icon.js
//
// This is the off-Mac path (it runs anywhere Node does). The canonical Mac
// route using `iconutil` is documented in build/README.md and produces an
// equivalent .icns from build/icon.iconset.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = __dirname;

// --- brand palette (from styles.css :root) --------------------------------
const MINT = hex('#3dd7a8');      // --mint
const MINT_DIM = hex('#1f8a6a');  // --mint-dim
const BASE_TOP = hex('#0d1117');  // --bg
const BASE_BOT = hex('#070b0f');  // a touch darker for depth
const INK = hex('#04241a');       // the dark "S", same as .brand-mark colour

function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c0, c1, t) {
  return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Signed distance to an axis-aligned rounded rectangle centred at origin.
function sdRoundRect(px, py, halfW, halfH, rad) {
  const qx = Math.abs(px) - halfW + rad;
  const qy = Math.abs(py) - halfH + rad;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - rad;
}

// Signed distance from a point to a circular arc centreline.
// center, radius, start angle (rad) and signed sweep (rad). Outside the arc's
// angular span the nearest point is an endpoint (this gives rounded caps once
// the stroke half-thickness is subtracted).
function sdArc(px, py, cx, cy, R, start, sweep) {
  const vx = px - cx, vy = py - cy;
  const d = Math.hypot(vx, vy);
  let ang = Math.atan2(vy, vx);
  const TWO = Math.PI * 2;
  let t; // distance travelled along the sweep, [0, |sweep|] when in range
  if (sweep >= 0) {
    t = ((ang - start) % TWO + TWO) % TWO;
    if (t <= sweep) return Math.abs(d - R);
  } else {
    t = ((start - ang) % TWO + TWO) % TWO;
    if (t <= -sweep) return Math.abs(d - R);
  }
  // nearest endpoint
  const e0x = cx + R * Math.cos(start), e0y = cy + R * Math.sin(start);
  const a1 = start + sweep;
  const e1x = cx + R * Math.cos(a1), e1y = cy + R * Math.sin(a1);
  return Math.min(Math.hypot(px - e0x, py - e0y), Math.hypot(px - e1x, py - e1y));
}

// Distance to the "S" centreline = union (min) of an upper and a lower arc.
// The arcs are built in a unit frame (origin at the S waist, y up) then the
// caller scales/places them. r is the bowl radius.
function sdS(px, py, cx, cy, r) {
  // work in math coords (y up) relative to the waist
  const x = px - cx;
  const y = cy - py; // flip to y-up
  const D = Math.PI / 180;
  // upper bowl: centre (0, r), terminal at top-right, ends at the waist
  const up = sdArc(x, y, 0, r, r, 20 * D, 250 * D);
  // lower bowl: centre (0,-r), starts at the waist, terminal at lower-left
  const lo = sdArc(x, y, 0, -r, r, 90 * D, -240 * D);
  return Math.min(up, lo);
}

// Coverage from a signed distance (negative = inside), antialiased over ~aa px.
function cov(sd, aa) { return clamp01(0.5 - sd / aa); }

// Composite straight-alpha src over dst (both [r,g,b,a], a in 0..1).
function over(dst, sr, sg, sb, sa) {
  const oa = sa + dst[3] * (1 - sa);
  if (oa <= 0) { dst[0] = dst[1] = dst[2] = dst[3] = 0; return; }
  dst[0] = (sr * sa + dst[0] * dst[3] * (1 - sa)) / oa;
  dst[1] = (sg * sa + dst[1] * dst[3] * (1 - sa)) / oa;
  dst[2] = (sb * sa + dst[2] * dst[3] * (1 - sa)) / oa;
  dst[3] = oa;
}

// --- render the master at MS x MS (supersampled) --------------------------
function renderMaster(MS) {
  const buf = Buffer.alloc(MS * MS * 4);
  const S = MS;                 // canvas side
  const aa = MS / 1024 * 1.4;   // AA width scales with supersample
  // dark base: full-bleed rounded square at ~80% with an Apple-ish corner
  const baseHalf = 0.80 * S / 2;
  const baseRad = 0.225 * (0.80 * S);
  const cx = S / 2, cy = S / 2;
  // gradient tile (the brand square) inside the base
  const tileSide = 0.62 * S;
  const tileHalf = tileSide / 2;
  const tileRad = 0.28 * tileSide;
  // the "S": bowl radius and stroke from the tile size
  const thk = 0.165 * tileSide;
  const r = (0.66 * tileSide - thk) / 4;
  const half = thk / 2;
  // 145deg gradient direction (CSS): screen-space y-down
  const a = 145 * Math.PI / 180;
  const gdx = Math.sin(a), gdy = -Math.cos(a);
  const gLen = tileSide * (Math.abs(gdx) + Math.abs(gdy)) / 2;

  const px4 = new Array(4);
  for (let yy = 0; yy < S; yy++) {
    for (let xx = 0; xx < S; xx++) {
      const x = xx + 0.5, y = yy + 0.5;
      const dx = x - cx, dy = y - cy;
      px4[0] = px4[1] = px4[2] = px4[3] = 0;

      // base
      const baseCov = cov(sdRoundRect(dx, dy, baseHalf, baseHalf, baseRad), aa);
      if (baseCov > 0) {
        const bt = clamp01(y / S);
        const bc = mix(BASE_TOP, BASE_BOT, bt);
        over(px4, bc[0], bc[1], bc[2], baseCov);
      }

      // gradient tile
      const tileCov = cov(sdRoundRect(dx, dy, tileHalf, tileHalf, tileRad), aa);
      if (tileCov > 0) {
        const t = clamp01(((dx) * gdx + (dy) * gdy) / (2 * gLen) + 0.5);
        const tc = mix(MINT, MINT_DIM, t);
        over(px4, tc[0], tc[1], tc[2], tileCov);

        // the dark "S" — clamped to the tile so it never spills onto the base
        const sd = sdS(x, y, cx, cy, r) - half;
        const sCov = cov(sd, aa) * tileCov;
        if (sCov > 0) over(px4, INK[0], INK[1], INK[2], sCov);
      }

      const o = (yy * S + xx) * 4;
      buf[o] = Math.round(px4[0]);
      buf[o + 1] = Math.round(px4[1]);
      buf[o + 2] = Math.round(px4[2]);
      buf[o + 3] = Math.round(px4[3] * 255);
    }
  }
  return { buf, size: S };
}

// Box-downsample an RGBA master by an integer factor (premultiplied, correct).
function downsample(master, factor) {
  const S = master.size, src = master.buf;
  const D = S / factor;
  const out = Buffer.alloc(D * D * 4);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const o = (((y * factor + j) * S) + (x * factor + i)) * 4;
          const a = src[o + 3] / 255;
          pr += src[o] * a; pg += src[o + 1] * a; pb += src[o + 2] * a; pa += a;
        }
      }
      const aSum = pa * inv;
      const o = (y * D + x) * 4;
      if (pa > 0) {
        out[o] = Math.round(pr / pa);
        out[o + 1] = Math.round(pg / pa);
        out[o + 2] = Math.round(pb / pa);
      }
      out[o + 3] = Math.round(aSum * 255);
    }
  }
  return { buf: out, size: D };
}

// --- minimal PNG encoder (RGBA, 8-bit, colour type 6) ---------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(img) {
  const { buf, size } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines, filter byte 0 per row
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICNS assembly (PNG-backed OSTypes) -----------------------------------
// Maps each pixel size to the modern PNG-capable OSType(s). macOS reads PNG
// payloads for all of these. We cover both the 1x and @2x slots.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];
function buildICNS(pngBySize) {
  const parts = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = pngBySize[size];
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    parts.push(header, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// --- DMG background --------------------------------------------------------
// Dark gradient backdrop with a faint mint arrow guiding app -> Applications.
// Window is 540x380; icons are centred at y=180 (see package.json build.dmg).
function renderDmgBackground(W, H, scale) {
  const w = W * scale, h = H * scale;
  const buf = Buffer.alloc(w * h * 4);
  // Icon-slot centres mirror package.json build.dmg.contents (x,y).
  const appX = 150 * scale, dropX = 390 * scale, iconY = 200 * scale;
  const ar0 = 215 * scale, ar1 = 325 * scale, aw = 5 * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let c = mix(hex('#10171f'), hex('#0a0e13'), t); // subtle vertical fade
      // soft mint glow pooled under each icon slot
      const g1 = glow(x, y, appX, iconY, 120 * scale);
      const g2 = glow(x, y, dropX, iconY, 120 * scale);
      const g = Math.min(0.5, g1 + g2);
      c = mix(c, MINT, g * 0.12);
      // a thin arrow from the app toward the /Applications drop target
      const onShaft = y > iconY - aw && y < iconY + aw && x > ar0 && x < ar1 - 22 * scale;
      const head = arrowHead(x, y, ar1, iconY, 26 * scale, 16 * scale);
      const aA = (onShaft || head) ? 0.55 : 0;
      if (aA > 0) c = mix(c, MINT, aA);
      const o = (y * w + x) * 4;
      buf[o] = Math.round(c[0]); buf[o + 1] = Math.round(c[1]);
      buf[o + 2] = Math.round(c[2]); buf[o + 3] = 255;
    }
  }
  return { buf, size: w, _w: w, _h: h };
}
function glow(x, y, cx, cy, rad) {
  const d = Math.hypot(x - cx, y - cy);
  return clamp01(1 - d / rad);
}
function arrowHead(x, y, tipX, tipY, len, halfH) {
  const dx = tipX - x;
  if (dx < 0 || dx > len) return false;
  const span = halfH * (dx / len);
  return Math.abs(y - tipY) < span;
}

// encodePNG assumes square; generalise for the DMG background (non-square)
function encodePNGRect(buf, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drive it --------------------------------------------------------------
function main() {
  const MS = 2048; // 2x supersample of the 1024 master
  console.log(`Rendering ${MS}x${MS} master…`);
  const master = renderMaster(MS);

  const sizes = [1024, 512, 256, 128, 64, 32, 16];
  const imgBySize = {};
  const pngBySize = {};
  for (const s of sizes) {
    imgBySize[s] = downsample(master, MS / s);
    pngBySize[s] = encodePNG(imgBySize[s]);
  }

  // master png
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngBySize[1024]);
  console.log('  wrote icon.png');

  // iconset (Apple naming) for the iconutil route
  const isetDir = path.join(OUT, 'icon.iconset');
  fs.mkdirSync(isetDir, { recursive: true });
  const iset = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, s] of iset) fs.writeFileSync(path.join(isetDir, name), pngBySize[s]);
  console.log('  wrote icon.iconset/ (10 pngs)');

  // icns
  fs.writeFileSync(path.join(OUT, 'icon.icns'), buildICNS(pngBySize));
  console.log('  wrote icon.icns');

  // dmg background (+ @2x)
  const bg1 = renderDmgBackground(540, 380, 1);
  const bg2 = renderDmgBackground(540, 380, 2);
  fs.writeFileSync(path.join(OUT, 'dmg-background.png'), encodePNGRect(bg1.buf, bg1._w, bg1._h));
  fs.writeFileSync(path.join(OUT, 'dmg-background@2x.png'), encodePNGRect(bg2.buf, bg2._w, bg2._h));
  console.log('  wrote dmg-background.png (+@2x)');

  console.log('Done.');
}

main();
