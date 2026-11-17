# `.ui-diff.json` (optional, repo root)

Saves what you'd otherwise rediscover every run. Everything is optional.

```json
{
  "devCommand": "pnpm dev --port {port}",
  "install": "pnpm install --frozen-lockfile",
  "readyPath": "/",
  "copyFiles": [".env.local"],
  "routes": [
    "/",
    "/pricing",
    { "path": "/users/42", "name": "user-profile", "waitFor": "[data-testid=profile]" },
    { "path": "/settings", "name": "settings-delete-modal",
      "actions": [{ "click": "text=Delete account" }, { "wait": "[role=dialog]" }] }
  ],
  "viewports": { "desktop": { "width": 1440, "height": 900 }, "mobile": { "device": "iPhone 13" } },
  "colorSchemes": ["light", "dark"],
  "mask": ["[data-testid=timestamp]", ".avatar"],
  "hide": ["#intercom-container", ".cookie-banner"],
  "css": "",
  "fullPage": true,
  "settleMs": 300,
  "storageState": ".ui-diff/auth.json",
  "post": "comment"
}
```

| Key | Meaning |
|---|---|
| `devCommand` | Starts the app. `{port}` is replaced with a free port; `PORT` is also set in the env. Auto-detected from `package.json` when absent. |
| `install` | Install command for the base worktree when its lockfile differs from head's. |
| `readyPath` | Polled until it answers before capturing. |
| `copyFiles` | Extra untracked files to copy into the worktrees (untracked `.env*` files are copied automatically). |
| `routes` | Always-captured routes, on top of the ones inferred from the diff. Give a unique `name` when the same path appears twice (e.g. with different `actions`). |
| `actions` | Steps before the screenshot: `{click}`, `{hover}`, `{fill: [sel, value]}`, `{press: key}`, `{wait: ms or selector}`. |
| `viewports` | Name → `{width, height}` for a desktop window, or `{device: "<Playwright device>"}` (e.g. `"iPhone 13"`, `"Pixel 7"`, `"iPad Mini"`) for real mobile emulation: touch, mobile UA, `isMobile`. |
| `deviceScaleFactor` | Pixel density for all viewports (default 1 for desktop, the device's value capped at 2 for devices). |
| `mask` | Selectors painted over with a solid box on both sides (dynamic content: dates, avatars, random data). |
| `hide` | Selectors removed from screenshots (chat widgets, cookie banners). Framework dev overlays (Next.js indicator, Vite/webpack error overlays, Astro/Nuxt toolbars, TanStack devtools) are hidden automatically; if one was *showing an error*, that's reported as a warning instead. |
| `colorSchemes` | `["light"]` by default. Add `"dark"` if the app supports it. |
| `storageState` | Playwright auth state for pages behind login (see below). |
| `post` | Default destination: `"comment"`, `"description"` or `"manual"`. |

## Pages behind login

Create a saved session once, then point `storageState` at it:

```bash
npx --prefix ~/.cache/ui-diff playwright codegen --save-storage=.ui-diff/auth.json http://localhost:3000/login
```

Log in in the window that opens, then close it. `.ui-diff/` is git-ignored locally by the
skill, but double-check before committing anything: this file holds session cookies.

Use a test account with fake data. Screenshots of logged-in pages get pushed to the assets
branch, and in a public repo that makes them public.

## Noise control

When an unchanged page shows up as changed, it's almost always one of:
- **Dynamic data** (times, random ids, live API data) → add to `mask`.
- **Lazy images/fonts still loading** → add `waitFor` on the route or raise `settleMs`.
- **Carousels / auto-playing video** → `hide`, or `actions` to pause.
- **Different data in base vs head** (e.g. a migration in the PR) → expected; say so in the summary.
