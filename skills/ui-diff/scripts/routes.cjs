#!/usr/bin/env node
// Pick the routes worth capturing from a change: changed files → the pages that render them.
//
// Usage (from the repo):
//   node routes.cjs --base <ref> [--head <ref>] [--root <dir>] [--changed <file>|-] [--config .ui-diff.json]
//     [--app-dir apps/web] [--max 8] [--routes "/users/42"] [--print] [--log]
//
// --base     base ref: changed files = diff from its merge-base (plus uncommitted and untracked
//            files when --head isn't given); base's file list tells which pages were removed
// --head     the head ref, when --root is a checkout of it rather than the working tree
// --root     checkout to read (default: the repo containing the cwd)
// --base-root  a base checkout to list instead of --base (tests)
// --changed  changed paths relative to --root, one per line, instead of asking git
// --routes   known routes; used as example values for dynamic routes
// --print    print a comma-separated list instead of JSON; --log  explain each pick on stderr
//
// Config (.ui-diff.json at --root): appDir (the app's package in a monorepo), maxRoutes (8),
// routeParams ({"slug": "hello"} by param name, or {"/blog/[slug]": "/blog/hello"} by route),
// and routes (paths there also serve as examples for dynamic routes).
//
// Output: {framework, appDir, routes: [{path, reasons, confidence}], needsExample: [{route, file, reasons}],
//          unmatched: [files], ignored: [files], omitted: [paths]}
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { args } = require('./lib.cjs');
const { CODE_EXT, norm, parseJsonc, createResolver, workspacePackages, importersMap } = require('./imports.cjs');

const P = path.posix;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.output|\.svelte-kit|\.astro|\.vercel|\.turbo|\.cache|\.ui-diff|dist|build|out|coverage|storybook-static)(\/|$)/;
const PAGE_EXT = /\.(tsx?|jsx?|mdx?)$/;
// Never visual: tests, stories, docs, lockfiles, tooling config, CI.
const NON_UI = [
  /(^|\/)(__tests__|__mocks__|__snapshots__|e2e|cypress|playwright|\.github|\.husky|\.vscode|\.changeset)\//,
  /\.(test|spec|stories|story|e2e|cy)\.[a-z]+$/, /\.d\.ts$/, /\.snap$/,
  /\.(md|txt|lock|log|ya?ml|toml|sh|py|rb|go|rs|sql|prisma|graphql|gql|env)$/i,
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|jsconfig\.json|\.gitignore|\.npmrc|\.nvmrc|\.node-version|\.editorconfig|\.prettierrc[^/]*|\.eslintrc[^/]*|\.ui-diff\.json|LICENSE[^/]*|Dockerfile|\.dockerignore|turbo\.json|nx\.json|vercel\.json|netlify\.toml|\.env[^/]*)$/,
  /(^|\/)(eslint|prettier|vitest|jest|playwright|cypress|commitlint|lint-staged|babel|knip|renovate)\.config\.[a-z]+$/,
];
// Global when nothing imports them: theme, tokens, tailwind/postcss config, fonts.
const GLOBAL = /(^|\/)(tailwind\.config|postcss\.config|uno\.config|panda\.config|theme|tokens?|design-tokens|variables)(\.[a-z]+)+$|(^|\/)(theme|tokens|styles)\/|\.(woff2?|ttf|otf)$/i;
const UI_EXT = /\.(jsx?|tsx?|mjs|cjs|mts|vue|svelte|astro|css|scss|sass|less|styl|html?|mdx|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json)$/i;
const ASSET = /\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json|mp4|webm)$/i;
const GLOBAL_PICKS = 3; // routes besides home for a global change

