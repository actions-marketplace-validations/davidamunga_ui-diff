---
name: ui-diff
description: Show the visual / UI / UX impact of a pull request. Renders the affected pages of a web app at the base and head commits, pixel-diffs the screenshots, measures exact style changes (colors, spacing, type, contrast), writes a plain-language summary for designers and reviewers, and posts before/after images to the PR as a comment or in the description. Use this whenever someone wants reviewers to *see* a frontend change — "add screenshots to my PR", "what does this PR look like", "visual diff", "before/after", "design review", "did my CSS change break anything", "show the UI changes", "visual regression check" — even if they don't say "UI diff" or "design diff". Works with any web app that runs on a local dev server (React, Next.js, Vue, Nuxt, Svelte, Angular, Astro, plain HTML).
compatibility: Needs bash, git and Node.js 18+; the GitHub CLI (gh, logged in) to post to PRs; python3 for plain-HTML sites. The first run downloads Playwright + Chromium (~150 MB) into ~/.cache/ui-diff. macOS or Linux.
metadata:
  author: davidamunga
  version: "0.1.0"
---

# UI diff

Reviewers can read a CSS diff, but they can't see it. This skill renders the app at the
PR's base and head, compares them, and puts before/after images on the PR. Alongside them
goes a short summary of what changed for users, backed by measured values.

The mechanical work is a single script. Your job is the parts that need judgment:
**which pages to check**, **what the changes mean**, and **where to post**.

`$SKILL` below means the directory that contains this `SKILL.md`. Set it once, e.g.
`SKILL=/path/to/skills/ui-diff`. Everything is written to `.ui-diff/` at the repo root,
which the script git-ignores locally, so nothing tracked changes.

## 1. Context

```bash
gh pr view --json number,url,baseRefName,headRefOid,body 2>/dev/null; git status --short
```

Read `.ui-diff.json` at the repo root if it exists. It may hold routes, the dev command,
masks and auth (see `references/config.md`).

**Which head to render** depends on what the user is doing:
- **Posting to a PR:** render exactly what's pushed by passing `--head <headRefOid>`.
  Otherwise uncommitted local edits end up in a report that claims to show the PR. If the
  working tree is dirty or has unpushed commits, mention that those changes won't appear.
- **Checking their work in progress** ("does this look right?"): use the working tree (the
  default, no `--head`). The report labels it "+ uncommitted changes".

## 2. Choose the pages

```bash
git diff --name-only <base>...HEAD
```

Map changed files to routes using `references/route-mapping.md`. If nothing UI-related
changed, say so and stop. Don't produce an empty report.

Tell the user in a line or two which routes you'll capture and why, then continue. Only ask
when you can't find any route, or when a dynamic route needs an id you can't find. Keep
track of routes that are **affected but not captured** (too many to check, needs a login,
a modal state). They go in the summary so "no visual change" isn't read as an all-clear.

## 3. Run it

```bash
bash $SKILL/scripts/run.sh --routes "/,/pricing" [--head <sha>] [--base <ref>] \
  [--viewports "desktop:1440x900,mobile:iPhone 13"] [--schemes light,dark] [--dev "<cmd with {port}>"]
```

