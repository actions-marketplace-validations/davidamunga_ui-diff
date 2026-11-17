#!/usr/bin/env node
// Compare a design export (e.g. a Figma frame PNG) with a screenshot of the implementation.
//
// Usage:
//   node compare.cjs --design design.png --actual head.png --out .ui-diff/report/design \
//     [--name pricing__desktop] [--figma <frame url>] [--label "/pricing — desktop"] \
//     [--threshold 0.3] [--width <px>] [--fit crop|pad] [--min-cell 23] [--max-regions 6]
//
// Both images are scaled to the same width (default: the narrower one, so nothing is
// upscaled), then cropped to the shorter height (--fit crop, default) or padded with white
// to the taller one (--fit pad). A design and a real render never match pixel for pixel
// (fonts, antialiasing, real data), so the threshold is lenient and scattered noise is
// ignored; what's left are the areas most worth a human look, not verdicts.
//
// Writes into --out:
//   <name>__composite.png                    design | implementation | diff, regions boxed
//   zoom/<name>__r<i>__{design,actual,diff}.png
//   <name>.json                              result (read by comment.cjs from <report>/design/)
const fs = require('fs');
const path = require('path');
const { need, args, readPng, writePng, blank, padTo, crop, findRegions } = require('./lib.cjs');
const { PNG } = need('pngjs');
const pixelmatch = need('pixelmatch');

const GRID = 24;

// Transparent areas of a design export would otherwise compare as black.
function flatten(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a === 1) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * a + 255 * (1 - a));
    d[i + 3] = 255;
  }
  return img;
}

// Bilinear resize. Big downscales go through repeated halving first (each halving is an
// exact 2×2 average), so a @2x/@3x export doesn't alias.
function resize(src, w, h) {
  while (src.width >= w * 2 && src.height >= h * 2) src = resize1(src, Math.ceil(src.width / 2), Math.ceil(src.height / 2));
  return src.width === w && src.height === h ? src : resize1(src, w, h);
}
function resize1(src, w, h) {
  const out = new PNG({ width: w, height: h });
  const sx = src.width / w, sy = src.height / h, S = src.data, D = out.data;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(Math.floor(fy), src.height - 1), y1 = Math.min(y0 + 1, src.height - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(Math.floor(fx), src.width - 1), x1 = Math.min(x0 + 1, src.width - 1), tx = fx - x0;
      const a = (y0 * src.width + x0) * 4, b = (y0 * src.width + x1) * 4;
      const c = (y1 * src.width + x0) * 4, d = (y1 * src.width + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = S[a + k] + (S[b + k] - S[a + k]) * tx;
        const bot = S[c + k] + (S[d + k] - S[c + k]) * tx;
        D[o + k] = Math.round(top + (bot - top) * ty);
      }
    }
  }
  return out;
}

// --- drawing for the composite: rectangles and a 5×7 bitmap font (just what we need) ---
const FONT = {
  A: '01110100011000111111100011000110001', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', I: '11111001000010000100001000010011111',
  L: '10000100001000010000100001000011111', M: '10001110111010110101100011000110001',
  N: '10001110011010110011100011000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110',
  2: '01110100010000100010001000100011111', 3: '11110000010000101110000010000111110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000',
  8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
};
function fill(img, x, y, w, h, [r, g, b]) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
}
function stroke(img, x, y, w, h, t, color) {
  fill(img, x, y, w, t, color); fill(img, x, y + h - t, w, t, color);
  fill(img, x, y, t, h, color); fill(img, x + w - t, y, t, h, color);
}
function text(img, str, x, y, s, color) {
  for (const ch of str) {
    const g = FONT[ch];
    if (g) for (let i = 0; i < 35; i++) if (g[i] === '1') fill(img, x + (i % 5) * s, y + Math.floor(i / 5) * s, s, s, color);
    x += 6 * s;
  }
}
const textWidth = (str, s) => str.length * 6 * s - s;

// design | implementation | diff, with a label bar on top and numbered region boxes on each panel.
function composite(panels, regions) {
  const { width: w, height: h } = panels[0][1];
  const s = Math.max(2, Math.round(w / 220)); // label pixel size, readable when the image is shrunk
  const gutter = Math.max(12, 2 * s), bar = 11 * s, t = Math.max(2, Math.round(w / 480));
  const out = blank(3 * w + 2 * gutter, bar + h);
  fill(out, 0, 0, out.width, out.height, [209, 213, 219]);
  const BOX = [217, 70, 239];
  panels.forEach(([label, img], p) => {
    const x0 = p * (w + gutter);
    fill(out, x0, 0, w, bar, [243, 244, 246]);
    text(out, label, x0 + Math.round((w - textWidth(label, s)) / 2), 2 * s, s, [31, 41, 55]);
    PNG.bitblt(img, out, 0, 0, w, h, x0, bar);
    regions.forEach((r, i) => {
      stroke(out, x0 + r.x, bar + r.y, r.width, r.height, t, BOX);
      // Number tab sits just outside the box (above, else below) so it doesn't hide what changed.
      const n = String(i + 1), ns = Math.max(2, Math.round(s * 0.6)), tw = textWidth(n, ns) + 2 * ns, th = 9 * ns;
      const ty = r.y >= th ? r.y - th : Math.min(r.y + r.height, h - th);
      fill(out, x0 + r.x, bar + ty, tw, th, BOX);
      text(out, n, x0 + r.x + ns, bar + ty + ns, ns, [255, 255, 255]);
    });
  });
  return out;
}