// --- trees: {files, has, read} over repo-relative paths ---------------------------
function git(root, argv) {
  return cp.execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
}
function isGitTop(root) {
  try { return git(root, ['rev-parse', '--show-prefix']).trim() === ''; } catch { return false; }
}
function walk(root) {
  const out = [];
  const go = (rel) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_DIRS.test(f)) continue;
      if (e.isDirectory()) go(f);
      else if (e.isFile()) out.push(f);
    }
  };
  go('');
  return out;
}
function makeTree(files, readRaw) {
  files = files.filter((f) => f && !SKIP_DIRS.test(f));
  const set = new Set(files);
  const cache = new Map();
  const read = (f) => {
    if (!set.has(f)) return null;
    if (!cache.has(f)) cache.set(f, readRaw(f));
    return cache.get(f);
  };
  return { files, has: (f) => set.has(f), read };
}
function dirTree(root) {
  const files = isGitTop(root) ? git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0') : walk(root);
  return makeTree(files.filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } }), (f) => {
    try { const p = path.join(root, f); return fs.statSync(p).size > 1e6 ? '' : fs.readFileSync(p, 'utf8'); } catch { return null; }
  });
}
function refTree(root, ref) { // file list of a commit (contents read lazily via git show)
  return makeTree(git(root, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0'), (f) => {
    try { return git(root, ['show', `${ref}:${f}`]); } catch { return null; }
  });
}

// --- the app: which package, which framework ----------------------------------------
const DEPS = (pj) => ({ ...(pj.dependencies || {}), ...(pj.devDependencies || {}) });
function frameworkOf(pj) {
  const d = DEPS(pj);
  if (d.next) return 'next';
  if (d['@sveltejs/kit']) return 'sveltekit';
  if (d.nuxt || d.nuxt3) return 'nuxt';
  if (d.astro) return 'astro';
  if (d['@remix-run/react'] || d['@remix-run/dev'] || d['@react-router/dev']) return 'remix';
  if (d['@angular/core'] || d['react-router-dom'] || d['react-router'] || d['vue-router'] || d['@tanstack/react-router'] ||
      d.vite || d.react || d.vue || d['solid-js'] || d.preact || d['react-scripts'] || d.svelte) return 'spa';
  return null;
}

// Monorepo: the package with a framework (config appDir wins); several → the one the root dev script names, then apps/*.
function findApp(tree, appDir, changed) {
  const pkgs = tree.files.filter((f) => P.basename(f) === 'package.json').map((f) => (P.dirname(f) === '.' ? '' : P.dirname(f)));
  const pj = (d) => parseJsonc(tree.read(P.join(d, 'package.json'))) || {};
  if (appDir != null) {
    const d = norm(appDir) === '.' ? '' : norm(appDir);
    const fw = tree.has(P.join(d, 'package.json')) ? frameworkOf(pj(d)) : null;
    return { dir: d, framework: fw || (tree.files.some((f) => f.startsWith(d ? d + '/' : '') && f.endsWith('.html')) ? 'html' : 'spa') };
  }
  const apps = pkgs.map((d) => ({ dir: d, framework: frameworkOf(pj(d)), pj: pj(d) })).filter((a) => a.framework);
  if (!apps.length) {
    if (tree.files.some((f) => /\.html?$/.test(f))) return { dir: '', framework: 'html' };
    return { dir: '', framework: null };
  }
  const root = apps.find((a) => a.dir === '');
  if (root && root.framework !== 'spa') return root;
  const rootScripts = JSON.stringify((pj('').scripts) || {});
  const score = (a) => (a.framework !== 'spa' ? 4 : 0) +
    (a.dir && (rootScripts.includes(a.dir) || (a.pj.name && new RegExp(`[\\s=]${a.pj.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`).test(rootScripts))) ? 3 : 0) +
    (/^apps?\//.test(a.dir) ? 2 : 0) + (a.pj.scripts && (a.pj.scripts.dev || a.pj.scripts.start) ? 1 : 0) +
    changed.filter((f) => a.dir && f.startsWith(a.dir + '/')).length * 0.01;
  return apps.sort((a, b) => score(b) - score(a) || a.dir.length - b.dir.length)[0];
}

// --- route discovery ----------------------------------------------------------------
// Route: {pattern: "/blog/[slug]", file, params: [..]}. Layout: {file, members: [routes], root}.
// Shells: files every page renders (root layout, _app, app.vue, main.tsx…).

// One file-system segment ("[id]", "(group)", "@slot", "[[...opt]]") → text, "" (dropped) or null (not a route).
function fsSegment(s, fw) {
  if (/^\(\.{1,3}\)/.test(s)) return null; // Next intercepting route
  if (/^\(.*\)$/.test(s)) return '';
  if (fw === 'next' && s.startsWith('@')) return '';
  if ((fw === 'next' || fw === 'astro') && s.startsWith('_')) return null;
  if (/^\[\[.*\]\]$/.test(s)) return ''; // optional param: the parent path renders
  return s.replace(/\[(\.\.\.)?([^\]=]+)(=[^\]]+)?\]/g, (m, rest, name) => `[${rest || ''}${name}]`);
}
function makeRoute(segs, file, fw) {
  const parts = [];
  for (const s of segs) {
    const x = fsSegment(s, fw);
    if (x === null) return null;
    if (x) parts.push(x);
  }
  const pattern = '/' + parts.join('/');
  return { pattern, file, params: [...pattern.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]) };
}
const firstRoot = (tree, A, dirs) => dirs.map((d) => A + d).find((d) => tree.files.some((f) => f.startsWith(d + '/')));
const under = (dir, f) => f.startsWith(dir + '/');
const dirOf = (f) => (P.dirname(f) === '.' ? '' : P.dirname(f));
function dirLayouts(out, files, root) { // layout files scoped to their directory
  for (const f of files) {
    const d = dirOf(f);
    out.layouts.push({ file: f, root: d === root, members: out.routes.filter((r) => d === root || under(d, r.file)) });
    if (d === root) out.shells.add(f);
  }
}

