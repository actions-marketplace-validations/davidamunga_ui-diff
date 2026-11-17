#!/usr/bin/env bash
# End-to-end self-test for the ui-diff scripts. Builds throwaway git repos from
# tests/fixtures, runs the real pipeline against them, and checks the results.
#
# Usage: tests/selftest.sh [--full] [--keep]
#   --full   also scaffold a real Vite + React app (needs network; adds ~30s)
#   --keep   keep the temp dir for inspection (path is printed)
#
# The fast tier needs python3 (static file server), node, git. No network after the
# one-time tool install, nothing pushed anywhere, no GitHub calls.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../skills/ui-diff/scripts"
FIX="$HERE/fixtures"
FULL=0 KEEP=0
for a in "$@"; do
  case "$a" in --full) FULL=1 ;; --keep) KEEP=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac
done

TMP="$(mktemp -d)"
BYSTANDER=""
cleanup() {
  [ -n "$BYSTANDER" ] && kill "$BYSTANDER" 2>/dev/null
  if [ "$KEEP" = 1 ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

PASS=0 FAIL=0
expect() { if node "$HERE/expect.cjs" "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }
check() { # check "<description>" <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ $desc"; PASS=$((PASS + 1)); else echo "  ✗ $desc"; FAIL=$((FAIL + 1)); fi
}
section() { echo; echo "▸ $*"; }
commit() { git -c user.name=selftest -c user.email=selftest@example.com commit -qm "$1"; }
port_closed() { ! curl -s -o /dev/null --max-time 1 "http://localhost:$1/"; }
no_extra_worktrees() { [ "$(git -C "$1" worktree list | wc -l | tr -d ' ')" = 1 ]; }
tree_clean() { [ -z "$(git -C "$1" status --porcelain)" ]; }

# Repo with fixture base on main and base+head overlay on a feature branch.
make_static_repo() {
  local dir="$1"
  mkdir -p "$dir" && cd "$dir" || exit 1
  git init -q -b main
  cp "$FIX/static-site/base/"* .
  git add -A && commit base
  git checkout -q -b feature
  cp "$FIX/static-site/head/"* .
  git add -A && commit "pricing refresh"
}

bash "$S/setup.sh" >/dev/null || { echo "tool setup failed"; exit 1; }

# ---------------------------------------------------------------------------------
section "spec: SKILL.md follows the Agent Skills spec (works across agents)"
node "$HERE/check-spec.cjs" "$HERE/../skills"
check "all spec rules pass" test $? = 0

section "unit: description splicing (post.cjs)"
cd "$TMP"
node -e '
const { spliceSection } = require(process.argv[1]);
const sec = "<!-- ui-diff:start -->\nNEW\n<!-- ui-diff:end -->";
const cases = [
  ["My PR text", "My PR text\n\n---\n\n" + sec],
  ["Intro\n\n<!-- ui-diff:start -->\nOLD\n<!-- ui-diff:end -->\n\nFooter", "Intro\n\n" + sec + "\n\nFooter"],
  ["", sec],
];
for (const [input, want] of cases) if (spliceSection(input, sec) !== want) { console.error(JSON.stringify(input)); process.exit(1); }
' "$S/post.cjs"
check "appends, replaces in place, keeps surrounding text" test $? = 0

section "unit: dev command detection (devcmd.cjs)"
mkdir -p "$TMP/dc/vite" "$TMP/dc/next" "$TMP/dc/static" "$TMP/dc/none"
echo '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"6"}}' > "$TMP/dc/vite/package.json"
echo '{"scripts":{"dev":"next dev"},"dependencies":{"next":"15"}}' > "$TMP/dc/next/package.json"
touch "$TMP/dc/next/pnpm-lock.yaml"
touch "$TMP/dc/static/index.html"
check "vite + npm"   test "$(node "$S/devcmd.cjs" "$TMP/dc/vite")" = "npm run dev -- --port {port} --strictPort"
check "next + pnpm"  test "$(node "$S/devcmd.cjs" "$TMP/dc/next")" = "pnpm run dev -p {port}"
check "static html"  test "$(node "$S/devcmd.cjs" "$TMP/dc/static")" = "python3 -m http.server {port}"
check "nothing to run → error" bash -c "! node '$S/devcmd.cjs' '$TMP/dc/none'"

# ---------------------------------------------------------------------------------
section "e2e: static site — style changes, new page, unchanged page"
REPO="$TMP/static"
make_static_repo "$REPO"
# Something already running that the run must not touch.
python3 -m http.server 0 >/dev/null 2>&1 &
BYSTANDER=$!
bash "$S/run.sh" --routes "/,/pricing.html,/about.html,/new.html" > "$TMP/static.out" 2> "$TMP/static.err"
check "run.sh exits 0" test $? = 0
R="$REPO/.ui-diff/report"
expect "$R/results.json" 'd.summary.changed === 4 && d.summary.added === 2 && d.summary.unchanged === 2 && d.summary.error === 0' "4 changed, 2 new, 2 unchanged, 0 errors"
expect "$R/results.json" 'item(d, "new-html__desktop.png").status === "added"' "page missing on base (404) is reported as new"
expect "$R/results.json" 'item(d, "about-html__desktop.png").status === "unchanged"' "page that doesn't use the changed CSS is unchanged"
expect "$R/results.json" 'item(d, "pricing-html__desktop.png").regions.some((r) => r.zoom)' "changed page has zoomed regions"
expect "$R/measured.md" 'has(d, "`padding`: 8px 14px → 12px 20px")' "measures padding change (as shorthand)"
expect "$R/measured.md" 'has(d, "`border-radius`: 4px → 12px")' "measures radius change"
expect "$R/measured.md" 'has(d, "`color`: #2563eb → #9ca3af")' "measures color change in hex"
expect "$R/measured.md" 'has(d, "copy: \"$12/mo\" → \"$10/mo, billed yearly\"")' "detects copy change"
expect "$R/measured.md" 'has(d, "contrast 2.54:1") && has(d, "(was 5.17:1)")' "flags new contrast failure with previous ratio"
expect "$R/measured.md" 'has(d, "contrast 1.92:1") && has(d, "Faint helper text")' "flags contrast on a brand-new page"
expect "$R/measured.md" '!has(d, "padding-top")' "no per-side padding noise"
expect "$R/run.json" 'd.head.dirty === false && d.viewports.join() === "desktop,mobile"' "run.json: clean head, desktop + mobile"
PORTS="$(node -e 'const r=require(process.argv[1]);console.log(r.ports.base, r.ports.head)' "$R/run.json")"
for p in $PORTS; do check "server on :$p was stopped" port_closed "$p"; done
check "unrelated server still running" kill -0 "$BYSTANDER"
check "temporary worktree removed" no_extra_worktrees "$REPO"
check "working tree untouched" tree_clean "$REPO"
check ".ui-diff/ ignored locally" grep -qxF '.ui-diff/' "$REPO/.git/info/exclude"

section "e2e: comment rendering"
node "$S/comment.cjs" --report "$R" --base-url "https://github.com/acme/demo/blob/ui-diff-assets/pr-1/abc1234" --out "$TMP/comment.md"
expect "$TMP/comment.md" 'd.startsWith("<!-- ui-diff:start -->") && d.trim().endsWith("<!-- ui-diff:end -->")' "wrapped in markers"
expect "$TMP/comment.md" 'has(d, "Pages not listed were not checked")' "states coverage"
expect "$TMP/comment.md" 'has(d, "pr-1/abc1234/zoom/") && has(d, "?raw=true")' "image URLs use the published prefix"
expect "$TMP/comment.md" 'has(d, "🆕 `/new.html`")' "new page section"
expect "$TMP/comment.md" 'has(d, "<summary>Measured changes</summary>")' "measured changes section"

section "e2e: publishing to the assets branch (local bare remote)"
git init -q --bare "$TMP/remote.git"
git -C "$REPO" remote add origin "$TMP/remote.git"
P1="$(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/publish.sh" "$R" 1 abc1234 2>/dev/null)"
check "prints the URL prefix only" test "$P1" = "https://github.com/acme/demo/blob/ui-diff-assets/pr-1/abc1234"
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/publish.sh" "$R" 2 def5678 >/dev/null 2>&1)
check "branch stays a single commit" test "$(git --git-dir="$TMP/remote.git" rev-list --count ui-diff-assets)" = 1
check "keeps earlier PRs' images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-1/abc1234/diff/pricing-html__desktop.png"
check "adds the new PR's images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-2/def5678/diff/pricing-html__desktop.png"
check "user's branch untouched" test "$(git -C "$REPO" branch --show-current)" = feature

section "e2e: pruning the assets branch (prune.sh)"
assets_sha() { git --git-dir="$TMP/remote.git" rev-parse ui-diff-assets; }
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/prune.sh" 1 >/dev/null 2>&1)
check "prune.sh exits 0" test $? = 0
check "removes the closed PR's images" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-1"
check "keeps other PRs' images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-2/def5678/diff/pricing-html__desktop.png"
check "branch stays a single commit" test "$(git --git-dir="$TMP/remote.git" rev-list --count ui-diff-assets)" = 1
BEFORE="$(assets_sha)"
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/prune.sh" 99 >/dev/null 2>&1)
check "PR with no images → exits 0 without pushing" test $? = 0 -a "$(assets_sha)" = "$BEFORE"
(cd "$REPO" && UI_DIFF_REPO=acme/demo UI_DIFF_BRANCH=no-such-branch bash "$S/prune.sh" 2 >/dev/null 2>&1)
check "no assets branch → exits 0" test $? = 0
(cd "$TMP" && UI_DIFF_REPO=acme/demo UI_DIFF_REMOTE="$TMP/remote.git" bash "$S/prune.sh" 2 >/dev/null 2>&1)
check "works outside a checkout with UI_DIFF_REMOTE" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-2"

section "unit: automatic summary (comment.cjs --auto-summary)"
node "$S/comment.cjs" --report "$R" --auto-summary --out "$TMP/auto.md"
expect "$TMP/auto.md" 'has(d, "Automatic summary") && has(d, "**What changed**")' "labelled as automatic"
expect "$TMP/auto.md" 'has(d, "`/pricing.html` (desktop, mobile) — ") && has(d, "text change")' "one line per route across viewports, with measured facts"
expect "$TMP/auto.md" 'has(d, "🆕 `/new.html` — new page (desktop, mobile)") && !has(d.split("<sub>**")[0], "HTTP 404")' "new page (its base 404 isn't flagged)"
expect "$TMP/auto.md" 'has(d, "**Worth a look**") && has(d, "contrast 2.54:1") && has(d, "(was 5.17:1)")' "new contrast failures under worth a look"
expect "$TMP/auto.md" 'd.split("<sub>**")[0].split("contrast 2.54:1").length === 2 && has(d, "— `/`, `/pricing.html` (desktop, mobile)")' "a shared-header issue is one line across pages"
expect "$TMP/auto.md" 'has(d, "contrast 1.92:1 (needs 4.5:1), #bbbbbb on #ffffff: p \"Faint helper text\"")' "new-page contrast is listed too"
expect "$TMP/auto.md" '!has(d, "/about.html` (")' "unchanged pages aren't listed as changed"
echo "**Hand-written**" > "$TMP/summary.md"
node "$S/comment.cjs" --report "$R" --auto-summary --summary "$TMP/summary.md" --out "$TMP/both.md"
expect "$TMP/both.md" 'has(d, "Hand-written") && !has(d, "Automatic summary")' "--summary wins over --auto-summary"

section "unit: description mode uses the REST API (post.cjs, stub gh)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for gh: logs each call; answers as if the PR has no ui-diff comment yet.
echo "$*" >> "$GH_LOG"
for a in "$@"; do case "$a" in body=@*) cp "${a#body=@}" "$GH_LOG.body" ;; esac; done
case "$*" in
  *--paginate*) ;;
  "pr view"*) echo "Original PR text" ;;
  "pr comment"*) echo "https://github.com/acme/demo/pull/$3#issuecomment-1" ;;
  *PATCH*) echo "https://github.com/acme/demo/pull/7" ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export GH_LOG="$TMP/gh.log"
