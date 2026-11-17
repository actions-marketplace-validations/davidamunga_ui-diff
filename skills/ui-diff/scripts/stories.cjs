#!/usr/bin/env node
// Storybook mode: pick the stories affected by a change and write a capture config per side.
//
// Usage:
//   node stories.cjs --base <url|index.json> --head <url|index.json> --changed <file> --out <dir>
//     [--root-head <dir>] [--root-base <dir>] [--stories "id1,button--*"] [--config .ui-diff.json] [--max 40]
//
// --base/--head  a running Storybook (reads /index.json, falls back to /stories.json for v6) or a saved index file
// --changed      changed file paths, one per line, relative to the Storybook project dir (where .storybook/ is)
// --root-*       checkouts to read story sources from, for following imports
// --stories      pick these ids instead of inferring them (`*` wildcards allowed); config storybook.stories are always added
//
// A story is picked when its file changed, when a changed file has the same base name
// (Button.tsx, button.module.css → Button.stories.tsx), or when its file imports a changed
// file (up to 5 levels). A changed file matching none of those falls back to stories in the
// same folder. A change under .storybook/ picks every story (capped by --max).
// Writes <out>/capture-base.json and capture-head.json (the config with routes = that side's
// stories, so a story on one side only shows up as new / removed) and prints a JSON summary.
const fs = require('fs');
const path = require('path');
const { args } = require('./lib.cjs');

const P = path.posix;
const DEFAULT_VIEWPORTS = { desktop: { width: 1024, height: 768 }, mobile: { device: 'iPhone 13' } };
// Rendered (v7+: #storybook-root, v6: #root), or Storybook is showing an error / "no preview".
const WAIT_FOR = '#storybook-root > *:visible, #root > *:visible, .sb-errordisplay:visible, .sb-nopreview:visible'; // Playwright :visible
const UI_EXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|astro|css|scss|sass|less|styl|html|svg|png|jpe?g|gif|webp|avif|woff2?)$/i;
const RESOLVE_EXT = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

const norm = (f) => P.normalize(String(f).trim().replace(/\\/g, '/')).replace(/^\.\//, '');
// "src/Button/index.tsx" → "button", "PrimaryButton.stories.tsx" → "primarybutton", "primary-button.module.css" → "primarybutton"
function stem(f) {
  let s = P.basename(f).split('.')[0];
  if (s === 'index') s = P.basename(P.dirname(f));
  return s.toLowerCase().replace(/[-_]/g, '');
}

// index.json (v7+: {entries}) or stories.json (v6: {stories}) → [{id, title, name, importPath}] (stories only, no docs).
function parseIndex(json) {
  const entries = Object.values(json.entries || json.stories || {});
  return entries
    .filter((e) => e && e.id && (e.type === undefined || e.type === 'story'))
    .map((e) => ({ id: e.id, title: e.title || e.kind, name: e.name, importPath: norm(e.importPath || '') }));
}

async function loadIndex(src) {
  if (!/^https?:/.test(src)) return parseIndex(JSON.parse(fs.readFileSync(src, 'utf8')));
  for (const p of ['/index.json', '/stories.json']) {
    const res = await fetch(new URL(p, src)).catch(() => null);
    if (res && res.ok) return parseIndex(await res.json());
  }
  throw new Error(`no /index.json or /stories.json at ${src} (is it a Storybook?)`);
}

// Relative (and @/ ~/ → src/) imports of a source file, resolved to project paths.
function importsOf(file, read) {
  const src = read(file);
  if (!src) return [];
  const out = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|@import\s+(?:url\()?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    let base;
    if (spec.startsWith('.')) base = P.join(P.dirname(file), spec);
    else if (/^[@~]\//.test(spec)) base = P.join('src', spec.slice(2));
    else continue;
    const hit = RESOLVE_EXT.map((e) => norm(base + e)).find((f) => read(f) !== null);
    if (hit) out.push(hit);
  }
  return out;
}

// Files a story file depends on (itself included), following local imports `depth` levels.
function closure(file, read, depth = 5) {
  const seen = new Set([file]);
  let frontier = [file];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) for (const i of importsOf(f, read)) if (!seen.has(i)) { seen.add(i); next.push(i); }
    frontier = next;
  }
  return seen;
}