function discover(tree, app) {
  const A = app.dir ? app.dir + '/' : '';
  const fw = app.framework;
  const out = { routes: [], layouts: [], shells: new Set(), endpoints: new Set() };
  const inApp = tree.files.filter((f) => f.startsWith(A));
  const rel = (f, root) => f.slice(root.length + 1);
  const add = (r) => r && out.routes.push(r);

  if (fw === 'next') {
    const appRoot = firstRoot(tree, A, ['app', 'src/app']);
    if (appRoot) {
      const lay = [];
      for (const f of inApp.filter((f) => under(appRoot, f))) {
        const b = P.basename(f), segs = rel(dirOf(f), appRoot) ? rel(f, appRoot).split('/').slice(0, -1) : [];
        if (/^page\.(tsx?|jsx?|mdx?)$/.test(b)) add(makeRoute(segs, f, fw));
        else if (/^route\.[cm]?[jt]sx?$/.test(b)) out.endpoints.add(f);
        else if (/^(layout|template)\.[jt]sx?$/.test(b)) lay.push(f);
      }
      dirLayouts(out, lay, appRoot);
    }
    const pagesRoot = firstRoot(tree, A, ['pages', 'src/pages']);
    if (pagesRoot) {
      for (const f of inApp.filter((f) => under(pagesRoot, f) && PAGE_EXT.test(f))) {
        const segs = rel(f, pagesRoot).replace(PAGE_EXT, '').split('/');
        if (segs[0] === 'api') out.endpoints.add(f);
        else if (/^_(app|document)$/.test(segs[0])) out.shells.add(f);
        else if (!/^(_error|404|500)$/.test(segs[0]) && !segs.some((s) => s.startsWith('_'))) {
          if (segs[segs.length - 1] === 'index') segs.pop();
          add(makeRoute(segs, f, fw));
        }
      }
    }
  } else if (fw === 'sveltekit') {
    const root = A + 'src/routes';
    const lay = [];
    for (const f of inApp.filter((f) => under(root, f))) {
      const b = P.basename(f), segs = dirOf(f) === root ? [] : rel(dirOf(f), root).split('/');
      if (/^\+page(@[^.]*)?\.(svelte|[jt]s)$/.test(b) || /^\+page\.server\.[jt]s$/.test(b)) add(makeRoute(segs, f, fw));
      else if (/^\+layout(@[^.]*)?\.(svelte|[jt]s)$/.test(b) || /^\+layout\.server\.[jt]s$/.test(b)) lay.push(f);
      else if (/^\+server\.[jt]s$/.test(b)) out.endpoints.add(f);
    }
    // +page.ts next to +page.svelte is the same route; keep one entry per file anyway (lookups are by file)
    dirLayouts(out, lay, root);
    for (const s of ['src/app.html']) if (tree.has(A + s)) out.shells.add(A + s);
  } else if (fw === 'nuxt') {
    const src = tree.files.some((f) => under(A + 'app/pages', f)) ? A + 'app/' : A;
    const root = src + 'pages';
    const pages = inApp.filter((f) => under(root, f) && /\.(vue|[jt]sx)$/.test(f));
    for (const f of pages) {
      const segs = rel(f, root).replace(/\.(vue|[jt]sx)$/, '').split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      add(makeRoute(segs, f, fw));
    }
    for (const f of pages) { // pages/foo.vue wraps pages/foo/* (<NuxtPage />)
      const d = f.replace(/\.(vue|[jt]sx)$/, '');
      const members = out.routes.filter((r) => under(d, r.file));
      if (members.length) out.layouts.push({ file: f, root: false, members });
    }
    for (const f of inApp.filter((f) => under(src + 'layouts', f))) {
      const name = P.basename(f).replace(/\.vue$/, '');
      if (name === 'default') { out.shells.add(f); continue; }
      const re = new RegExp(`layout:\\s*['"]${name}['"]`);
      out.layouts.push({ file: f, root: false, members: out.routes.filter((r) => re.test(tree.read(r.file) || '')) });
    }
    for (const s of ['app.vue', 'app.config.ts']) if (tree.has(src + s)) out.shells.add(src + s);
    for (const f of inApp) if (under(A + 'server', f)) out.endpoints.add(f);
  } else if (fw === 'astro') {
    const root = A + 'src/pages';
    for (const f of inApp.filter((f) => under(root, f))) {
      if (/\.[cm]?[jt]s$/.test(f)) { out.endpoints.add(f); continue; }
      if (!/\.(astro|mdx?|html)$/.test(f)) continue;
      const segs = rel(f, root).replace(/\.(astro|mdx?|html)$/, '').split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      add(makeRoute(segs, f, fw));
    }
  } else if (fw === 'remix') {
    remixRoutes(tree, A, inApp, out);
  } else if (fw === 'html') {
    for (const f of inApp.filter((f) => /\.html?$/.test(f))) { // docs/index.html → /docs/
      const p = f.slice(A.length);
      add({ pattern: '/' + (/^index\.html?$/.test(P.basename(p)) ? (dirOf(p) ? dirOf(p) + '/' : '') : p), file: f, params: [] });
    }
  } else if (fw === 'spa') {
    configRoutes(tree, A, inApp, out, app.resolve);
  }
  return out;
}

