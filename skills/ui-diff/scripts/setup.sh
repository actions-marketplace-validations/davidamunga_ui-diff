#!/usr/bin/env bash
# One-time install of the screenshot/diff toolchain into a shared cache dir,
# so nothing is added to the user's project dependencies.
# Prints the tools dir on the last line; other scripts find it the same way.
set -euo pipefail

TOOLS_DIR="${UI_DIFF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/ui-diff}"
mkdir -p "$TOOLS_DIR"

# The marker records which package set is installed, so adding a package here
# reinstalls for people who already have an older set.
PKGS="playwright@^1 pixelmatch@5.3.0 pngjs@7 axe-core@4.10.3"
MARK="$TOOLS_DIR/node_modules/.ui-diff-ok"

if [ "$(cat "$MARK" 2>/dev/null)" != "$PKGS" ]; then
  echo "Installing ui-diff tools into $TOOLS_DIR ..." >&2
  cd "$TOOLS_DIR"
  [ -f package.json ] || echo '{"name":"ui-diff-tools","private":true}' > package.json
  # shellcheck disable=SC2086
  npm install --silent --no-audit --no-fund $PKGS >&2
  # UI_DIFF_WITH_DEPS=1 also installs the system libraries Chromium needs (CI, fresh Linux; uses sudo).
  npx --yes playwright install ${UI_DIFF_WITH_DEPS:+--with-deps} chromium >&2
  echo "$PKGS" > "$MARK"
fi

echo "$TOOLS_DIR"
