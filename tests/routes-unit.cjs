#!/usr/bin/env node
// Unit cases for routes.cjs (changed files → routes). Run by selftest.sh; prints ✓/✗ per case.
//
// Usage: node routes-unit.cjs <skills/ui-diff/scripts dir> <tests/fixtures/routes dir>
const fs = require('fs');
const path = require('path');

const [S, FIX] = process.argv.slice(2).map((p) => path.resolve(p));
const { pickRoutes, makeTree } = require(path.join(S, 'routes.cjs'));
const walkTree = (dir) => { // a fixture dir as a tree
  const files = [];
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const f = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(f); else files.push(f);
    }
  };
  go('');
  return makeTree(files, (f) => fs.readFileSync(path.join(dir, f), 'utf8'));
};
const mem = (obj) => makeTree(Object.keys(obj), (f) => obj[f]);

let failed = 0;
// check(desc, tree, changed, expected paths (in order unless sorted:true), extra (res) => bool, opts)
function check(desc, tree, changed, want, extra = () => true, opts = {}) {
  let res, ok;
  try {
    res = pickRoutes({ head: tree, changed, ...opts });
    const got = res.routes.map((r) => r.path);
    ok = (want === null || JSON.stringify(opts.sorted ? [...got].sort() : got) === JSON.stringify(want)) && extra(res);
  } catch (e) { res = { error: e.stack }; ok = false; }
  console.log(`  ${ok ? '✓' : '✗'} ${desc}${ok ? '' : `\n      want ${JSON.stringify(want)}\n      got ${JSON.stringify(res, null, 1).slice(0, 1500)}`}`);
  if (!ok) failed++;
}
const paths = (res) => res.routes.map((r) => r.path);

// --- fixtures on disk -----------------------------------------------------------------
const next = walkTree(path.join(FIX, 'next-app'));
check('next: page file → its route', next, ['src/app/pricing/page.tsx'], ['/pricing'], (r) => r.framework === 'next' && r.routes[0].confidence === 'high');
check('next: @/ alias (tsconfig paths) two levels up → /pricing; dynamic route needs an example', next, ['src/components/Button.tsx'], ['/pricing'],
  (r) => r.needsExample.length === 1 && r.needsExample[0].route === '/blog/[slug]' && r.routes[0].reasons[0].includes('via src/components/PricingTable.tsx'));
check('next: routeParams by name fills the dynamic route', next, ['src/components/Button.tsx'], ['/blog/hello-world', '/pricing'],
  (r) => !r.needsExample.length, { cfg: { routeParams: { slug: 'hello-world' } } });
check('next: a known route (config routes) is used as the example', next, ['src/app/blog/[slug]/page.tsx'], ['/blog/first-post'],
  () => true, { cfg: { routes: ['/', { path: '/blog/first-post' }] } });
check('next: CSS module → component → pages', next, ['src/components/Button.module.css'], ['/pricing']);
check('next: nested layout → every route under it', next, ['src/app/dashboard/layout.tsx'], ['/dashboard', '/dashboard/settings']);
check('next: route group (marketing) and @slot are dropped from the path', next, ['src/app/(marketing)/about/page.tsx', 'src/app/@modal/login/page.tsx'], ['/about', '/login'], () => true, { sorted: true });
check('next: group layout covers the group\'s routes', next, ['src/app/(marketing)/layout.tsx'], ['/about', '/careers'], () => true, { sorted: true });
check('next: API route, test, README → nothing, listed as ignored', next, ['src/app/api/health/route.ts', 'README.md', 'src/components/Button.test.tsx'], [],
  (r) => r.ignored.length === 3);
check('next: global CSS (via the root layout) → home + most-linked pages', next, ['src/app/globals.css'], null,
  (r) => paths(r)[0] === '/' && paths(r)[1] === '/pricing' && r.routes.length === 4 && r.routes[0].reasons[0].includes('app-wide'));
