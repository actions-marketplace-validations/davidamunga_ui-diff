# ui-diff

A Claude Code skill that shows reviewers what a pull request **looks like**, not just what
its code is.

Run it on a branch and Claude will:

1. Work out which pages the PR affects from the changed files (routes, layouts, shared components, CSS/tokens).
2. Run the app at the **base** and **head** commits side by side, in git worktrees on free ports. Your checkout and your other running servers are untouched.
3. Screenshot each affected page on desktop and an emulated iPhone (dark mode optional), with animations frozen so the shots are reproducible.
4. Pixel-diff them and crop zoomed before/after images of each changed region.
5. **Measure** the change: compare every element's computed styles to get exact values ("padding 8×14 → 12×20px", "`#2563EB` → `#9CA3AF`"), spot layout shifts and copy changes, and flag new WCAG contrast failures.
6. Write a short design summary from those measurements and the images, leading with what looks unintended.
7. Post it to the PR as a comment, or as a section of the PR description. Re-runs update the same comment instead of adding new ones.

## Install

```bash
# in Claude Code
/plugin marketplace add <this repo's git URL or local path>
/plugin install ui-diff@ui-diff
```

Or copy `skills/ui-diff/` into `~/.claude/skills/` (personal) or `<repo>/.claude/skills/` (shared with a project).

Requirements: Node 18+, `git`, and `gh` (logged in). On the first run, Playwright and
Chromium are installed into `~/.cache/ui-diff`. Your project's dependencies are not changed.

## Use

Just ask:

> add before/after screenshots of my UI changes to the PR

> did my tailwind config change break any pages? check desktop and mobile

> ui diff for PR #482, put it in the description

To save the routes, dev command, masks for dynamic content, and login state for future
runs, add a `.ui-diff.json` file. See [`skills/ui-diff/references/config.md`](skills/ui-diff/references/config.md).

## Where the images go

GitHub has no public API for the drag-and-drop `user-attachments` uploads, so by default
the images are pushed to a `ui-diff-assets` branch in the same repo and embedded
from there. They render inline, and in private repos they're visible to anyone with read access.
The branch is kept as a single commit, so it doesn't bloat clones. Set `UI_DIFF_PRUNE=1`
to drop images of closed PRs, or delete the branch at any time. If you can't push to the repo
(e.g. a PR from a fork), it falls back to manual mode. If you'd rather not have that branch, ask for **manual** mode: Claude
writes the comment and opens the image folder, and you drag the images into GitHub yourself.

## Development

```bash
tests/selftest.sh          # ~30s: unit checks + full pipeline on a static fixture site (no network)
tests/selftest.sh --full   # ~45s more: also scaffolds and diffs a real Vite + React app
tests/selftest.sh --keep   # keep the temp repos for inspection
```

The fast tier builds throwaway git repos from `tests/fixtures/static-site/` (`head/` is
overlaid on `base/`) and checks everything the skill promises: measured style, copy and
contrast changes, new vs unchanged pages, zero false positives on a non-visual change,
uncommitted-change labelling, publishing to a local bare remote, failure reporting, and
that servers, worktrees and unrelated processes are cleaned up or left alone. Nothing
touches GitHub. Run it after any change to `skills/ui-diff/scripts/`.

## Layout

```
skills/ui-diff/
├── SKILL.md                    the workflow Claude follows
├── scripts/
│   ├── run.sh                  the whole pipeline: worktrees → servers → capture → diffs
│   ├── setup.sh                one-time toolchain install
│   ├── devcmd.cjs              detect the dev-server command and port flag
│   ├── linkdeps.cjs            reuse installed deps in a worktree without sharing build caches
│   ├── capture.cjs             deterministic screenshots + computed-style snapshots
│   ├── diff.cjs                pixel diff, changed regions, zoom crops
│   ├── stylediff.cjs           measured style/layout/copy/contrast changes
│   ├── publish.sh              push images to the assets branch
│   ├── comment.cjs             render the PR markdown
│   └── post.cjs                create or update the PR comment / description section
└── references/
    ├── route-mapping.md        changed files → routes, per framework
    └── config.md               .ui-diff.json options, auth, noise control
tests/
├── selftest.sh                 end-to-end self-test
├── expect.cjs                  assertion helper
└── fixtures/static-site/       base/ + head/ overlay for the demo site
```