In one go, it:
- installs the tools on first use (Playwright + Chromium in `~/.cache/ui-diff`, about a minute; the project's dependencies are untouched);
- checks out base, and head if `--head` is given, in git worktrees, and copies untracked `.env*` files into them;
- reuses installed dependencies when the lockfile matches, with per-checkout build caches, and installs otherwise;
- starts both dev servers on free ports in their own process groups. Only those are stopped
  afterwards, so the user's other servers are never touched;
- captures every route × viewport. Mobile uses real device emulation (touch, mobile UA).
  Animations are frozen and framework dev overlays are hidden;
- pixel-diffs the screenshots (`results.json`, full-page and zoomed images) and runs a computed-style diff (`measured.md`).

It prints counts like `{"changed":2,"added":1,"unchanged":3,...}`. Defaults: base = the PR's
base branch (else the default branch), viewports = desktop 1440×900 + iPhone 13, light mode.
Add `--schemes light,dark` when the change touches theme, colors or tokens.

**If it fails**, the error says which step failed and where its log is (`.ui-diff/server-*.log`,
`install-*.log`, `capture-*.log`). The usual causes are a missing env var, the wrong dev
command (pass `--dev`), or dependencies not installed in the working tree. Fix the cause and
rerun. Don't skip one side.

## 4. Read the results and write the summary

Read `.ui-diff/report/measured.md` first. These are **measured** facts: computed-style
changes grouped across elements, resized elements, layout shifts, copy changes, and
**new** WCAG contrast failures. Then open the zoom images (`report/zoom/*__after.png` and `__before.png`)
and diff overlays with whatever file or image viewing tool you have to see how those facts
look in context. If you can't view images, write the summary from `measured.md` alone and
say the screenshots weren't reviewed. Check
`results.json` for `warnings` too: HTTP errors, framework error overlays, uncaught exceptions.

Write `.ui-diff/report/summary.md` for a designer or PM who won't read the code:

```markdown
**What changed**
- **Pricing cards** — CTA buttons are now pills (radius 4 → 999px) with more padding (8×14 → 12×20px); the Pro card is highlighted (2px `#2563EB` border, `#EFF6FF` fill) with a "Most popular" label.
- **Header (all pages)** — nav links went from blue `#2563EB` to gray `#9CA3AF`.

**Worth a look**
- ⚠️ Nav links are now 2.5:1 contrast on white (was 5.2:1); body text needs 4.5:1.
- ⚠️ `/settings` changed but none of its files did — it picks up the new `Button` padding, and "Save"/"Cancel" now wrap on mobile.

**Not checked:** `/admin/*` (needs login), the delete-account modal.
```

Guidelines:
- **Use measured values** from `measured.md` for colors, sizes and spacing. Don't estimate
  them from pixels. If something is visible in the images but not in `measured.md`
  (images, canvas, SVG content), describe it as seen.
- A large pixel-change percentage with "shifted … layout shift" lines usually means content
  was pushed down, not that everything changed. Explain it that way.
- Lead "worth a look" with **likely unintended** changes: pages that changed without their
  files changing, breakage at one viewport only, overflow, vanished elements, page errors.
  Then contrast failures and small touch targets (under about 44px on mobile).
- Say "changed", not "intentionally changed". You can see what changed, not why.
- Keep it proportional. A one-color tweak gets one bullet.

## 5. Publish

Posting writes to a shared PR and pushes a branch. **Show the user the summary and confirm
first**, unless their request already said to post. Then:

```bash
PREFIX=$(bash $SKILL/scripts/publish.sh .ui-diff/report <pr> <head-short-sha>)
node $SKILL/scripts/comment.cjs --report .ui-diff/report --base-url "$PREFIX" \
  --summary .ui-diff/report/summary.md --out .ui-diff/comment.md
node $SKILL/scripts/post.cjs --pr <pr> --body .ui-diff/comment.md --mode comment   # or --mode description
```

- `publish.sh` pushes the images to a `ui-diff-assets` branch (one commit, replaced on
  each publish) from a throwaway clone. Images then render inline on GitHub, including in
  private repos for anyone with read access.
  - **Exit 3** means no push access (typically a PR from a fork). Switch to manual mode.
  - If it notes the repo is **public**, tell the user the screenshots will be public. That
    matters most when `storageState` logged in as a real account. Get a yes before posting.
- `post.cjs` replaces the previous ui-diff comment or description section instead of
  stacking new ones. Everything else in the description is left as it was.
- **Manual mode** (no assets branch, or no push access): run `comment.cjs` without
  `--base-url`, then `open .ui-diff/report`. The user drags the images into the PR
  comment box (GitHub has no API for that upload). Tell them which image goes where.
- **No PR yet:** keep `.ui-diff/comment.md` and offer to put it in the description when
  the PR is opened.

## 6. Wrap up

Report back with the link, the counts, and the "worth a look" items. If you worked out the
dev command, routes, masks or dynamic ids yourself, offer to save them to `.ui-diff.json`
so the next run is a single step.
