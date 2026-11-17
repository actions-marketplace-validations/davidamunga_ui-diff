#!/usr/bin/env bash
# Push a report bundle's images to an assets branch so they can be embedded in PR
# comments/descriptions. GitHub renders them inline, in private repos too (for anyone
# who can read the repo).
#
# Usage: publish.sh <report-dir> <pr-number> [head-sha]
# Prints the URL prefix on stdout; an image's URL is "<prefix>/<relative path>?raw=true".
#
#   UI_DIFF_PRUNE=1       also delete images of PRs that are no longer open
#   (UI_DIFF_BRANCH, UI_DIFF_REMOTE, UI_DIFF_REPO, UI_DIFF_GIT_TOKEN: see assets.sh)
#
# Exit codes: 3 = no push access (e.g. PR from a fork) → use manual mode.
#
# The branch is kept as a single commit (each publish replaces it), so `git clone`, which
# fetches every branch, only ever downloads the images that are currently referenced.
# Works in a throwaway clone; the user's checkout is never touched. prune.sh removes a
# PR's images once it's closed.
set -euo pipefail
# stdout carries only the URL prefix (callers capture it); everything else goes to stderr.
exec 3>&1 1>&2

REPORT="$(cd "$1" && pwd)"
PR="$2"
SHA="${3:-$(git rev-parse --short HEAD)}"
. "$(dirname "$0")/assets.sh"
DEST="pr-$PR/$SHA"

INFO=""
assets_check_access
[ "${INFO##* }" = "PUBLIC" ] && echo "note: $REPO is public, so these screenshots will be publicly visible" >&2

assets_clone

if [ "${UI_DIFF_PRUNE:-}" = 1 ] && [ -z "${UI_DIFF_REPO:-}" ]; then
  OPEN=" $(gh pr list --repo "$REPO" --state open --limit 1000 --json number -q '.[].number' | tr '\n' ' ') "
  for d in pr-*; do
    [ -d "$d" ] || continue
    n="${d#pr-}"
    [[ "$OPEN" == *" $n "* ]] || [ "$n" = "$PR" ] || { rm -rf "$d"; echo "pruned $d" >&2; }
  done
fi

# Images only; results.json etc. stay local. Older SHAs of this PR are kept so earlier
# comments/edits don't show broken images.
rm -rf "$DEST"
mkdir -p "$DEST"
(cd "$REPORT" && find . -name '*.png' | while read -r f; do
  mkdir -p "$TMP/$DEST/$(dirname "$f")" && cp "$f" "$TMP/$DEST/$f"
done)

assets_push "ui-diff assets (latest: PR #$PR @ $SHA)"
echo "https://github.com/$REPO/blob/$BRANCH/$DEST" >&3
