#!/usr/bin/env node
// Pixel-diff two capture folders and write a review bundle.
//
// Usage:
//   node diff.cjs --before shots/before --after shots/after --out shots/report \
//     [--threshold 0.1] [--min-pixels 20] [--no-animate]
//
// For every screenshot that changed (or was added/removed) the bundle gets:
//   before/<file>, after/<file>, diff/<file>            full-page images
//   zoom/<name>__r<i>__{before,after,diff}.png           crops of each changed region
//   zoom/<name>__r<i>__flip.png                          animated before ⇄ after (APNG; not with --no-animate)
// plus results.json describing everything (consumed by comment.cjs).
const fs = require('fs');
const path = require('path');
const { need, args, readPng, writePng, padTo, crop, findRegions, flipApng } = require('./lib.cjs');
const { PNG } = need('pngjs');
const pixelmatch = need('pixelmatch');

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
  const animate = !a['no-animate'];
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
    if (meta.figma) item.figma = meta.figma;
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
            if (animate) {
              region.zoom.flip = `zoom/${base}__flip.png`;
              fs.writeFileSync(path.join(a.out, region.zoom.flip), flipApng(crop(b, r), crop(af, r)));
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
