# Mapping changed files to routes

The goal: from `git diff --name-only <base>...<head>`, decide which URLs to screenshot.
Screenshot too few and you miss the change; too many and the run is slow and the report noisy.
Aim for every route that renders a changed file, plus at most a couple of "canary" pages
(e.g. home) when a global file changed.

## Classify changed files first

| Kind | Examples | What to capture |
|---|---|---|
| Page/route file | `app/settings/page.tsx`, `pages/about.vue`, `src/routes/blog/+page.svelte` | That route |
| Layout / shell | `app/layout.tsx`, `app/(dash)/layout.tsx`, `+layout.svelte`, `App.tsx`, `_app.tsx` | 2–3 representative routes under that layout |
| Shared component | `components/Button.tsx` | Routes that import it (see below) |
| Global styles / tokens | `globals.css`, `tailwind.config.*`, `theme.ts`, `tokens.json`, CSS variables | Home + 2–3 of the most-used pages; consider adding dark mode |
| Copy / i18n | `locales/en.json`, `messages/*.json` | Routes that use the changed keys (grep the key) |
| Assets | `public/*.svg`, images, fonts | Pages that reference them (grep the filename) |
| Non-UI | tests, API handlers, config unrelated to rendering, docs | Nothing |

If *only* non-UI files changed, tell the user there's nothing visual to diff and stop.

## Find which routes use a shared component

Walk imports upward until you hit route files:

```bash
grep -rlE "from ['\"][^'\"]*/Button['\"]" src app pages components --include='*.{ts,tsx,js,jsx,vue,svelte}'
```

Repeat for each importer that is itself a component (2–3 levels is usually enough). Stop
early if it fans out to dozens of routes — pick a handful of representative ones instead and
say so in the report.

## Route file conventions by framework

- **Next.js App Router**: `app/**/page.{tsx,jsx,js}`. Path = folder path; drop `(groups)`
  and `@slots`; `[id]` / `[...slug]` are dynamic (see below).
- **Next.js Pages Router**: `pages/**/*.{tsx,jsx}` minus `_app`, `_document`, `api/`.
  `index` = folder root.
- **Remix / React Router v7 (file routes)**: `app/routes/*`; dots become slashes,
  `_index` = root, `$param` is dynamic, leading `_` segments are pathless layouts.
- **React Router (config)**: grep for `createBrowserRouter`, `<Route path=` or `routes.ts`.
- **SvelteKit**: `src/routes/**/+page.svelte`; `[param]` dynamic, `(group)` dropped.
- **Nuxt**: `pages/**/*.vue`; `[id].vue` dynamic, `index.vue` = folder root.
- **Vue Router (config)**: grep `createRouter` / `routes: [`.
- **Astro**: `src/pages/**/*.{astro,md,mdx}`.
- **Angular**: grep `Routes = [` in `*.routes.ts` / `app-routing.module.ts`.
- **Plain HTML / static**: each `.html` file is a route.

## Dynamic routes

A route like `/users/[id]` needs a real value. In order of preference:
1. A value already in `.ui-diff.json` (`routes: [{ "path": "/users/42" }]`).
2. A fixture/seed/mock id you can find in the repo (grep seeds, MSW handlers, Storybook args).
3. Load the parent list page in the running app and pick the first link.
4. Ask the user.

## Non-route UI (modals, hover/open states, wizard steps)

A plain page load won't show a modal or an open dropdown. Note this in the report
("the change to `ConfirmDialog` isn't visible on any initial page load") rather than
silently reporting "no change". If it matters, the user can add a `route` with `actions`
to `.ui-diff.json` (see `config.md`).
