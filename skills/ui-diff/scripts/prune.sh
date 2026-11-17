#!/usr/bin/env bash
# Remove a PR's images from the assets branch, e.g. once it's merged or closed.
# Comments that embedded them show broken images afterwards, so only prune PRs nobody
# needs to review any more.
#
# Usage: prune.sh <pr-number> [<pr-number>...]
#   (UI_DIFF_BRANCH, UI_DIFF_REMOTE, UI_DIFF_REPO, UI_DIFF_GIT_TOKEN: see assets.sh)
#
# Exits 0 when there's nothing to remove (no branch, or no images for that PR), 3 when
# there's no push access. Doesn't push at all when nothing changed.
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: prune.sh <pr-number>..." >&2; exit 1; }
. "$(dirname "$0")/assets.sh"

INFO=""
assets_check_access
assets_clone
[ -n "$LEASE" ] || { echo "no $BRANCH branch; nothing to prune" >&2; exit 0; }

GONE=()
for pr in "$@"; do
  if [ -d "pr-$pr" ]; then rm -rf "pr-$pr"; GONE+=("#$pr"); echo "pruned pr-$pr" >&2
  else echo "no images for PR #$pr on $BRANCH" >&2; fi
done
[ ${#GONE[@]} -gt 0 ] || exit 0

assets_push "ui-diff assets (pruned PR ${GONE[*]})"
