#!/usr/bin/env node
// Measured (not eyeballed) design changes: compares the computed-style snapshots that
// capture.cjs saved next to each screenshot, for every screenshot diff.cjs marked "changed".
//
// Usage: node stylediff.cjs --before shots/before --after shots/after --report report
//
// Adds item.measured to report/results.json and writes report/measured.md, a readable
// digest used to write the summary. Elements are matched by DOM path + text/identity, so:
//   - a style change that cascades to 40 children shows up as one grouped line;
//   - content pushed down by an insertion shows up as one "shifted" line, which explains
//     the inflated pixel-diff percentage that a layout shift causes.
const fs = require('fs');
const path = require('path');
const { args } = require('./lib.cjs');

const LIST = 6; // example elements shown per group
const MAX_LINES = 15; // per section

function load(dir, file) {
  const p = path.join(dir, file.replace(/\.png$/, '.styles.json'));
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function label(e) {
  const cls = e.cls.length ? '.' + e.cls.join('.') : '';
  const what = e.text || e.ident;
  return `${e.tag}${cls}${what ? ` "${what.slice(0, 32)}${what.length > 32 ? '…' : ''}"` : ''}`;
}

// rgb(37, 99, 235) -> #2563eb ; leaves everything else alone.
function pretty(v) {
  return v.replace(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g, (m, r, g, b, al) => {
    const h = '#' + [r, g, b].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
    if (al !== undefined && Number(al) === 0) return 'transparent';
    return al !== undefined && Number(al) < 1 ? `${h} @ ${Math.round(Number(al) * 100)}%` : h;
  }) || '(none)';
}

// Fold per-side properties into shorthands (one "padding" line instead of four) and drop
// border colors on borderless elements (they just track currentColor and add noise).
function styleView(st) {
  const four = (p, sfx = '') => {
    const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((d) => st[`${p}-${d}${sfx}`]);
    if (t === b && r === l) return t === r ? t : `${t} ${r}`;
    return r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;
  };
  const v = {};
  // Sub-pixel layout noise (251.172px vs 251.188px) shouldn't count as a change.
  st = Object.fromEntries(Object.entries(st).map(([k, val]) => [k, val.replace(/(\d+\.\d+)px/g, (m, n) => `${Math.round(n * 10) / 10}px`)]));
  for (const [k, val] of Object.entries(st)) {
    if (/^(padding|margin)-|^border-(top|right|bottom|left)-width$/.test(k)) continue;
    v[k] = val;
  }
  v.padding = four('padding');
  v.margin = four('margin');
  v['border-width'] = four('border', '-width');
  // Only the top side's color/style is snapshotted; report it as the shorthand.
  for (const k of ['color', 'style']) { v[`border-${k}`] = v[`border-top-${k}`]; delete v[`border-top-${k}`]; }
  if (v['border-width'] === '0px') { delete v['border-color']; delete v['border-style']; }
  return v;
}

function withKeys(list, keyFn) {
  const seen = {};
  return list.map((e) => {
    const k = keyFn(e);
    seen[k] = (seen[k] || 0) + 1;
    return { e, key: `${k}#${seen[k]}` };
  });
}

function match(before, after) {
  const pairs = [];
  const strict = (e) => `${e.path}|${e.ident}|${e.text}`;
  const loose = (e) => e.path; // same place in the tree, different text/ident => copy change
  let restB = before;
  let restA = after;
  for (const keyFn of [strict, loose]) {
    const mapB = new Map(withKeys(restB, keyFn).map(({ e, key }) => [key, e]));
    const nextA = [];
    for (const { e, key } of withKeys(restA, keyFn)) {
      const b = mapB.get(key);
      if (b) { pairs.push([b, e]); mapB.delete(key); } else nextA.push(e);
    }
    restB = [...mapB.values()];
    restA = nextA;
  }
  return { pairs, removed: restB, added: restA };
}

function compare(b, a) {
  const { pairs, removed, added } = match(b.elements, a.elements);
  const styleGroups = new Map();
  const moves = new Map();
  const resizes = [];
  const copy = [];
  const contrast = [];
  let containersResized = 0;

  for (const [x, y] of pairs) {
    if (x.text !== y.text && (x.text || y.text)) copy.push({ from: x.text, to: y.text, el: label(y) });
    let styled = false;
    const vx = styleView(x.s);
    const vy = styleView(y.s);
    for (const prop of new Set([...Object.keys(vx), ...Object.keys(vy)])) {
      if (vx[prop] === vy[prop] || vx[prop] === undefined || vy[prop] === undefined) continue;
      styled = true;
      const k = `${prop}\u0000${vx[prop]}\u0000${vy[prop]}`;
      if (!styleGroups.has(k)) styleGroups.set(k, { prop, from: pretty(vx[prop]), to: pretty(vy[prop]), els: [] });
      styleGroups.get(k).els.push(label(y));
    }
    const [bx, by, bw, bh] = x.box;
    const [ax, ay, aw, ah] = y.box;
    if (Math.abs(aw - bw) >= 3 || Math.abs(ah - bh) >= 3) {
      // Containers that only grew/shrank to fit their children are counted, not listed.
      if (styled || y.text || y.ident) resizes.push({ el: label(y), from: `${bw}×${bh}`, to: `${aw}×${ah}`, dw: aw - bw, dh: ah - bh, mag: Math.abs(aw - bw) + Math.abs(ah - bh) });
      else containersResized++;
    } else if (!styled && (Math.abs(ax - bx) >= 2 || Math.abs(ay - by) >= 2)) {
      const k = `${ax - bx},${ay - by}`;
      if (!moves.has(k)) moves.set(k, { dx: ax - bx, dy: ay - by, els: [], top: Infinity });
      const m = moves.get(k);
      m.els.push(label(y));
      m.top = Math.min(m.top, by);
    }
    if (y.contrast && y.contrast.ratio < y.contrast.min && !(x.contrast && x.contrast.ratio < x.contrast.min)) {
      contrast.push({ el: label(y), ...y.contrast, was: x.contrast && x.contrast.ratio });
    }
  }
  for (const y of added) {
    if (y.contrast && y.contrast.ratio < y.contrast.min) contrast.push({ el: label(y), ...y.contrast, was: null });
  }

  const byCount = (m) => [...m.values()].sort((p, q) => q.els.length - p.els.length);
  return {
    matched: pairs.length,
    styles: byCount(styleGroups).map((g) => ({ ...g, count: g.els.length, els: [...new Set(g.els)].slice(0, LIST) })),
    moves: byCount(moves).map((m) => ({ dx: m.dx, dy: m.dy, top: m.top, count: m.els.length, els: m.els.slice(0, 3) })),
    resizes: collapse(resizes.sort((p, q) => q.mag - p.mag)).slice(0, MAX_LINES),
    containersResized,
    copy: copy.slice(0, MAX_LINES),
    added: added.filter((e) => e.text || e.ident).slice(0, MAX_LINES).map(label),
    addedCount: added.length,
    removed: removed.filter((e) => e.text || e.ident).slice(0, MAX_LINES).map(label),
    removedCount: removed.length,
    contrast: contrast.slice(0, MAX_LINES),
    truncated: !!(a.truncated || b.truncated),
  };
}

// Elements that resized by the same amount (a card's contents all narrowing by 10px when its
// padding grows) become one line with a count; a lone resize keeps its exact sizes.
function collapse(resizes) {
  const m = new Map();
  for (const { mag, dw, dh, ...r } of resizes) {
    const k = `${dw},${dh}`;
    if (!m.has(k)) m.set(k, { ...r, dw, dh, count: 0, els: [] });
    const g = m.get(k);
    g.count++;
    if (!g.els.includes(r.el)) g.els.push(r.el);
  }
  return [...m.values()].map((g) => ({ ...g, els: g.els.slice(0, 3) }));
}

// Contrast failures on a page that only exists on head.
function newPageContrast(snap) {
  const seen = new Set();
  const out = [];
  for (const e of snap.elements) {
    if (!e.contrast || e.contrast.ratio >= e.contrast.min) continue;
    const k = `${e.contrast.fg}|${e.contrast.bg}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`⚠️ contrast ${e.contrast.ratio}:1 (needs ${e.contrast.min}:1): ${label(e)}, ${e.contrast.fg} on ${e.contrast.bg}`);
  }
  return out.slice(0, MAX_LINES);
}

// Plain-text lines, shared by measured.md and the PR comment.
function lines(m) {
  const out = [];
  for (const g of m.styles.slice(0, MAX_LINES)) {
    out.push(`\`${g.prop}\`: ${g.from} → ${g.to} — ${g.count} el (${g.els.join(', ')}${g.count > g.els.length ? ', …' : ''})`);
  }
  if (m.styles.length > MAX_LINES) out.push(`…and ${m.styles.length - MAX_LINES} more style changes`);
  const delta = (n, dim) => n && `${n > 0 ? '+' : ''}${n}px ${dim}`;
  for (const r of m.resizes) {
    if (r.count === 1) out.push(`resized: ${r.el} ${r.from} → ${r.to}`);
    else out.push(`resized ${[delta(r.dw, 'wide'), delta(r.dh, 'tall')].filter(Boolean).join(', ')}: ${r.count} el (${r.els.join(', ')}${r.count > r.els.length ? ', …' : ''})`);
  }
  if (m.containersResized) out.push(`${m.containersResized} container(s) resized to fit their content`);
  for (const mv of m.moves.slice(0, 5)) {
    const dir = [mv.dy && `${mv.dy > 0 ? '+' : ''}${mv.dy}px vertically`, mv.dx && `${mv.dx > 0 ? '+' : ''}${mv.dx}px horizontally`].filter(Boolean).join(', ');
    out.push(`shifted ${dir}: ${mv.count} el, starting at y≈${mv.top} (${mv.els.join(', ')}) — layout shift, not a style change`);
  }
  for (const c of m.copy) out.push(`copy: "${c.from}" → "${c.to}"`);
  if (m.addedCount) out.push(`added: ${m.addedCount} el${m.added.length ? ` (${m.added.join(', ')})` : ''}`);
  if (m.removedCount) out.push(`removed: ${m.removedCount} el${m.removed.length ? ` (${m.removed.join(', ')})` : ''}`);
  for (const c of m.contrast) {
    out.push(`⚠️ contrast ${c.ratio}:1 (needs ${c.min}:1): ${c.el}, ${c.fg} on ${c.bg}${c.was ? ` (was ${c.was}:1)` : ''}`);
  }
  if (m.truncated) out.push('(page has >4000 visible elements; only the first 4000 were compared)');
  return out;
}

