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
// Also compares the possible-bug checks (<file>.issues.json) for every captured page and keeps
// only problems that are new on head: item.issues = { new: [{type, line, zoom?}], existing, omitted },
// with a crop of the head screenshot around each layout problem in report/issues/.
const fs = require('fs');
const path = require('path');
const { args, readPng, writePng, crop } = require('./lib.cjs');

const LIST = 6; // example elements shown per group
const MAX_LINES = 15; // per section

function load(dir, file) {
  const p = path.join(dir, file.replace(/\.png$/, '.styles.json'));
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

const MAX_PROBLEMS = 6; // per page; prefer missing a borderline case to flooding the comment

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

// --- possible problems (new on head) ------------------------------------------------
function loadIssues(dir, file) {
  const p = path.join(dir, file.replace(/\.png$/, '.issues.json'));
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// Strict key: same element in the same place. Loose key: same element by tag + text/identity
// even if a wrapper was added around it. An issue is pre-existing if base has either.
function issueKeys(i) {
  const s = (e) => `${e.path}|${e.ident}|${e.text}`;
  const l = (e) => (e.text || e.ident ? `${e.tag}|${e.ident}|${e.text}` : null);
  const t = `${i.type}|${i.rule || ''}|`;
  if (i.other) {
    const pair = (f) => (f(i.el) && f(i.other) ? t + [f(i.el), f(i.other)].sort().join('&') : null);
    return [pair(s), pair(l)];
  }
  return [t + s(i.el), l(i.el) && t + l(i.el)];
}

function newIssues(base, head) {
  if (!base) return { list: head.issues, existing: 0 };
  const bag = new Map();
  for (const i of base.issues) for (const k of issueKeys(i)) if (k) bag.set(k, (bag.get(k) || 0) + 1);
  const baseOverflow = base.issues.find((i) => i.type === 'pageOverflow');
  const list = [];
  let existing = 0;
  for (const i of head.issues) {
    // Sideways scroll is one issue per page: pre-existing unless the page got noticeably wider.
    if (i.type === 'pageOverflow' && baseOverflow && i.detail.page <= baseOverflow.detail.page + 8) { existing++; continue; }
    const k = issueKeys(i).find((x) => x && bag.get(x) > 0);
    if (k) { bag.set(k, bag.get(k) - 1); existing++; } else list.push(i);
  }
  return { list, existing };
}

const IMPACT = { critical: 0, serious: 1, moderate: 3, minor: 4 };
const RANK = { pageOverflow: 0, textClipping: 1, offscreen: 1, overlap: 2, tapTargets: 3 };

// One line per problem: same element or same a11y rule folded together, most serious first.
function problems(list) {
  const px = (w, h) => `${w}×${h}px`;
  const out = new Map();
  const add = (key, rank, p) => { if (!out.has(key)) out.set(key, { rank, ...p, items: [] }); out.get(key).items.push(p.src); };
  for (const i of list) {
    const el = label(i.el);
    if (i.type === 'textClipping') {
      const how = { ellipsis: 'truncated with “…”', 'line-clamp': 'cut by a line clamp', overflow: `clipped by ${i.detail.by ? `its \`${i.detail.by}\` container` : 'its box'}` }[i.detail.how];
      add(`clip|${el}`, RANK.textClipping, { type: i.type, src: i, line: `text cut off: ${el} — ${how} (text needs ${px(...i.detail.text)}, box is ${px(...i.detail.clip)})` });
    } else if (i.type === 'pageOverflow') {
      const widest = i.detail.widest.map((w) => `${label(w)} to x=${w.right}`).join(', ');
      add('overflow', RANK.pageOverflow, { type: i.type, src: i, line: `page scrolls sideways: ${i.detail.page}px of content in a ${i.detail.viewport}px viewport — widest: ${widest}` });
    } else if (i.type === 'offscreen') {
      const why = i.detail.zero ? 'has no size (squashed to 0)' : i.detail.clipped ? `is pushed out of its \`${i.detail.clipped}\` (overflow hidden) and can't be seen` : `is outside the page (x=${i.detail.x}px) and can't be reached`;
      add(`off|${el}`, RANK.offscreen, { type: i.type, src: i, line: `${el} ${why}` });
    } else if (i.type === 'overlap') {
      add(`lap|${el}|${label(i.other)}`, RANK.overlap, { type: i.type, src: i, line: `overlap: ${el} and ${label(i.other)} overlap by ${px(i.detail.w, i.detail.h)}` });
    } else if (i.type === 'tapTargets') {
      add('tap', RANK.tapTargets, { type: i.type, src: i });
    } else if (i.type === 'a11y') {
      add(`a11y|${i.rule}`, IMPACT[i.impact] ?? 3, { type: i.type, src: i, rule: i.rule, impact: i.impact });
    }
  }
  const few = (xs, f) => [...new Set(xs.map(f))].slice(0, 3).join(', ') + (new Set(xs.map(f)).size > 3 ? ', …' : '');
  for (const p of out.values()) {
    const n = p.items.length;
    if (p.type === 'tapTargets') p.line = `${n} tap target${n > 1 ? 's' : ''} under 24×24px (WCAG 2.5.8) and close to others: ${few(p.items, (i) => `${label(i.el)} ${px(i.detail.w, i.detail.h)}`)}`;
    if (p.type === 'a11y') {
      const s = p.items[0];
      p.line = `a11y (${s.impact}) [${s.rule}](${s.helpUrl.replace(/\?.*$/, '')}): ${s.help.replace(/\.$/, '').replace(/<(\/?[\w-]+)>/g, '`<$1>`')} — ${n} el (${few(p.items, (i) => (i.el.tag ? label(i.el) : `\`${i.target}\``))})`;
    }
  }
  return [...out.values()].sort((x, y) => x.rank - y.rank);
}

// Head screenshot around a problem, with the element outlined in red.
// Sideways scroll also gets a blue line at the viewport's right edge.
function zoomFor(p, shot, dpr, rel, outDir, vw) {
  const b = p.items[0].box;
  if (!b || !shot) return null;
  const PAD = 40;
  const x0 = Math.max(0, Math.round((b[0] - PAD) * dpr));
  const y0 = Math.max(0, Math.round((b[1] - PAD) * dpr));
  const w = Math.min(shot.width - x0, Math.round((Math.min(b[2], 900) + PAD * 2) * dpr));
  const h = Math.min(shot.height - y0, Math.round((Math.min(b[3], 360) + PAD * 2) * dpr));
  if (w < 8 || h < 8) return null;
  const img = crop(shot, { x: x0, y: y0, w, h });
  const ox = Math.round(b[0] * dpr) - x0, oy = Math.round(b[1] * dpr) - y0;
  const ow = Math.round(b[2] * dpr), oh = Math.round(b[3] * dpr);
  const t = Math.max(2, Math.round(dpr * 2));
  for (let y = oy - t; y < oy + oh + t; y++) {
    for (let x = ox - t; x < ox + ow + t; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (x >= ox && x < ox + ow && y >= oy && y < oy + oh) continue; // inside: leave as is
      img.data.set([229, 72, 77, 255], (y * w + x) * 4);
    }
  }
  if (p.type === 'pageOverflow' && vw) {
    const lx = Math.round(vw * dpr) - x0;
    for (let y = 0; y < h; y++) for (let x = lx - t; x < lx; x++) if (x >= 0 && x < w) img.data.set([9, 105, 218, 255], (y * w + x) * 4);
  }
  writePng(path.join(outDir, rel), img);
  return { rel, width: Math.round(w / dpr) };
}

function checkItem(item, a) {
  if (!['changed', 'unchanged', 'added'].includes(item.status)) return;
  const head = loadIssues(a.after, item.file);
  const base = item.status === 'added' ? null : loadIssues(a.before, item.file);
  if (!head || (item.status !== 'added' && !base)) return;
  const { list, existing } = newIssues(base, head);
  if (!list.length && !existing) return;
  const all = problems(list);
  const kept = all.slice(0, MAX_PROBLEMS);
  let shot = null;
  try { shot = kept.some((p) => p.type !== 'a11y') ? readPng(path.join(a.after, item.file)) : null; } catch {}
  item.issues = {
    new: kept.map((p, n) => {
      const out = { type: p.type, line: p.line };
      if (p.rule) Object.assign(out, { rule: p.rule, impact: p.impact });
      const zoom = p.type !== 'a11y' && zoomFor(p, shot, head.dpr || 1, `issues/${item.file.replace(/\.png$/, '')}__p${n + 1}.png`, a.report, head.viewport);
      if (zoom) Object.assign(out, { zoom: zoom.rel, zoomWidth: zoom.width });
      return out;
    }),
    existing,
  };
  if (all.length > kept.length) item.issues.omitted = all.length - kept.length;
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
  const probs = [];
  for (const item of results.items) {
    checkItem(item, a);
    if (item.issues && item.issues.new.length) {
      probs.push(`### ${item.route || item.name} — ${item.viewport}${item.scheme && item.scheme !== 'light' ? ` · ${item.scheme}` : ''}${item.status === 'added' ? ' (new page)' : ''}`, '',
        ...item.issues.new.map((p) => `- ⚠️ ${p.line}${p.zoom ? ` (zoom: \`${p.zoom}\`)` : ''}`),
        ...(item.issues.omitted ? [`- …and ${item.issues.omitted} more`] : []), '');
    }
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
  if (probs.length) {
    md.splice(2, 0, '## ⚠️ Possible problems (new on head)', '',
      'Heuristic checks (clipped text, sideways scroll, overlap, off-screen controls, small mobile tap targets, axe-core WCAG A/AA) that fire on head but not on base. Confirm each in the zoom image before reporting it.', '',
      ...probs, '## Style and layout changes', '');
  }
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(a.report, 'measured.md'), md.join('\n'));
  console.log(JSON.stringify({ measured: results.items.filter((i) => i.measured).length, problems: results.items.reduce((n, i) => n + (i.issues ? i.issues.new.length : 0), 0) }));
}

main();