PATH="$TMP/bin:$PATH" node "$S/post.cjs" --pr 7 --body "$TMP/comment.md" --mode description > "$TMP/post.out"
check "post.cjs exits 0" test $? = 0
expect "$GH_LOG" 'has(d, "api -X PATCH repos/{owner}/{repo}/pulls/7")' "edits the description via REST"
expect "$GH_LOG.body" 'd.startsWith("Original PR text\n\n---\n\n<!-- ui-diff:start -->")' "keeps the existing description"

section "e2e: GitHub Action (action/ci.sh) with a fake PR event, shallow checkout, stub gh"
git -C "$REPO" push -q origin main feature
git clone -q --depth 1 --branch feature "file://$TMP/remote.git" "$TMP/ci"
BASE_SHA="$(git -C "$REPO" rev-parse main)" HEAD_SHA="$(git -C "$REPO" rev-parse feature)"
event() { # event <action> <head repo>
  printf '{"action":"%s","number":7,"pull_request":{"number":7,"base":{"sha":"%s"},"head":{"sha":"%s","repo":{"full_name":"%s"}}}}' \
    "$1" "$BASE_SHA" "$HEAD_SHA" "$2" > "$TMP/event.json"
}
ci() { # ci <stderr file> [VAR=value...]
  local err="$1"; shift
  (cd "$TMP/ci" && env PATH="$TMP/bin:$PATH" GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$TMP/event.json" \
    GITHUB_REPOSITORY=acme/demo GITHUB_OUTPUT="$TMP/gh-output" GITHUB_STEP_SUMMARY="$TMP/gh-summary" \
    UI_DIFF_REMOTE="file://$TMP/remote.git" GH_TOKEN=dummy UI_DIFF_VIEWPORTS="desktop:1280x800" "$@" \
    bash "$HERE/../action/ci.sh" > "$err.out" 2> "$err")
}
: > "$GH_LOG"
event synchronize acme/demo
ci "$TMP/ci.err" UI_DIFF_ROUTES="/,/pricing.html"
check "ci.sh exits 0" test $? = 0
check "unshallowed the checkout to find the merge-base" test "$(git -C "$TMP/ci" rev-parse --is-shallow-repository)" = false
expect "$TMP/gh-output" 'has(d, "skipped=false") && has(d, "changed=2") && has(d, "errors=0")' "sets counts as outputs"
expect "$TMP/gh-output" 'has(d, "comment-url=https://github.com/acme/demo/pull/7#issuecomment-1")' "sets the comment URL output"
check "published PR #7's images at the head sha" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-7/${HEAD_SHA:0:7}/diff/pricing-html__desktop.png"
expect "$GH_LOG" 'has(d, "pr comment 7 --body-file")' "posts the comment"
expect "$TMP/ci/.ui-diff/comment.md" 'has(d, "Automatic summary") && has(d, "acme/demo/blob/ui-diff-assets/pr-7/")' "comment has the automatic summary and published images"
expect "$TMP/ci.err.out" 'has(d, "::add-mask::")' "masks the git auth header"

