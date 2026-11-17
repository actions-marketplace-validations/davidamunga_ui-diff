#!/usr/bin/env bash
# One-time install of the screenshot/diff toolchain into a shared cache dir,
# so nothing is added to the user's project dependencies.
# Prints the tools dir on the last line; other scripts find it the same way.
set -euo pipefail

TOOLS_DIR="${UI_DIFF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/ui-diff}"
mkdir -p "$TOOLS_DIR"

if [ ! -f "$TOOLS_DIR/node_modules/.ui-diff-ok" ]; then
  echo "Installing ui-diff tools into $TOOLS_DIR ..." >&2
  cd "$TOOLS_DIR"
  [ -f package.json ] || echo '{"name":"ui-diff-tools","private":true}' > package.json
  npm install --silent --no-audit --no-fund playwright@^1 pixelmatch@5.3.0 pngjs@7 >&2
  npx --yes playwright install chromium >&2
  touch node_modules/.ui-diff-ok
fi

echo "$TOOLS_DIR"