function main() {
  const a = args();
  if (!a.before || !a.after || !a.report) {
    console.error('Required: --before <dir> --after <dir> --report <dir>');
    process.exit(1);
  }
  const resultsPath = path.join(a.report, 'results.json');
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const md = ['# Measured changes', '', 'Computed styles of matched elements, base → head. Colors in sRGB hex.', ''];
  for (const item of results.items) {
    if (item.status === 'added') {
      const snap = load(a.after, item.file);
      const issues = snap ? newPageContrast(snap) : [];
      if (issues.length) {
        item.measured = { lines: issues };
        md.push(`## 🆕 ${item.route || item.name} — ${item.viewport}`, '', ...issues.map((l) => `- ${l}`), '');
      }
      continue;
    }
    if (item.status !== 'changed') continue;
    const b = load(a.before, item.file);
    const af = load(a.after, item.file);
    if (!b || !af) continue;
    item.measured = compare(b, af);
    item.measured.lines = lines(item.measured);
    md.push(`## ${item.route || item.name} — ${item.viewport}${item.scheme && item.scheme !== 'light' ? ` · ${item.scheme}` : ''}`, '');
    md.push(...(item.measured.lines.length ? item.measured.lines.map((l) => `- ${l}`) : ['- No computed-style differences; the pixel change is from images, canvas, or content outside the DOM.']), '');
  }
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(a.report, 'measured.md'), md.join('\n'));
  console.log(JSON.stringify({ measured: results.items.filter((i) => i.measured).length }));
}

main();
