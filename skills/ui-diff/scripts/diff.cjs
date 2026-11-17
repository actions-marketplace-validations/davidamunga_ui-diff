#!/usr/bin/env node
// Pixel-diff two capture folders and write a review bundle.
//
// Usage:
//   node diff.cjs --before shots/before --after shots/after --out shots/report \
//     [--threshold 0.1] [--min-pixels 20]
//
// For every screenshot that changed (or was added/removed) the bundle gets:
//   before/<file>, after/<file>, diff/<file>            full-page images
//   zoom/<name>__r<i>__{before,after,diff}.png           crops of each changed region
// plus results.json describing everything (consumed by comment.cjs).
const fs = require('fs');
const path = require('path');
const { need, args } = require('./lib.cjs');
const { PNG } = need('pngjs');
const pixelmatch = need('pixelmatch');

const GRID = 24; // px; diff pixels are clustered on this grid to find separate regions
const PAD = 32; // px of context around each zoomed region
const MAX_REGIONS = 6;

const readPng = (p) => PNG.sync.read(fs.readFileSync(p));
const writePng = (p, png) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG.sync.write(png));
};

// Place img on a w×h canvas (top-left), filling the rest with opaque white,
// so pages of different heights can still be compared; the padding shows up as change.
function padTo(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

function crop(img, { x, y, w, h }) {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, x, y, w, h, 0, 0);
  return out;
}

// Group diff pixels (pure red in pixelmatch output) into rectangular regions.
function findRegions(diff) {
  const gw = Math.ceil(diff.width / GRID);
  const gh = Math.ceil(diff.height / GRID);
  const cells = new Uint8Array(gw * gh);
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
        cells[Math.floor(y / GRID) * gw + Math.floor(x / GRID)] = 1;
      }
    }
  }
  // Connected components over the grid, allowing a 1-cell gap so nearby edits merge.
  const seen = new Uint8Array(gw * gh);
  const boxes = [];
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c] || seen[c]) continue;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    let count = 0;
    const stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % gw;
      const cy = (k - cx) / gw;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      count++;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const x = Math.max(0, x0 * GRID - PAD);
    const y = Math.max(0, y0 * GRID - PAD);
    boxes.push({
      x, y,
      w: Math.min(diff.width, (x1 + 1) * GRID + PAD) - x,
      h: Math.min(diff.height, (y1 + 1) * GRID + PAD) - y,
      cells: count,
    });
  }
  boxes.sort((a, b) => b.cells - a.cells);
  const kept = boxes.slice(0, MAX_REGIONS).sort((a, b) => a.y - b.y || a.x - b.x);
  return { kept, omitted: boxes.length - kept.length };
}

// An HTTP error page on one side means the route only exists on the other side.
const isErrorPage = (m) => !m || m.error || (m.status && m.status >= 400);

// Things a reviewer should know about a capture beyond the pixels.
function warningsFor(side, m) {
  const w = [];
  if (!m) return w;
  if (m.status >= 400) w.push(`${side} returned HTTP ${m.status}`);
  if (m.devOverlayError) w.push(`${side} showed a framework error overlay`);
  for (const e of m.pageErrors || []) w.push(`${side} threw: ${e}`);
  return w;
}

function loadManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((file) => ({ file, name: file.replace(/\.png$/, '') }));
}

function main() {
  const a = args();
  if (!a.before || !a.after || !a.out) {
    console.error('Required: --before <dir> --after <dir> --out <dir>');
    process.exit(1);
  }
  const threshold = Number(a.threshold ?? 0.1);
  const minPixels = Number(a['min-pixels'] ?? 20);
  const before = new Map(loadManifest(a.before).map((m) => [m.file, m]));
  const after = new Map(loadManifest(a.after).map((m) => [m.file, m]));
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  const exists = (dir, f) => fs.existsSync(path.join(dir, f));
  fs.mkdirSync(a.out, { recursive: true });

  const items = [];
  for (const file of files) {
    const mB = before.get(file);
    const mA = after.get(file);
    const meta = { ...(mB || {}), ...(mA || {}) };
    const item = { file, name: meta.name, route: meta.route, viewport: meta.viewport, scheme: meta.scheme };
    const warnings = [...warningsFor('base', mB), ...warningsFor('head', mA)];
    if (warnings.length) item.warnings = warnings;
    let hasB = exists(a.before, file);
    let hasA = exists(a.after, file);
    // A 404 on base vs a real page on head is a new page, not a "changed" one (and vice versa).
    if (hasB && hasA && isErrorPage(mB) && !isErrorPage(mA)) hasB = false;
    if (hasB && hasA && isErrorPage(mA) && !isErrorPage(mB)) hasA = false;
    const copy = (side, dir) => {
      fs.mkdirSync(path.join(a.out, side), { recursive: true });
      fs.copyFileSync(path.join(dir, file), path.join(a.out, side, file));
    };

    if (!hasB && !hasA) {
      item.status = 'error';
      item.error = (mA || mB || {}).error || 'not captured';
    } else if (!hasB) {
      item.status = 'added';
      copy('after', a.after);
    } else if (!hasA) {
      item.status = 'removed';
      copy('before', a.before);
    } else {
      const b0 = readPng(path.join(a.before, file));
      const a0 = readPng(path.join(a.after, file));
      const w = Math.max(b0.width, a0.width);
      const h = Math.max(b0.height, a0.height);
      const b = padTo(b0, w, h);
      const af = padTo(a0, w, h);
      const diff = new PNG({ width: w, height: h });
      const changed = pixelmatch(b.data, af.data, diff.data, w, h, { threshold, includeAA: false, alpha: 0.15 });
      item.changedPixels = changed;
      item.percent = Number(((changed / (w * h)) * 100).toFixed(3));
      item.before = { width: b0.width, height: b0.height };
      item.after = { width: a0.width, height: a0.height };
      item.sizeChanged = b0.width !== a0.width || b0.height !== a0.height;
      if (changed < minPixels && !item.sizeChanged) {
        item.status = 'unchanged';
      } else {
        item.status = 'changed';
        copy('before', a.before);
        copy('after', a.after);
        writePng(path.join(a.out, 'diff', file), diff);
        const { kept, omitted } = findRegions(diff);
        if (omitted) item.regionsOmitted = omitted;
        item.regions = kept.map((r, i) => {
          const base = `${file.replace(/\.png$/, '')}__r${i + 1}`;
          const region = { x: r.x, y: r.y, width: r.w, height: r.h };
          // Only worth a zoom if the region is meaningfully smaller than the whole page.
          if (r.w * r.h < 0.6 * w * h) {
            region.zoom = {};
            for (const [side, img] of [['before', b], ['after', af], ['diff', diff]]) {
              const rel = `zoom/${base}__${side}.png`;
              writePng(path.join(a.out, rel), crop(img, r));
              region.zoom[side] = rel;
            }
          }
          return region;
        });
      }
    }
    items.push(item);
  }

  const count = (s) => items.filter((i) => i.status === s).length;
  const summary = { changed: count('changed'), added: count('added'), removed: count('removed'), unchanged: count('unchanged'), error: count('error') };
  fs.writeFileSync(path.join(a.out, 'results.json'), JSON.stringify({ summary, items }, null, 2));
  console.log(JSON.stringify(summary));
}

main();
