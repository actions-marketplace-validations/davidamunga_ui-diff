#!/usr/bin/env bash
# End-to-end self-test for the ui-diff scripts. Builds throwaway git repos from
# tests/fixtures, runs the real pipeline against them, and checks the results.
#
# Usage: tests/selftest.sh [--full] [--keep]
#   --full   also scaffold a real Vite + React app and a Storybook (needs network; adds ~1 min)
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

section "unit: Storybook story picking (stories.cjs)"
SBF="$FIX/storybook"
# pick <changed files...> → sorted story ids (fixture index.json files, sources read from the fixture)
pick() {
  printf '%s\n' "$@" > "$TMP/sb-changed.txt"
  node "$S/stories.cjs" --base "$SBF/index-base.json" --head "$SBF/index-head.json" --changed "$TMP/sb-changed.txt" \
    --root-head "$SBF" --out "$TMP/sb" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.stories.map((s)=>s.id).sort().join(",")+(r.unmatched.length?" ?"+r.unmatched.join(","):""))'
}
check "changed story file → its stories" test "$(pick src/components/Header.stories.tsx)" = "header--logged-in,header--logged-out"
check "same base name (Button.module.css) + importers (Card)" test "$(pick src/components/Button.module.css)" = "button--primary,button--secondary,card--default"
check "index.tsx counts as its folder name" test "$(pick src/components/Card/index.tsx)" = "card--default"
check "unimported file → stories in the same folder" test "$(pick src/components/Icon.tsx)" = "badge--default,button--primary,button--secondary,header--logged-in,header--logged-out"
check ".storybook/ change → every story, no docs entries" test "$(pick .storybook/preview.ts | tr ',' '\n' | wc -l | tr -d ' ')" = 6
check "unrelated file → nothing, reported as unmatched" test "$(pick src/lib/format.ts README.md)" = " ?src/lib/format.ts"
pick src/components/Badge.stories.tsx src/components/Header.stories.tsx > /dev/null
expect "$TMP/sb/capture-head.json" 'd.routes.some((r) => r.name === "badge--default") && !d.routes.some((r) => r.name === "header--logged-out")' "head config: new story in, base-only story out"
expect "$TMP/sb/capture-base.json" '!d.routes.some((r) => r.name === "badge--default") && d.routes.some((r) => r.name === "header--logged-out")' "base config: the reverse (diff.cjs then reports new / removed)"
expect "$TMP/sb/capture-head.json" 'd.routes[0].path.startsWith("/iframe.html?id=") && d.routes[0].path.endsWith("&viewMode=story") && d.viewports.desktop.width === 1024' "iframe URLs and the smaller story viewport"
check "--stories with wildcard" test "$(node "$S/stories.cjs" --base "$SBF/index-base.json" --head "$SBF/index-head.json" --stories 'button--*,card--default' --out "$TMP/sb" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).stories.map((s)=>s.id).join())')" = "button--primary,button--secondary,card--default"
check "Storybook 6 stories.json is read too" node -e 'const {parseIndex}=require(process.argv[1]);const s=parseIndex({v:3,stories:{"a--b":{id:"a--b",kind:"A",name:"B",importPath:"./src/A.stories.js"}}});if(s.length!==1||s[0].title!=="A"||s[0].importPath!=="src/A.stories.js")process.exit(1)' "$S/stories.cjs"
mkdir -p "$TMP/dc/sb-script" "$TMP/dc/sb-dir/.storybook"
echo '{"scripts":{"storybook":"storybook dev -p 6006"}}' > "$TMP/dc/sb-script/package.json"
echo '{"devDependencies":{"storybook":"10"}}' > "$TMP/dc/sb-dir/package.json"
touch "$TMP/dc/sb-dir/pnpm-lock.yaml"
check "storybook script + npm" test "$(node "$S/devcmd.cjs" "$TMP/dc/sb-script" --storybook)" = "npm run storybook -- -p {port} --ci"
check "storybook CLI + pnpm"  test "$(node "$S/devcmd.cjs" "$TMP/dc/sb-dir" --storybook)" = "pnpm exec storybook dev -p {port} --ci"

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

  section "e2e (full): Storybook mode on a real Storybook (React + Vite)"
  cd "$TMP"
  if npm create -y vite@6.5.0 sb-app -- --template react >/dev/null 2>&1 && cd sb-app &&
     npm install --silent --no-audit --no-fund >/dev/null 2>&1 &&
     npm install --silent --no-audit --no-fund -D storybook@10.6.7 @storybook/react-vite@10.6.7 >/dev/null 2>&1; then
    npm pkg set scripts.storybook="storybook dev -p 6006"
    mkdir -p .storybook
    echo "export default { stories: ['../src/**/*.stories.jsx'], framework: '@storybook/react-vite' };" > .storybook/main.js
    echo ".btn { padding: 8px 14px; border: 0; border-radius: 4px; background: #2563eb; color: white; }" > src/Button.css
    printf '%s\n' "import './Button.css';" "export const Button = ({ label }) => <button className=\"btn\">{label}</button>;" > src/Button.jsx
    printf '%s\n' "import { Button } from './Button';" "export default { title: 'Button', component: Button };" \
      "export const Primary = { args: { label: 'Save' } };" > src/Button.stories.jsx
    printf '%s\n' "export default { title: 'Note' };" "export const Plain = { render: () => <p>Unrelated</p> };" > src/Note.stories.jsx
    git init -q -b main && git add -A && commit base
    git checkout -q -b green
    echo ".btn { padding: 8px 14px; border: 0; border-radius: 999px; background: #16a34a; color: white; }" > src/Button.css
    echo "export const Long = { args: { label: 'Save and continue' } };" >> src/Button.stories.jsx
    git add -A && commit "green pill button"
    bash "$S/run.sh" --storybook > "$TMP/sb.out" 2> "$TMP/sb.err"
    check "run.sh --storybook exits 0" test $? = 0
    expect "$TMP/sb.err" 'has(d, "npm run storybook -- -p {port} --ci")' "detects the Storybook command"
    B="$TMP/sb-app/.ui-diff/report"
    expect "$B/results.json" 'item(d, "button--primary__desktop.png").status === "changed" && item(d, "button--primary__mobile.png").status === "changed"' "changed component's story is changed"
    expect "$B/results.json" 'item(d, "button--long__desktop.png").status === "added"' "story only on head is new"
    expect "$B/results.json" '!d.items.some((i) => i.name === "note--plain") && d.summary.error === 0 && d.items.every((i) => !i.warnings)' "unrelated story not captured; no errors"
    expect "$B/measured.md" 'has(d, "`background-color`: #2563eb → #16a34a") && has(d, "`border-radius`: 4px → 999px")' "measures the restyle"
    expect "$B/run.json" 'd.storybook === true && d.routes.includes("button--primary")' "run.json lists stories"
    for p in $(node -e 'const r=require(process.argv[1]);console.log(r.ports.base, r.ports.head)' "$B/run.json"); do check "Storybook on :$p was stopped" port_closed "$p"; done
    check "temporary worktree removed" no_extra_worktrees "$TMP/sb-app"
  else
    echo "  ✗ couldn't set up the Storybook app (network?)"; FAIL=$((FAIL + 1))
  fi
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