: > "$GH_LOG"
event synchronize someone/fork
ci "$TMP/ci-fork.err" UI_DIFF_ROUTES="/"
check "fork PR → exits 0" test $? = 0
expect "$TMP/ci-fork.err" 'has(d, "comes from a fork") && has(d, "skipping")' "explains why it skipped"
expect "$TMP/gh-output" 'has(d, "skipped=true")' "sets skipped=true"
check "fork PR → no gh calls" test ! -s "$GH_LOG"

event synchronize acme/demo
ci "$TMP/ci-noroutes.err"
check "no routes and no .ui-diff.json → fails" test $? != 0
expect "$TMP/ci-noroutes.err" 'has(d, "no routes to capture") && has(d, "routes")' "says how to give routes"
ci "$TMP/ci-badmode.err" UI_DIFF_MODE=bogus
check "unknown mode → fails" test $? != 0

event closed acme/demo
ci "$TMP/ci-closed.err"
check "closed PR → exits 0 (prunes, no routes needed)" test $? = 0
check "closed PR's images removed" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-7"

# ---------------------------------------------------------------------------------
section "e2e: non-visual change → no false positives (determinism)"
cd "$REPO"
echo "# notes" > NOTES.md && git add NOTES.md && commit "docs only"
bash "$S/run.sh" --base HEAD~1 --routes "/,/pricing.html" > /dev/null 2> "$TMP/noop.err"
check "run.sh exits 0" test $? = 0
expect "$REPO/.ui-diff/report/results.json" 'd.summary.changed === 0 && d.summary.unchanged === 4' "identical UI gives identical pixels (0 changed)"

