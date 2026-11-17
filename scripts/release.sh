#!/usr/bin/env bash
# Cut a release: bump the version in plugin.json and SKILL.md, run the tests, commit,
# tag vX.Y.Z, move the major tag (v0, v1…) that `uses: davidamunga/ui-diff@v0` follows,
# push, and create the GitHub release.
#
# Usage: scripts/release.sh <version> [notes.md]   e.g. scripts/release.sh 0.2.0 notes.md
# Without a notes file, GitHub generates the notes from merged PRs and commits.
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:?usage: scripts/release.sh <version>}"
V="${V#v}"
NOTES="${2:-}"
[ -z "$NOTES" ] || [ -f "$NOTES" ] || { echo "no such notes file: $NOTES" >&2; exit 1; }
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "release from main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && { echo "v$V already exists" >&2; exit 1; }

node -e '
const fs = require("fs"); const v = process.argv[1];
const bump = (f, re, rep) => { const t = fs.readFileSync(f, "utf8"); const u = t.replace(re, rep);
  if (u === t) { console.error(`version not found in ${f}`); process.exit(1); } fs.writeFileSync(f, u); };
bump(".claude-plugin/plugin.json", /("version": )"[^"]*"/, `$1"${v}"`);
bump("skills/ui-diff/SKILL.md", /^(  version: )"[^"]*"$/m, `$1"${v}"`);
' "$V"

bash tests/selftest.sh
git commit -qam "Release v$V"
MAJOR="v${V%%.*}"
git tag -a "v$V" -m "ui-diff v$V"
git tag -f -a "$MAJOR" -m "ui-diff $MAJOR (latest: v$V)"
git push -q origin main "v$V"
git push -q -f origin "$MAJOR"
if [ -n "$NOTES" ]; then gh release create "v$V" --title "v$V" --notes-file "$NOTES"
else gh release create "v$V" --title "v$V" --generate-notes; fi