// changed: paths relative to the Storybook project; read(file) → source text or null.
// Returns { picked: Map<id, reason>, unmatched: [files] }.
function pickStories(stories, changed, read = () => null) {
  const picked = new Map();
  const add = (s, why) => picked.has(s.id) || picked.set(s.id, why);
  const files = [...new Set(stories.map((s) => s.importPath))];
  const deps = new Map();
  const depsOf = (f) => deps.get(f) || deps.set(f, closure(f, read)).get(f);
  const unmatched = [];
  for (const c of changed.map(norm).filter(Boolean)) {
    if (c.startsWith('.storybook/')) {
      for (const s of stories) add(s, `Storybook config ${c} changed`);
      continue;
    }
    let hit = false;
    for (const s of stories) {
      const why = s.importPath === c ? 'story file changed'
        : stem(s.importPath) === stem(c) && UI_EXT.test(c) ? `same name as ${c}`
        : depsOf(s.importPath).has(c) ? `imports ${c}` : null;
      if (why) { add(s, why); hit = true; }
    }
    if (!hit && UI_EXT.test(c)) {
      const near = files.filter((f) => P.dirname(f) === P.dirname(c));
      for (const s of stories) if (near.includes(s.importPath)) { add(s, `next to ${c}`); hit = true; }
    }
    if (!hit && UI_EXT.test(c)) unmatched.push(c);
  }
  return { picked, unmatched };
}

// "button--*" style patterns → matching ids.
function pickExplicit(stories, patterns) {
  const picked = new Map();
  for (const p of patterns) {
    const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    for (const s of stories) if (re.test(s.id) && !picked.has(s.id)) picked.set(s.id, 'requested');
  }
  return picked;
}

const storyRoute = (s) => ({ path: `/iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story`, name: s.id, label: s.id, waitFor: WAIT_FOR });

async function main() {
  const a = args();
  if (!a.base || !a.head || !a.out) {
    console.error('Required: --base <url|index.json> --head <url|index.json> --out <dir> [--changed <file>]');
    process.exit(1);
  }
  const cfg = a.config && fs.existsSync(a.config) ? JSON.parse(fs.readFileSync(a.config, 'utf8')) : {};
  const sb = typeof cfg.storybook === 'object' && cfg.storybook ? cfg.storybook : {};
  const [base, head] = await Promise.all([loadIndex(a.base), loadIndex(a.head)]);
  const onBase = new Set(base.map((s) => s.id));
  const onHead = new Set(head.map((s) => s.id));
  const all = [...head, ...base.filter((s) => !onHead.has(s.id))];

  const roots = [a['root-head'], a['root-base']].filter((r) => typeof r === 'string');
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) {
      let txt = null;
      for (const r of roots) {
        const p = path.join(r, f);
        try { if (fs.statSync(p).isFile()) { txt = fs.readFileSync(p, 'utf8'); break; } } catch {}
      }
      cache.set(f, txt);
    }
    return cache.get(f);
  };

  let picked, unmatched = [];
  if (typeof a.stories === 'string') picked = pickExplicit(all, a.stories.split(',').map((s) => s.trim()).filter(Boolean));
  else {
    const changed = a.changed && fs.existsSync(a.changed) ? fs.readFileSync(a.changed, 'utf8').split('\n') : [];
    ({ picked, unmatched } = pickStories(all, changed, read));
  }
  for (const [id, why] of pickExplicit(all, sb.stories || [])) if (!picked.has(id)) picked.set(id, why);

  const max = Number(a.max || sb.max || 40);
  const ids = [...picked.keys()];
  const kept = ids.slice(0, max);
  const byId = new Map(all.map((s) => [s.id, s]));
  fs.mkdirSync(a.out, { recursive: true });
  for (const [side, has] of [['base', onBase], ['head', onHead]]) {
    const routes = kept.filter((id) => has.has(id)).map((id) => storyRoute(byId.get(id)));
    const out = { ...cfg, routes, viewports: sb.viewports || DEFAULT_VIEWPORTS };
    fs.writeFileSync(path.join(a.out, `capture-${side}.json`), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify({
    stories: kept.map((id) => ({ id, reason: picked.get(id), ...(!onBase.has(id) ? { only: 'head' } : !onHead.has(id) ? { only: 'base' } : {}) })),
    omitted: ids.length - kept.length,
    unmatched,
    total: all.length,
    sample: all.slice(0, 5).map((s) => s.id),
  }, null, 2));
}

module.exports = { parseIndex, pickStories, pickExplicit, importsOf, stem, storyRoute };
if (require.main === module) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
