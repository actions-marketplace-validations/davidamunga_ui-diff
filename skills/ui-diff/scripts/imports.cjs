// Find and follow a project's local imports: relative paths, tsconfig/jsconfig `paths`
// (with `extends` and `baseUrl`), the usual @/ ~/ $lib/ aliases, and workspace packages
// by name (monorepos). Shared by stories.cjs and routes.cjs.
//
// Everything works on a "tree": read(file) → text or null, with repo-relative posix paths,
// so the same code runs on a checkout, a fixture dir or a git commit.
const P = require('path').posix;

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs|mts|cts|vue|svelte|astro|css|scss|sass|less|styl|html?|mdx?)$/i;
const TRY_EXT = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less',
  '/index.tsx', '/index.ts', '/index.jsx', '/index.js', '/index.mjs', '/index.vue', '/index.svelte', '/index.astro'];

const norm = (f) => P.normalize(String(f).trim().replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');

// JSON with comments and trailing commas (tsconfig.json) → object, or null.
function parseJsonc(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1'));
  } catch { return null; }
}

// Import specifiers in a source file: ES/CJS imports, CSS @import/@use/url(), HTML <link>/<script>/<img>.
function specifiers(src, file = '') {
  const out = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]|url\(\s*['"]?([^'")\s]+?)['"]?\s*\)/g;
  for (const m of src.matchAll(re)) out.push(m[1] || m[2] || m[3] || m[4] || m[5]);
  if (/\.(html?|astro|vue|svelte)$/i.test(file)) {
    const tag = /<(?:link\b[^>]*?\bhref|(?:script|img|source)\b[^>]*?\bsrc)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    for (const m of src.matchAll(tag)) out.push(m[1] || m[2] || m[3]);
  }
  return out.filter((s) => s && !/^(https?:|data:|#|mailto:|\/\/)/.test(s) && !s.includes('{'));
}

// read(file) → text|null. packages: Map name → dir (optional; see workspacePackages).
function createResolver(read, packages = new Map()) {
  const exists = new Map();
  const has = (f) => {
    if (!exists.has(f)) exists.set(f, read(f) !== null);
    return exists.get(f);
  };
  const tryFile = (base) => {
    base = norm(base);
    if (base.startsWith('..')) return null;
    const bases = [base];
    if (/\.(m?jsx?)$/.test(base)) bases.push(base.replace(/\.m?jsx?$/, '')); // "./x.js" written for x.ts
    for (const b of bases) for (const e of TRY_EXT) if (has(norm(b + e))) return norm(b + e);
    return null;
  };
  const memo = new Map();
  const up = (dir, test) => { // nearest ancestor dir (inclusive) where test(dir) is true, else null
    for (let d = dir; ; d = P.dirname(d)) {
      if (d === '.') d = '';
      if (test(d)) return d;
      if (!d) return null;
    }
  };
  const pkgRoot = (dir) => {
    const k = 'p:' + dir;
    if (!memo.has(k)) memo.set(k, up(dir, (d) => has(P.join(d, 'package.json'))) ?? '');
    return memo.get(k);
  };
  // {baseUrl, paths, pathsBase} from the nearest tsconfig.json / jsconfig.json (following relative extends).
  const loadCfg = (file, depth = 0) => {
    const j = parseJsonc(read(file)) || {};
    let res = { baseUrl: null, paths: null, pathsBase: null };
    for (const ext of [].concat(j.extends || [])) {
      if (depth > 3 || typeof ext !== 'string' || !ext.startsWith('.')) continue;
      const f = norm(P.join(P.dirname(file), ext));
      const parent = [f, f + '.json', f + '/tsconfig.json'].find(has);
      if (parent) res = { ...res, ...Object.fromEntries(Object.entries(loadCfg(parent, depth + 1)).filter(([, v]) => v != null)) };
    }
    const co = j.compilerOptions || {};
    if (co.baseUrl) res.baseUrl = norm(P.join(P.dirname(file), co.baseUrl));
    if (co.paths) { res.paths = co.paths; res.pathsBase = P.dirname(file); }
    return res;
  };
  const tsconfig = (dir) => {
    const k = 't:' + dir;
    if (!memo.has(k)) {
      const d = up(dir, (x) => has(P.join(x, 'tsconfig.json')) || has(P.join(x, 'jsconfig.json')));
      memo.set(k, d === null ? {} : loadCfg(P.join(d, has(P.join(d, 'tsconfig.json')) ? 'tsconfig.json' : 'jsconfig.json')));
    }
    return memo.get(k);
  };
  const pkgJson = (dir) => {
    const k = 'j:' + dir;
    if (!memo.has(k)) memo.set(k, parseJsonc(read(P.join(dir, 'package.json'))) || {});
    return memo.get(k);
  };
  const leaves = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : []);
  // A workspace package's entry (or a subpath of it) → source file; built output (dist/) mapped back to src/.
  const resolvePackage = (dir, sub) => {
    const pj = pkgJson(dir);
    const ex = pj.exports;
    let cands;
    if (!sub) {
      cands = [pj.source, ...leaves(typeof ex === 'string' || !ex || !Object.keys(ex).some((k) => k.startsWith('.')) ? ex : ex['.']), pj.module, pj.main, pj.svelte, 'src/index', 'index'];
    } else {
      cands = [];
      if (ex && typeof ex === 'object') {
        for (const [k, v] of Object.entries(ex)) {
          if (k === './' + sub) cands.push(...leaves(v));
          else if (k.includes('*')) {
            const [pre, post] = k.slice(2).split('*');
            if (sub.startsWith(pre) && sub.endsWith(post || '')) cands.push(...leaves(v).map((t) => t.replace('*', sub.slice(pre.length, sub.length - (post || '').length))));
          }
        }
      }
      cands.push(sub, 'src/' + sub);
    }
    for (const c of cands.filter((c) => typeof c === 'string')) {
      const hit = tryFile(P.join(dir, c)) ||
        tryFile(P.join(dir, c.replace(/^\.?\/?(dist|build|lib|out|esm|cjs)\//, 'src/').replace(/(\.d)?\.[cm]?[jt]sx?$/, '')));
      if (hit) return hit;
    }
    return 'pkg:' + dir; // can't see its source: depend on the package as a whole
  };
  const names = () => [...packages.keys()].sort((a, b) => b.length - a.length);

  return function resolve(spec, from) {
    spec = spec.split(/[?#]/)[0];
    if (!spec) return null;
    const dir = P.dirname(from) === '.' ? '' : P.dirname(from);
    if (spec.startsWith('.')) return tryFile(P.join(dir, spec));
    const root = pkgRoot(dir);
    if (spec.startsWith('/')) return tryFile(P.join(root, spec.slice(1))) || tryFile(P.join(root, 'public', spec.slice(1)));
    // In HTML and CSS a bare path ("style.css", url(img/x.png)) is relative.
    if (/\.(html?|css|scss|sass|less|styl)$/.test(from) && !spec.startsWith('@')) {
      const hit = tryFile(P.join(dir, spec));
      if (hit) return hit;
    }
    const ts = tsconfig(dir);
    if (ts.paths) {
      for (const [pat, targets] of Object.entries(ts.paths)) {
        const [pre, post = ''] = pat.split('*');
        const wild = pat.includes('*');
        if (wild ? !(spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) : spec !== pat) continue;
        const mid = wild ? spec.slice(pre.length, spec.length - post.length) : '';
        for (const t of [].concat(targets)) {
          const hit = tryFile(P.join(ts.baseUrl || ts.pathsBase, t.replace('*', mid)));
          if (hit) return hit;
        }
      }
    }
    const alias = spec.match(/^(@|~|~~|@@|\$lib)\/(.*)$/);
    if (alias) {
      const dirs = alias[1] === '$lib' ? ['src/lib'] : alias[1].length === 2 ? [''] : ['src', '', 'app'];
      for (const d of dirs) {
        const hit = tryFile(P.join(root, d, alias[2]));
        if (hit) return hit;
      }
    }
    for (const name of names()) {
      if (spec === name || spec.startsWith(name + '/')) return resolvePackage(packages.get(name), spec.slice(name.length + 1));
    }
    if (ts.baseUrl) return tryFile(P.join(ts.baseUrl, spec)); // "components/Button" with baseUrl "."
    return null;
  };
}

// Workspace packages in a file listing: Map package name → dir.
function workspacePackages(files, read) {
  const out = new Map();
  for (const f of files) {
    if (P.basename(f) !== 'package.json' || f.includes('node_modules/')) continue;
    const j = parseJsonc(read(f));
    if (j && j.name && !out.has(j.name)) out.set(j.name, P.dirname(f) === '.' ? '' : P.dirname(f));
  }
  return out;
}

// Resolved local imports of a file (files, or "pkg:<dir>" for a package whose source isn't found).
function importsOf(file, read, resolve = createResolver(read)) {
  const src = read(file);
  if (!src) return [];
  const out = new Set();
  for (const s of specifiers(src, file)) {
    const hit = resolve(s, file);
    if (hit && hit !== file) out.add(hit);
  }
  return [...out];
}

// Files `file` depends on (itself included), following local imports `depth` levels.
function closure(file, read, depth = 5, resolve = createResolver(read)) {
  const seen = new Set([file]);
  let frontier = [file];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) for (const i of importsOf(f, read, resolve)) if (!seen.has(i)) { seen.add(i); next.push(i); }
    frontier = next;
  }
  return seen;
}

// Reverse import graph over the code files in a listing: Map file → Set of files importing it.
function importersMap(files, read, resolve) {
  const importers = new Map();
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    for (const i of importsOf(f, read, resolve)) {
      if (!importers.has(i)) importers.set(i, new Set());
      importers.get(i).add(f);
    }
  }
  return importers;
}

module.exports = { CODE_EXT, norm, parseJsonc, specifiers, createResolver, workspacePackages, importsOf, closure, importersMap };
