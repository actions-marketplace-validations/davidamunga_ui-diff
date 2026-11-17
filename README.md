# ui-diff

[![test](https://github.com/davidamunga/ui-diff/actions/workflows/test.yml/badge.svg)](https://github.com/davidamunga/ui-diff/actions/workflows/test.yml)

An agent skill that shows reviewers what a pull request **looks like**, not just what
its code is.

<img src="docs/demo.png" alt="A ui-diff comment on a pull request: a written summary of the design changes, then before/after crops showing the buttons turning from blue rectangles into violet pills" width="720">

Run it on a branch and your agent will:

1. Work out which pages the PR affects from the changed files (routes, layouts, shared components, CSS/tokens).
2. Run the app at the **base** and **head** commits side by side, in git worktrees on free ports. Your checkout and your other running servers are untouched.
3. Screenshot each affected page on desktop and an emulated iPhone (dark mode optional), with animations frozen so the shots are reproducible.
4. Pixel-diff them and crop zoomed before/after images of each changed region.
5. **Measure** the change: compare every element's computed styles to get exact values ("padding 8×14 → 12×20px", "`#2563EB` → `#9CA3AF`"), spot layout shifts and copy changes, and flag new WCAG contrast failures.
6. Write a short design summary from those measurements and the images, leading with what looks unintended.
7. Post it to the PR as a comment, or as a section of the PR description. Re-runs update the same comment instead of adding new ones.

## Install

`ui-diff` is an [Agent Skill](https://agentskills.io): a `SKILL.md` folder plus scripts. Any
agent that supports the format can use it, including Claude Code, Codex, Cursor, Gemini CLI,
GitHub Copilot, OpenCode, Goose, Windsurf, Amp, Cline, Roo Code and Kiro.

**Claude Code** (as a plugin):
```
/plugin marketplace add davidamunga/ui-diff
/plugin install ui-diff@ui-diff
```

**Every agent on your machine**, with the installer in this repo:
```bash
git clone https://github.com/davidamunga/ui-diff.git && cd ui-diff
./install.sh                    # links the skill into each detected agent's skills folder
./install.sh --list             # show agents, paths, and what's installed
./install.sh --agents codex,cursor
./install.sh --project ~/Work/my-app   # one project only: my-app/.agents/skills/
./install.sh --uninstall
```
Symlinks are the default, so `git pull` updates every agent at once. Pass `--copy` if you'd
rather have copies.

**Or with the [`skills`](https://skills.sh) CLI** (Node 22.20+):
```bash
npx skills add davidamunga/ui-diff            # project-level, asks which agents
npx skills add davidamunga/ui-diff -g -a codex -a cursor -a gemini-cli -a github-copilot
```

**Manually:** copy or symlink `skills/ui-diff/` into the agent's skills folder:

| Agent | User-level | Project-level |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex, Cline | `~/.agents/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` | `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` | `.agents/skills/` |
| GitHub Copilot | `~/.copilot/skills/` | `.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` | `.agents/skills/` |
| Goose | `~/.config/goose/skills/` | `.goose/skills/` |
| Windsurf | `~/.codeium/windsurf/skills/` | `.windsurf/skills/` |
| Amp | `~/.config/agents/skills/` | `.agents/skills/` |

The repo is public: anyone can clone it or install it with any of the methods above.

Requirements: bash, git, Node 18+, and `gh` (logged in) for posting to PRs. On the first run
Playwright and Chromium are installed into `~/.cache/ui-diff`. Your project's dependencies
are not changed.

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
(e.g. a PR from a fork), it falls back to manual mode. If you'd rather not have that branch, ask for **manual** mode: the agent
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
LICENSE                         MIT
install.sh                      install for every detected agent
skills/ui-diff/
├── SKILL.md                    the workflow the agent follows
├── LICENSE.txt                 MIT (copy that travels with the skill folder)
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
├── check-spec.cjs              Agent Skills spec compliance check
├── expect.cjs                  assertion helper
└── fixtures/static-site/       base/ + head/ overlay for the demo site
```

## License

MIT. See [LICENSE](LICENSE).
