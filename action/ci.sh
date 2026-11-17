#!/usr/bin/env bash
# What the GitHub Action (../action.yml) runs: the skill's pipeline with no agent.
# run.sh → publish.sh → comment.cjs --auto-summary → post.cjs, or prune.sh when the PR is
# closed. Kept as a script so tests/selftest.sh can run it without GitHub (fake event
# payload, local bare remote, stub gh).
#
# Inputs come from env (action.yml maps them): UI_DIFF_MODE, UI_DIFF_ROUTES, UI_DIFF_DEV,
# UI_DIFF_VIEWPORTS, UI_DIFF_SCHEMES, UI_DIFF_BASE, UI_DIFF_CONFIG, UI_DIFF_SUMMARY, plus
# GH_TOKEN and the standard GITHUB_* variables. Outputs go to $GITHUB_OUTPUT.
set -euo pipefail

S="$(cd "$(dirname "$0")/../skills/ui-diff/scripts" && pwd)"
MODE="${UI_DIFF_MODE:-comment}"

note() { echo "ui-diff: $*" >&2; }
fail() { echo "::error title=ui-diff::$*" >&2; exit 1; }
output() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1=$2" >> "$GITHUB_OUTPUT"; }
step_summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }
skip() { note "$*"; note "skipping."; output skipped true; step_summary "ui-diff skipped: $*"; exit 0; }
# Pushes to the assets branch can lose a race with another run (force-with-lease); retry.
retry() {
  local n
  for n in 1 2 3; do
    "$@" && return 0
    [ "$n" = 3 ] || { note "retrying in $((n * 5))s"; sleep $((n * 5)); }
  done
  return 1
}

case "$MODE" in comment|description|prune) ;; *) fail "mode must be comment, description or prune (got '$MODE')" ;; esac

# --- the PR -----------------------------------------------------------------------
[ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ] || fail "no GitHub event payload; run this action on pull_request events"
read -r PR BASE_SHA HEAD_SHA HEAD_REPO ACTION < <(node -e '
const e = require(process.argv[1]);
const p = e.pull_request;
if (p) console.log([p.number, p.base.sha, p.head.sha, (p.head.repo && p.head.repo.full_name) || "-", e.action || "-"].join(" "));
' "$GITHUB_EVENT_PATH") || true
[ -n "${PR:-}" ] || fail "this action runs on pull_request events (got '${GITHUB_EVENT_NAME:-unknown}')"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY not set}"

# Fork PRs (and Dependabot's) get a read-only token: no assets branch, no comment.
[ "$HEAD_REPO" = "$REPO" ] || skip "PR #$PR comes from a fork ($HEAD_REPO); GitHub gives fork PRs a read-only token, so screenshots can't be pushed or commented"
[ "${GITHUB_ACTOR:-}" != "dependabot[bot]" ] || skip "Dependabot PRs get a read-only token"

export UI_DIFF_REPO="$REPO"
export UI_DIFF_REMOTE="${UI_DIFF_REMOTE:-${GITHUB_SERVER_URL:-https://github.com}/$REPO.git}"
export GH_REPO="$REPO"
if [ -n "${GH_TOKEN:-}" ] && [ -z "${UI_DIFF_GIT_TOKEN:-}" ]; then
  export UI_DIFF_GIT_TOKEN="$GH_TOKEN"
  echo "::add-mask::$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
fi
BRANCH="${UI_DIFF_BRANCH:-ui-diff-assets}"
output skipped false

# --- cleanup: closed PR → drop its images ------------------------------------------
if [ "$MODE" = prune ] || [ "$ACTION" = closed ]; then
  note "removing PR #$PR's images from $BRANCH"
  retry bash "$S/prune.sh" "$PR" || fail "couldn't update the $BRANCH branch. The workflow needs 'permissions: contents: write'."
  step_summary "ui-diff: removed PR #$PR's images from \`$BRANCH\`."
  exit 0
fi