section "e2e: uncommitted changes are labelled"
echo '.card h3 { letter-spacing: 0.05em; }' >> style.css
bash "$S/run.sh" --base HEAD --routes "/pricing.html" > /dev/null 2> "$TMP/dirty.err"
check "run.sh exits 0" test $? = 0
expect "$REPO/.ui-diff/report/run.json" 'd.head.dirty === true' "run.json marks head as dirty"
expect "$REPO/.ui-diff/report/measured.md" 'has(d, "`letter-spacing`")' "uncommitted CSS change is measured"
git checkout -q -- style.css

section "e2e: failures are reported and cleaned up"
bash "$S/run.sh" --base HEAD~1 --dev "sh -c 'echo boom >&2; exit 3'" > /dev/null 2> "$TMP/fail.err"
check "run.sh exits non-zero" test $? != 0
expect "$TMP/fail.err" 'has(d, "server exited") && has(d, "boom")' "error names the failing server and shows its log"
check "temporary worktree removed after failure" no_extra_worktrees "$REPO"
bash "$S/run.sh" --base HEAD > /dev/null 2> "$TMP/same.err"
check "nothing to compare → exits non-zero" test $? != 0
expect "$TMP/same.err" 'has(d, "nothing to compare")' "explains there's nothing to compare"

# ---------------------------------------------------------------------------------
if [ "$FULL" = 1 ]; then
  section "e2e (full): real Vite + React app"
  cd "$TMP"
  if npm create -y vite@6.5.0 vite-app -- --template react >/dev/null 2>&1 && cd vite-app && npm install --silent --no-audit --no-fund >/dev/null 2>&1; then
    git init -q -b main && git add -A && commit base
    git checkout -q -b cta
    echo '.card button { background: #16a34a; color: white; border-radius: 999px; padding: 0.9em 1.8em; }' >> src/App.css
    git add -A && commit "green CTA"
    bash "$S/run.sh" > "$TMP/vite.out" 2> "$TMP/vite.err"
    check "run.sh exits 0" test $? = 0
    expect "$TMP/vite.err" 'has(d, "npm run dev -- --port {port} --strictPort")' "detects the Vite dev command"
    expect "$TMP/vite.err" 'has(d, "reusing installed dependencies")' "reuses node_modules for base (same lockfile)"
    V="$TMP/vite-app/.ui-diff/report"
    expect "$V/results.json" 'd.summary.changed === 2 && d.summary.error === 0' "home page changed on desktop + mobile"
    expect "$V/results.json" 'd.items.every((i) => !i.warnings)' "no page errors or dev overlays"
    expect "$V/measured.md" 'has(d, "`background-color`: #f9f9f9 → #16a34a") && has(d, "`border-radius`: 8px → 999px")' "measures the button restyle"
    expect "$V/measured.md" 'has(d, "contrast 3.3:1")' "flags white-on-green contrast"
    check "temporary worktree removed" no_extra_worktrees "$TMP/vite-app"
  else
    echo "  ✗ couldn't scaffold the Vite app (network?)"; FAIL=$((FAIL + 1))
  fi
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
