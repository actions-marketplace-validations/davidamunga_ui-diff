# Trigger evals

`trigger-queries.json` holds 20 realistic prompts for checking when agents load the
`ui-diff` skill, based on its frontmatter `description`. Half should trigger it. The other
half are near misses that should not: backend PR review, writing e2e tests, a one-off
screenshot of a live site, CSS bug fixes, a PR description without images, Figma-only
work, native mobile apps, Storybook/Chromatic setup.

Each entry has the form `{"query": "...", "should_trigger": true|false}`, which is the format
the skill-creator description-optimization scripts (`run_eval.py`, `run_loop.py`) expect.

## Re-running

You need the `claude` CLI, logged in, and a copy of Anthropic's `skill-creator` skill (its
`scripts/` folder). Run from the repo root:

```bash
mkdir -p .claude/commands   # run_eval writes a temporary command here; the folder also pins the project root
export SC=/path/to/skill-creator     # the folder that contains scripts/

# Score the current description (20 queries x 3 runs)
env -u CLAUDECODE PYTHONPATH="$SC" python3 -m scripts.run_eval \
  --eval-set evals/trigger-queries.json --skill-path skills/ui-diff \
  --model claude-opus-5-5 --timeout 60 --verbose

# Optimize: 60/40 train/test split, the best description is picked by test score
env -u CLAUDECODE PYTHONPATH="$SC" python3 -m scripts.run_loop \
  --eval-set evals/trigger-queries.json --skill-path skills/ui-diff \
  --model claude-opus-5-5 --max-iterations 4 --timeout 60 --report none --verbose
```

Two problems with the stock scripts make real triggers count as misses. The last run used
a locally patched copy of `run_eval.py` to fix both:

1. **Parallel runs share `.claude/commands/`.** Each of the 10 workers writes its own
   `ui-diff-skill-<id>` command there, so every `claude -p` sees several near-identical
   commands, often picks another worker's, and the run is scored as a miss. Unpatched,
   the current description scored 6-8% recall. The fix is to give each run its own temp
   project directory (`tempfile.mkdtemp()`) and pass it as `project_root` and `cwd`.
   Running with `--num-workers 1` avoids the problem too, but it is slow.
2. **An installed copy of the skill competes with the test command.** If `ui-diff` is also
   installed as a user-level skill (for example `~/.claude/skills/ui-diff`), Claude may load
   that copy instead. The patch adds `--setting-sources project` to the `claude -p` command
   so user-level skills are not loaded.