# --- routes: no agent to infer them, so they must be given --------------------------
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git checkout; add actions/checkout before this action (or set working-directory)"
CONFIG="${UI_DIFF_CONFIG:-}"
[ -n "$CONFIG" ] || { [ -f "$ROOT/.ui-diff.json" ] && CONFIG="$ROOT/.ui-diff.json"; } || true
[ -z "$CONFIG" ] || [ -f "$CONFIG" ] || fail "config file $CONFIG not found"
CFG_ROUTES=0
[ -z "$CONFIG" ] || CFG_ROUTES="$(node -e 'console.log((require(require("path").resolve(process.argv[1])).routes || []).length)' "$CONFIG")"
if [ -z "${UI_DIFF_ROUTES:-}" ] && [ "$CFG_ROUTES" = 0 ]; then
  fail "no routes to capture. Set the 'routes' input (e.g. routes: /,/pricing) or add \"routes\" to .ui-diff.json. In CI there's no agent to work them out from the diff."
fi

# --- commits: run.sh needs both, plus their merge-base -----------------------------
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  note "shallow checkout; fetching history for base and head (use fetch-depth: 0 to skip this)"
  git fetch -q --no-tags --unshallow origin "$BASE_SHA" "$HEAD_SHA"
else
  for sha in "$BASE_SHA" "$HEAD_SHA"; do
    git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q --no-tags origin "$sha"
  done
fi

# --- tools: Chromium needs system libraries the runner may not have ------------------
TOOLS="$(bash "$S/setup.sh" | tail -n 1)"
if [ "$(uname)" = Linux ] && ! node -e 'require(require.resolve("playwright", { paths: [process.argv[1]] })).chromium.launch().then((b) => b.close())' "$TOOLS" >/dev/null 2>&1; then
  note "installing Chromium's system dependencies"
  (cd "$TOOLS" && npx playwright install-deps chromium) >&2
fi

# --- run, publish, comment --------------------------------------------------------
RUN=(--base "${UI_DIFF_BASE:-$BASE_SHA}" --head "$HEAD_SHA")
[ -z "${UI_DIFF_ROUTES:-}" ] || RUN+=(--routes "$UI_DIFF_ROUTES")
[ -z "${UI_DIFF_VIEWPORTS:-}" ] || RUN+=(--viewports "$UI_DIFF_VIEWPORTS")
[ -z "${UI_DIFF_SCHEMES:-}" ] || RUN+=(--schemes "$UI_DIFF_SCHEMES")
[ -z "${UI_DIFF_DEV:-}" ] || RUN+=(--dev "$UI_DIFF_DEV")
[ -z "$CONFIG" ] || RUN+=(--config "$CONFIG")
COUNTS="$(bash "$S/run.sh" "${RUN[@]}")"
note "result: $COUNTS"
R="$ROOT/.ui-diff/report"
output report-dir "$R"
for k in changed added removed unchanged error; do
  output "$([ $k = error ] && echo errors || echo $k)" "$(node -e 'console.log(require(process.argv[1]).summary[process.argv[2]] || 0)' "$R/results.json" "$k")"
done

PREFIX="$(retry bash "$S/publish.sh" "$R" "$PR" "${HEAD_SHA:0:7}")" ||
  fail "couldn't push screenshots to the $BRANCH branch. The workflow needs 'permissions: contents: write'."

SUM=(--auto-summary)
[ -z "${UI_DIFF_SUMMARY:-}" ] || { [ -f "$UI_DIFF_SUMMARY" ] && SUM=(--summary "$UI_DIFF_SUMMARY"); } || note "summary file $UI_DIFF_SUMMARY not found; using the automatic summary"
node "$S/comment.cjs" --report "$R" --base-url "$PREFIX" "${SUM[@]}" --out "$ROOT/.ui-diff/comment.md"

URL="$(node "$S/post.cjs" --pr "$PR" --body "$ROOT/.ui-diff/comment.md" --mode "$MODE")" ||
  fail "couldn't post to PR #$PR. The workflow needs 'permissions: pull-requests: write'."
URL="$(echo "$URL" | tail -n 1)"
output comment-url "$URL"
note "posted: $URL"
step_summary "ui-diff: $COUNTS — $URL"
