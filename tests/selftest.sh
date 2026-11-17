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

section "unit: dependency linking in a monorepo (linkdeps.cjs)"
# src: an app whose node_modules holds a registry package and a workspace link (@acme/ui -> packages/ui).
for r in src dst; do mkdir -p "$TMP/ld/$r/apps/web" "$TMP/ld/$r/packages/ui"; echo "$r" > "$TMP/ld/$r/packages/ui/index.js"; done
mkdir -p "$TMP/ld/src/apps/web/node_modules/@acme" "$TMP/ld/src/apps/web/node_modules/react"
ln -s ../../../../packages/ui "$TMP/ld/src/apps/web/node_modules/@acme/ui"
node "$S/linkdeps.cjs" "$TMP/ld/src" "$TMP/ld/dst" >/dev/null
check "workspace package resolves to the worktree's own source" test "$(cat "$TMP/ld/dst/apps/web/node_modules/@acme/ui/index.js")" = dst
check "registry packages are shared with the checkout" test "$(cd "$TMP/ld/dst/apps/web/node_modules/react" && pwd -P)" = "$(cd "$TMP/ld/src/apps/web/node_modules/react" && pwd -P)"

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