// Frames are usually drawn at 1×/2×/3× the viewport; anything else suggests the wrong frame.
const plausibleRatio = (r) => [1 / 3, 1 / 2, 1, 2, 3, 4].some((k) => Math.abs(r / k - 1) < 0.03);

function main() {
  const a = args();
  if (!a.design || !a.actual || !a.out) {
    console.error('Required: --design <png> --actual <png> --out <dir>');
    process.exit(1);
  }
  const name = a.name || path.basename(a.actual).replace(/\.png$/i, '');
  const threshold = Number(a.threshold ?? 0.3);
  const fit = a.fit === 'pad' ? 'pad' : 'crop';
  const design0 = flatten(readPng(a.design));
  const actual0 = flatten(readPng(a.actual));
  const notes = [];

  const w = Number(a.width) || Math.min(design0.width, actual0.width);
  const scaled = (img) => resize(img, w, Math.max(1, Math.round((img.height * w) / img.width)));
  const d1 = scaled(design0);
  const a1 = scaled(actual0);
  const ratio = design0.width / actual0.width;
  if (!plausibleRatio(ratio)) {
    notes.push(`Design is ${design0.width}px wide and the screenshot ${actual0.width}px (ratio ${ratio.toFixed(2)}): is this the frame for this viewport?`);
  }
  const h = fit === 'pad' ? Math.max(d1.height, a1.height) : Math.min(d1.height, a1.height);
  if (Math.abs(d1.height - a1.height) > 0.02 * Math.max(d1.height, a1.height)) {
    notes.push(
      `At ${w}px wide the design is ${d1.height}px tall and the implementation ${a1.height}px; ` +
        (fit === 'crop' ? `only the top ${h}px were compared.` : 'the shorter one was padded with white (anything drawn there shows as change).'),
    );
  }
  const design = padTo(d1, w, h);
  const actual = padTo(a1, w, h);

  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(design.data, actual.data, diff.data, w, h, { threshold, includeAA: false, alpha: 0.15 });
  // Lenient grouping: a 24px cell needs ~4% differing pixels to count, and only touching cells merge.
  const minCell = Number(a['min-cell'] ?? Math.round(0.04 * GRID * GRID));
  const { kept, omitted } = findRegions(diff, { grid: GRID, pad: 16, reach: 1, minCell, max: Number(a['max-regions'] ?? 6) });

  fs.mkdirSync(a.out, { recursive: true });
  const regions = kept.map((r, i) => {
    const region = { x: r.x, y: r.y, width: r.w, height: r.h, diffPixels: r.pixels };
    if (r.w * r.h < 0.6 * w * h) {
      region.zoom = {};
      for (const [side, img] of [['design', design], ['actual', actual], ['diff', diff]]) {
        const rel = `zoom/${name}__r${i + 1}__${side}.png`;
        writePng(path.join(a.out, rel), crop(img, r));
        region.zoom[side] = rel;
      }
    }
    return region;
  });
  const compositeRel = `${name}__composite.png`;
  writePng(path.join(a.out, compositeRel), composite([['DESIGN', design], ['IMPLEMENTATION', actual], ['DIFF', diff]], regions));

  const result = {
    kind: 'ui-diff/design-compare',
    name,
    ...(a.label ? { label: a.label } : {}),
    ...(a.figma ? { figma: a.figma } : {}),
    design: { file: a.design, width: design0.width, height: design0.height },
    actual: { file: a.actual, width: actual0.width, height: actual0.height },
    compared: { width: w, height: h, fit },
    threshold,
    changedPixels: changed,
    percent: Number(((changed / (w * h)) * 100).toFixed(2)),
    regions,
    ...(omitted ? { regionsOmitted: omitted } : {}),
    composite: compositeRel,
    notes,
  };
  fs.writeFileSync(path.join(a.out, `${name}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name, percent: result.percent, regions: regions.length, composite: path.join(a.out, compositeRel) }));
}

main();