// Remix / React Router v7 file routes (app/routes, flat-file convention), or an app/routes.ts config.
function remixRoutes(tree, A, inApp, out) {
  const root = A + 'app/routes';
  const cfgFile = ['app/routes.ts', 'app/routes.js'].map((f) => A + f).find(tree.has);
  const cfg = cfgFile && tree.read(cfgFile);
  for (const s of ['app/root.tsx', 'app/root.jsx', 'app/root.ts', 'app/root.js']) if (tree.has(A + s)) out.shells.add(A + s);
  if (cfg && !/flatRoutes\s*\(/.test(cfg)) { // route("path", "file") config
    out.shells.add(cfgFile);
    for (const m of cfg.matchAll(/\b(route|index|layout)\(\s*(?:['"]([^'"]*)['"]\s*,\s*)?['"]([^'"]+)['"]/g)) {
      const file = norm(P.join(A + 'app', m[3]));
      if (m[1] === 'layout') { out.shells.add(file); continue; }
      const p = m[1] === 'index' ? '' : m[2] || '';
      addRoute(configPattern(p), file, out);
    }
    return;
  }
  const entries = [];
  for (const f of inApp.filter((f) => under(root, f) && PAGE_EXT.test(f))) {
    const parts = f.slice(root.length + 1).split('/');
    let name;
    if (parts.length === 1) name = parts[0].replace(PAGE_EXT, '');
    else if (parts.length === 2 && /^route\./.test(parts[1])) name = parts[0];
    else continue; // colocated module in a folder route
    const src = tree.read(f);
    if (src !== null && !/export\s+default\b/.test(src)) { out.endpoints.add(f); continue; } // resource route
    const raw = name.match(/(\[[^\]]*\]|[^.])+/g) || [];
    const segs = [];
    for (const r of raw) {
      if (r === '_index') continue;
      if (r.startsWith('_')) continue; // pathless layout
      let s = r.endsWith('_') ? r.slice(0, -1) : r;
      if (/^\(.*\)$/.test(s)) continue; // optional segment
      if (s === '$') s = '[...splat]';
      else if (s.startsWith('$')) s = `[${s.slice(1)}]`;
      else s = s.replace(/\[([^\]]*)\]/g, '$1');
      segs.push(s);
    }
    const pattern = '/' + segs.join('/');
    entries.push({ raw, route: { pattern, file: f, params: [...pattern.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]) } });
  }
  for (const e of entries) out.routes.push(e.route);
  for (const e of entries) { // concerts.tsx wraps concerts.$city.tsx, concerts._index.tsx…
    if (e.raw[e.raw.length - 1] === '_index') continue;
    const members = entries.filter((o) => o !== e && o.raw.length > e.raw.length && e.raw.every((x, i) => o.raw[i] === x)).map((o) => o.route);
    if (members.length) out.layouts.push({ file: e.route.file, root: false, members });
  }
}