check('next: tailwind config → the same representative set', next, ['tailwind.config.ts'], null, (r) => paths(r)[0] === '/' && r.routes.length === 4);
check('next: private _folder and unimported file → unmatched', next, ['src/lib/format.ts', 'src/app/_components/Private.tsx'], [], (r) => r.unmatched.length === 2);
check('next: cap (max) keeps the highest-confidence routes', next, ['src/app/pricing/page.tsx', 'src/app/globals.css'], ['/pricing'], (r) => r.omitted.includes('/'), { max: 1 });

const kit = walkTree(path.join(FIX, 'sveltekit'));
check('sveltekit: $lib component → pages importing it; [slug=matcher] needs an example', kit, ['src/lib/Card.svelte'], ['/about'], (r) => r.framework === 'sveltekit' && r.needsExample[0].route === '/blog/[slug]');
check('sveltekit: +page.ts in a (group) → its route; +server.ts ignored', kit, ['src/routes/(app)/settings/+page.ts', 'src/routes/api/+server.ts'], ['/settings'], (r) => r.ignored.length === 1);
check('sveltekit: app.css via the root +layout → home first', kit, ['src/app.css'], null, (r) => paths(r)[0] === '/' && paths(r).length === 3);

const mono = walkTree(path.join(FIX, 'monorepo'));
check('monorepo: picks apps/web (named by the root dev script); package entry in dist/ mapped to src/', mono, ['packages/ui/src/index.ts'], ['/', '/pricing'],
  (r) => r.appDir === 'apps/web' && r.framework === 'next', { sorted: true });
check('monorepo: workspace package by name, through its index', mono, ['packages/ui/src/Button.tsx'], ['/', '/pricing'], () => true, { sorted: true });
check('monorepo: subpath export (@acme/ui/card) → that page first, then the index re-export\'s', mono, ['packages/ui/src/card.tsx'], ['/pricing', '/'],
  (r) => r.routes[1].reasons[0].includes('via packages/ui/src/index.ts'));
check('monorepo: CSS imported inside the package', mono, ['packages/ui/src/button.css'], ['/', '/pricing'], () => true, { sorted: true });
check('monorepo: configured appDir (Astro docs app)', mono, ['apps/docs/src/layouts/Base.astro', 'packages/ui/src/Button.tsx'], ['/'],
  (r) => r.framework === 'astro' && r.unmatched.includes('packages/ui/src/Button.tsx'), { cfg: { appDir: 'apps/docs' } });

const html = walkTree(path.join(FIX, 'html'));
check('html: stylesheet → pages that link it (relative, bare and /absolute hrefs)', html, ['style.css'], ['/', '/about.html', '/docs/'], (r) => r.framework === 'html', { sorted: true });
check('html: CSS @import chain (fonts.css ← docs.css ← docs pages)', html, ['fonts.css'], ['/docs/', '/docs/guide.html'], () => true, { sorted: true });
check('html: changed page → itself; unlinked page untouched', html, ['contact.html', 'js/app.js'], ['/contact.html', '/docs/guide.html'], () => true, { sorted: true });

// --- in-memory trees for the other conventions -----------------------------------------
const pkg = (deps) => JSON.stringify({ scripts: { dev: 'x' }, dependencies: deps });
const pagesRouter = mem({
  'package.json': pkg({ next: '14' }), 'src/pages/_app.tsx': 'import "../styles/globals.css";', 'src/pages/_document.tsx': '',
  'src/pages/index.tsx': 'export default 1', 'src/pages/blog/index.tsx': 'import Nav from "../../components/Nav"', 'src/pages/blog/[id].tsx': '',
  'src/pages/api/hello.ts': '', 'src/components/Nav.tsx': '', 'src/styles/globals.css': '',
});
check('next pages router (src/): index → folder, [id] dynamic, api ignored', pagesRouter, ['src/pages/blog/index.tsx', 'src/pages/blog/[id].tsx', 'src/pages/api/hello.ts'], ['/blog'],
  (r) => r.needsExample[0].route === '/blog/[id]' && r.ignored.includes('src/pages/api/hello.ts'));