// "/users/:id" style config path → route.
function configPattern(p) {
  const segs = String(p).split('/').filter(Boolean).flatMap((s) => {
    if (s === '*' || s === '**') return ['[...splat]'];
    if (/^:\w+\?$/.test(s)) return [];
    if (s.startsWith(':')) return [`[${s.slice(1).replace(/\(.*$/, '')}]`];
    return [s];
  });
  return '/' + segs.join('/');
}
function addRoute(pattern, file, out) {
  if (out.routes.some((r) => r.pattern === pattern && r.file === file)) return;
  out.routes.push({ pattern, file, params: [...pattern.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]) });
}

// SPA router config (react-router, vue-router, Angular, TanStack): string paths, mapped to
// their component's file when it can be resolved, else to the router file. Best effort:
// nested child paths are taken as top-level.
const ROUTER = /createBrowserRouter|createHashRouter|createMemoryRouter|createRouter\s*\(|<Route\b|RouterModule|:\s*Routes\s*=|createRoute\s*\(|routes\s*[:=]\s*\[/;
function configRoutes(tree, A, inApp, out, resolve) {
  for (const s of ['index.html', 'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js',
    'src/App.tsx', 'src/App.jsx', 'src/App.vue', 'src/App.svelte', 'src/app/app.component.ts', 'src/app/app.component.html']) if (tree.has(A + s)) out.shells.add(A + s);
  for (const f of inApp.filter((f) => /\.(jsx?|tsx?|vue)$/.test(f) && !/\.(test|spec|stories)\./.test(f))) {
    const src = tree.read(f) || '';
    if (!ROUTER.test(src)) continue;
    const hits = [...src.matchAll(/\bpath\s*[:=]\s*\{?\s*['"`]([^'"`]*)['"`]/g)];
    if (!hits.length) continue;
    out.shells.add(f);
    hits.forEach((m, i) => {
      if (/^\*+$/.test(m[1])) return;
      const win = src.slice(m.index, hits[i + 1] ? hits[i + 1].index : m.index + 400);
      let file = null;
      const dyn = win.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
      const id = win.match(/\b(?:component|Component|element|loadComponent)\s*[:=]\s*\{?\s*<?\s*([A-Z][\w$]*)/);
      if (dyn) file = resolve(dyn[1], f);
      else if (id) {
        const n = id[1];
        const im = src.match(new RegExp(`import\\s+(?:${n}\\b|[^'";]*\\{[^}]*\\b${n}\\b[^}]*\\})[^'";]*from\\s*['"]([^'"]+)['"]`)) ||
          src.match(new RegExp(`\\b${n}\\s*=\\s*(?:React\\.)?(?:lazy|defineAsyncComponent)\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*['"]([^'"]+)['"]`));
        if (im) file = resolve(im[1], f);
      }
      if (file && file.startsWith('pkg:')) file = null;
      addRoute(configPattern(m[1]), file || f, out);
    });
  }
  if (!out.routes.length) { // no router: one page
    const entry = [...out.shells][0];
    if (entry) addRoute('/', entry, out);
  }
}

// --- mapping changes to routes ------------------------------------------------------
function exampleFor(route, cfg, known) {
  const rp = cfg.routeParams || {};
  const byRoute = rp[route.pattern];
  if (byRoute) return { path: [].concat(byRoute)[0], how: 'routeParams' };
  if (route.params.every((p) => rp[p] != null)) {
    return { path: route.pattern.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (m, p) => String([].concat(rp[p])[0])), how: 'routeParams' };
  }
  const re = new RegExp('^' + route.pattern.split(/(\[[^\]]+\])/).map((x) =>
    x.startsWith('[...') ? '.+' : x.startsWith('[') ? '[^/]+' : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '/?$');
  const hit = known.find((k) => re.test(k.split(/[?#]/)[0]));
  return hit ? { path: hit, how: 'known route' } : null;
}

function pickRoutes({ head, base, changed, cfg = {}, appDir, max, known = [] }) {
  changed = [...new Set(changed.map(norm).filter((f) => f && f !== '.'))];
  const packages = workspacePackages(head.files, head.read);
  const resolve = createResolver(head.read, packages);
  const app = { ...findApp(head, appDir ?? cfg.appDir, changed), resolve };
  const H = discover(head, app);
  // Base: from its file list only (removed pages, endpoints); SPA router configs aren't re-read.
  const B = base && app.framework !== 'spa' ? discover({ ...base, read: () => null }, app) : { routes: [], layouts: [], shells: new Set(), endpoints: new Set() };
  const byFile = (routes) => routes.reduce((m, r) => m.set(r.file, [...(m.get(r.file) || []), r]), new Map());
  const headRoutes = byFile(H.routes);
  const baseRoutes = byFile(B.routes);
  const headPatterns = new Set(H.routes.map((r) => r.pattern));
  const layouts = new Map(H.layouts.map((l) => [l.file, l]));

  const hits = new Map(); // pattern → {route, score, reasons}
  const needs = new Map();
  const globals = [];
  const unmatched = [], ignored = [];
  const knownPaths = [...known, ...(cfg.routes || []).map((r) => (typeof r === 'string' ? r : r.path))].filter(Boolean);
  const hit = (route, score, reason) => {
    if (route.params.length) {
      const ex = exampleFor(route, cfg, knownPaths);
      if (!ex) {
        const n = needs.get(route.pattern) || needs.set(route.pattern, { route: route.pattern, file: route.file, reasons: [] }).get(route.pattern);
        if (!n.reasons.includes(reason)) n.reasons.push(reason);
        return;
      }
      route = { ...route, path: ex.path };
      reason += ` (example from ${ex.how})`;
    }
    const p = route.path || route.pattern;
    const h = hits.get(p) || hits.set(p, { path: p, route, score: 0, reasons: [] }).get(p);
    if (!h.reasons.includes(reason)) h.reasons.push(reason);
    h.score = Math.max(h.score, score);
  };
  const hitLayout = (l, score, reason) => {
    if (l.root) globals.push(reason);
    else for (const r of l.members) hit(r, score, reason);
  };

  let importers = null;
  const mentions = new Map();
  const codeFiles = head.files.filter((f) => CODE_EXT.test(f));
  // Files that name `needle` (assets referenced by path, auto-imported Vue components by tag).
  const mentioning = (needle) => {
    if (!mentions.has(needle)) mentions.set(needle, codeFiles.filter((f) => needle.test(head.read(f) || '')));
    return mentions.get(needle);
  };
  const pkgOf = (f) => [...packages.values()].filter((d) => d && d !== app.dir && under(d, f)).sort((a, b) => b.length - a.length)[0];
  const importersOf = (f) => {
    importers = importers || importersMap(head.files, head.read, resolve);
    let list = [...(importers.get(f) || [])];
    let how = 'imports';
    if (!list.length && ASSET.test(f)) {
      const b = P.basename(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      list = mentioning(new RegExp(`[/'"(]${b}\\b`)).filter((x) => x !== f);
      how = 'references';
    }
    if (!list.length && /\.vue$/.test(f) && /(^|\/)components\//.test(f)) { // Nuxt / unplugin auto-imports
      const parts = f.replace(/\.vue$/, '').split(/(?:^|\/)components\//).pop().split('/').filter((x) => x !== 'index');
      const pascal = (s) => s.replace(/(^|[-_])(\w)/g, (m, x, c) => c.toUpperCase());
      const names = [...new Set([parts.map(pascal).join(''), pascal(parts[parts.length - 1])])];
      const kebab = names.map((n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
      list = mentioning(new RegExp(`<(${[...names, ...kebab].join('|')})[\\s/>]`)).filter((x) => x !== f);
      how = 'uses';
    }
    if (!list.length) { // top of a workspace package: whoever imports the package
      const d = pkgOf(f);
      if (d) list = [...(importers.get('pkg:' + d) || [])];
    }
    return { list, how };
  };

  // Walk importers upward from a changed file until reaching routes, layouts or the app shell.
  const trace = (f) => {
    const seen = new Set([f]);
    let frontier = [{ file: f, chain: [] }];
    let found = false;
    for (let depth = 1; depth <= 6 && frontier.length && seen.size < 3000; depth++) {
      const next = [];
      for (const n of frontier) {
        const { list, how } = importersOf(n.file);
        for (const imp of list) {
          if (seen.has(imp)) continue;
          seen.add(imp);
          const via = n.chain.length ? ` via ${n.chain.slice(-2).reverse().join(' ← ')}` : '';
          const reason = `${how} ${f}${via}`;
          const l = layouts.get(imp);
          if (headRoutes.has(imp)) for (const r of headRoutes.get(imp)) hit(r, Math.max(0.35, 0.95 - 0.1 * (depth - 1)), reason);
          if (l && !l.root) hitLayout(l, Math.max(0.3, 0.7 - 0.05 * (depth - 1)), `layout ${imp} ${reason}`);
          else if (l || H.shells.has(imp)) globals.push(`${f} (used by ${imp})`);
          if (headRoutes.has(imp) || l || H.shells.has(imp)) found = true;
          if (!headRoutes.has(imp) && !l) next.push({ file: imp, chain: [...n.chain, imp] });
        }
      }
      frontier = next;
    }
    return found;
  };

  for (const f of changed) {
    const isNew = base && !base.has(f);
    if (H.endpoints.has(f) || B.endpoints.has(f)) ignored.push(f);
    else if (headRoutes.has(f)) {
      for (const r of headRoutes.get(f)) hit(r, 1, isNew ? `new page ${f}` : `page ${f} changed`);
      if (layouts.has(f)) hitLayout(layouts.get(f), 0.75, `parent page ${f} changed`); // Nuxt/Remix parent routes
    }
    else if (baseRoutes.has(f) && !head.has(f)) {
      for (const r of baseRoutes.get(f)) if (!headPatterns.has(r.pattern)) hit(r, 0.9, `page removed (${f})`);
    } else if (layouts.has(f)) hitLayout(layouts.get(f), 0.75, `layout ${f} changed`);
    else if (H.shells.has(f)) globals.push(`${f} changed`);
    else if (NON_UI.some((re) => re.test(f)) || !head.has(f)) ignored.push(f);
    else if (!trace(f)) {
      if (GLOBAL.test(f)) globals.push(`${f} changed (app-wide styles)`);
      else if (UI_EXT.test(f)) unmatched.push(f);
      else ignored.push(f);
    }
  }

  // App-wide change: home plus the most-linked, shallowest static pages.
  if (globals.length) {
    const statics = H.routes.filter((r) => !r.params.length);
    const appFiles = codeFiles.filter((f) => !app.dir || under(app.dir, f));
    const links = (p) => { // how often the app links to it
      if (p === '/') return Infinity;
      const re = new RegExp(`["'\`=]/?${p.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?["'\`\\s>?#]`, 'g');
      return appFiles.reduce((n, f) => n + ((head.read(f) || '').match(re) || []).length, 0);
    };
    const ranked = [...new Map(statics.map((r) => [r.pattern, r])).values()]
      .map((r) => ({ r, n: links(r.pattern), d: r.pattern.split('/').length }))
      .sort((a, b) => b.n - a.n || a.d - b.d || a.r.pattern.localeCompare(b.r.pattern))
      .slice(0, GLOBAL_PICKS + 1);
    const why = `app-wide change: ${globals[0]}${globals.length > 1 ? ` (+${globals.length - 1} more)` : ''}`;
    ranked.forEach(({ r }, i) => hit(r, (r.pattern === '/' ? 0.65 : 0.58) - 0.02 * i, why));
  }

  const all = [...hits.values()].map((h) => ({ ...h, score: Math.min(1, h.score + 0.02 * (h.reasons.length - 1)) }))
    .sort((a, b) => b.score - a.score || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const cap = Number(max || cfg.maxRoutes || 8);
  const label = (s) => (s >= 0.8 ? 'high' : s >= 0.5 ? 'medium' : 'low');
  return {
    framework: app.framework,
    appDir: app.dir || '.',
    routes: all.slice(0, cap).map((h) => ({ path: h.path, reasons: h.reasons, confidence: label(h.score) })),
    needsExample: [...needs.values()],
    unmatched,
    ignored,
    omitted: all.slice(cap).map((h) => h.path),
  };
}

// --- CLI ------------------------------------------------------------------------------
function main() {
  const a = args();
  let root = a.root;
  if (!root) { try { root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim(); } catch { root = process.cwd(); } }
  root = path.resolve(root);
  const cfgPath = a.config || path.join(root, '.ui-diff.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const head = dirTree(root);
  let base = null, changed;
  const mb = typeof a.base === 'string' ? git(root, ['merge-base', a.base, typeof a.head === 'string' ? a.head : 'HEAD']).trim() : null;
  if (typeof a['base-root'] === 'string') base = dirTree(path.resolve(a['base-root']));
  else if (mb) base = refTree(root, mb);
  if (typeof a.changed === 'string') changed = fs.readFileSync(a.changed === '-' ? 0 : a.changed, 'utf8').split('\n');
  else if (mb) {
    changed = typeof a.head === 'string'
      ? git(root, ['diff', '--name-only', '--no-renames', mb, a.head]).split('\n')
      : [...git(root, ['diff', '--name-only', '--no-renames', mb]).split('\n'), ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')];
  } else {
    console.error('Need --base <ref> (or --changed <file>)');
    process.exit(1);
  }
  const res = pickRoutes({
    head, base, changed, cfg, appDir: typeof a['app-dir'] === 'string' ? a['app-dir'] : undefined, max: a.max,
    known: typeof a.routes === 'string' ? a.routes.split(',').map((s) => s.trim()).filter(Boolean) : [],
  });
  if (a.log) {
    const log = (s) => console.error(`› ${s}`);
    log(`routes from the diff (${res.framework || 'unknown framework'}${res.appDir !== '.' ? ` in ${res.appDir}` : ''}):`);
    for (const r of res.routes) log(`  ${r.path} [${r.confidence}] ${r.reasons.slice(0, 2).join('; ')}${r.reasons.length > 2 ? ` (+${r.reasons.length - 2})` : ''}`);
    if (res.omitted.length) log(`  also affected, over the cap: ${res.omitted.join(', ')}`);
    for (const n of res.needsExample) log(`  ${n.route} needs an example value (add routeParams to .ui-diff.json): ${n.reasons[0]}`);
    if (res.unmatched.length) log(`  no route found for: ${res.unmatched.join(', ')}`);
  }
  console.log(a.print ? res.routes.map((r) => r.path).join(',') : JSON.stringify(res, null, 2));
}

module.exports = { pickRoutes, discover, findApp, makeTree, configPattern };
if (require.main === module) main();