check('next pages router: _app → app-wide', pagesRouter, ['src/styles/globals.css'], null, (r) => paths(r)[0] === '/' && paths(r).includes('/blog'));
check('next pages router: component relative import', pagesRouter, ['src/components/Nav.tsx'], ['/blog']);

const nuxt = mem({
  'package.json': pkg({ nuxt: '3' }), 'app.vue': '<NuxtLayout><NuxtPage/></NuxtLayout>', 'layouts/default.vue': '<slot/>',
  'layouts/admin.vue': '<slot/>', 'pages/index.vue': '<AppHeader/>', 'pages/users.vue': '<NuxtPage/>', 'pages/users/index.vue': '',
  'pages/users/[id].vue': '', 'pages/admin/index.vue': "<script setup>definePageMeta({ layout: 'admin' })</script>",
  'components/app/Header.vue': '<header/>', 'server/api/x.ts': '',
});
check('nuxt: auto-imported component by tag name (<AppHeader>)', nuxt, ['components/app/Header.vue'], ['/']);
check('nuxt: parent page wraps its children; named layout → pages using it', nuxt, ['pages/users.vue', 'layouts/admin.vue', 'server/api/x.ts'], ['/users', '/admin'],
  (r) => r.needsExample[0].route === '/users/[id]' && r.ignored.includes('server/api/x.ts'), { sorted: false });

const astro = mem({
  'package.json': pkg({ astro: '5' }), 'src/pages/index.astro': '---\nimport Base from "../layouts/Base.astro";\n---', 'src/pages/blog/[...slug].astro': '',
  'src/pages/_draft.astro': '', 'src/pages/rss.xml.ts': '', 'src/pages/about.md': '---\nlayout: ../layouts/Base.astro\n---', 'src/layouts/Base.astro': '<slot/>',
});
check('astro: .md page, endpoint ignored, _draft skipped, [...slug] needs an example', astro,
  ['src/pages/about.md', 'src/pages/rss.xml.ts', 'src/pages/_draft.astro', 'src/pages/blog/[...slug].astro'], ['/about'],
  (r) => r.ignored.includes('src/pages/rss.xml.ts') && r.needsExample[0].route === '/blog/[...slug]', { cfg: {} });
check('astro: catch-all filled from routeParams by route', astro, ['src/pages/blog/[...slug].astro'], ['/blog/2024/hello'], () => true, { cfg: { routeParams: { '/blog/[...slug]': '/blog/2024/hello' } } });

const remix = mem({
  'package.json': pkg({ '@remix-run/react': '2' }), 'app/root.tsx': 'export default 1', 'app/routes/_index.tsx': 'export default 1',
  'app/routes/concerts.tsx': 'export default 1', 'app/routes/concerts.$city.tsx': 'export default 1', 'app/routes/concerts.trending.tsx': 'export default 1',
  'app/routes/concerts_.mine.tsx': 'export default 1', 'app/routes/_auth.login.tsx': 'export default 1', 'app/routes/healthz.ts': 'export const loader = 1',
  'app/routes/about/route.tsx': 'import { Card } from "./card"; export default 1', 'app/routes/about/card.tsx': '', 'app/routes/sitemap[.]xml.tsx': 'export default 1',
});
check('remix: flat routes (_index, dots, $param, pathless _auth, folder route + colocated module)', remix,
  ['app/routes/_index.tsx', 'app/routes/_auth.login.tsx', 'app/routes/about/card.tsx', 'app/routes/concerts.$city.tsx', 'app/routes/sitemap[.]xml.tsx'], ['/', '/about', '/login', '/sitemap.xml'],
  (r) => r.framework === 'remix' && r.needsExample[0].route === '/concerts/[city]', { sorted: true });
check('remix: parent route is a layout for its children (not for concerts_.mine); resource route ignored', remix,
  ['app/routes/concerts.tsx', 'app/routes/healthz.ts'], ['/concerts', '/concerts/trending'], (r) => r.ignored.includes('app/routes/healthz.ts'), { sorted: true });

const rr7 = mem({
  'package.json': pkg({ '@react-router/dev': '7' }), 'app/root.tsx': '',
  'app/routes.ts': 'export default [index("routes/home.tsx"), route("pricing", "routes/pricing.tsx"), route("users/:id", "routes/user.tsx")];',
  'app/routes/home.tsx': '', 'app/routes/pricing.tsx': 'import P from "../components/Plan";', 'app/routes/user.tsx': '', 'app/components/Plan.tsx': '',
});
check('react router v7 routes.ts config', rr7, ['app/routes/home.tsx', 'app/components/Plan.tsx', 'app/routes/user.tsx'], ['/', '/pricing'], (r) => r.needsExample[0].route === '/users/[id]', { sorted: true });

const reactSpa = mem({
  'package.json': pkg({ react: '19', 'react-router-dom': '6', vite: '6' }), 'index.html': '<script src="/src/main.tsx"></script>',
  'src/main.tsx': 'import { router } from "./router";', 'src/router.tsx': 'import Home from "./pages/Home";\nimport { Settings } from "./pages/Settings";\nconst Docs = lazy(() => import("./pages/Docs"));\nexport const router = createBrowserRouter([\n { path: "/", element: <Home /> },\n { path: "/settings", element: <Settings /> },\n { path: "/docs", element: <Docs /> },\n { path: "/users/:id", element: <Home /> },\n { path: "*", element: <Home /> } ]);',
  'src/pages/Home.tsx': '', 'src/pages/Settings.tsx': 'import { Toggle } from "../ui/Toggle";', 'src/pages/Docs.tsx': '', 'src/ui/Toggle.tsx': '',
});
check('react-router config: component resolved from imports and lazy(); :id needs an example', reactSpa, ['src/ui/Toggle.tsx', 'src/pages/Docs.tsx'], ['/docs', '/settings'],
  (r) => r.framework === 'spa', { sorted: true });
check('react SPA: main.tsx (shell) → app-wide', reactSpa, ['src/main.tsx'], null, (r) => paths(r)[0] === '/');

const vue = mem({
  'package.json': pkg({ vue: '3', 'vue-router': '4' }), 'src/router/index.ts': "import About from '../views/About.vue'\nexport default createRouter({ routes: [ { path: '/', component: () => import('../views/Home.vue') }, { path: '/about', component: About } ] })",
  'src/views/Home.vue': '', 'src/views/About.vue': '<script setup>import Badge from "@/components/Badge.vue"</script>', 'src/components/Badge.vue': '',
});
check('vue-router config + @/ alias without tsconfig', vue, ['src/components/Badge.vue', 'src/views/Home.vue'], ['/', '/about'], () => true, { sorted: true });

const plainVite = mem({ 'package.json': pkg({ react: '19', vite: '6' }), 'index.html': '<script type="module" src="/src/main.jsx"></script>', 'src/main.jsx': 'import App from "./App"', 'src/App.jsx': 'import "./App.css"', 'src/App.css': '' });
check('SPA without a router → "/"', plainVite, ['src/App.css'], ['/']);

// Removed pages: base has a route head doesn't.
const baseTree = mem({ 'package.json': pkg({ next: '15' }), 'app/page.tsx': '', 'app/old/page.tsx': '' });
const headTree = mem({ 'package.json': pkg({ next: '15' }), 'app/page.tsx': '', 'app/new/page.tsx': '' });
check('removed page (only on base) and new page are both picked', headTree, ['app/old/page.tsx', 'app/new/page.tsx'], ['/new', '/old'],
  (r) => r.routes.some((x) => x.reasons[0].startsWith('page removed')) && r.routes.some((x) => x.reasons[0].startsWith('new page')), { base: baseTree, sorted: true });

process.exit(failed ? 1 : 0);
