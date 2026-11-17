#!/usr/bin/env bash
# Install the ui-diff skill for the coding agents on this machine (or into one project).
# Any agent that reads the Agent Skills format (SKILL.md folders) can use it.
#
# Usage:
#   ./install.sh                      link into every detected agent's user-level skills dir
#   ./install.sh --agents codex,cursor
#   ./install.sh --project ~/Work/app link into <app>/.agents/skills (Codex, Cursor, Gemini CLI,
#                                     Copilot, OpenCode, Amp, Cline all read that folder)
#   ./install.sh --copy               copy instead of symlink (symlinks keep it in sync with this repo)
#   ./install.sh --uninstall          remove what this script installed
#   ./install.sh --list               show agents, their paths, and what's installed
#
# Claude Code is better served by the plugin (/plugin install ui-diff@ui-diff); pass
# --agents claude to link it as a plain skill instead.
# Existing folders named ui-diff that this script didn't create are never touched.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/skills/ui-diff" && pwd)"
NAME="ui-diff"
MARK=".installed-by-ui-diff"
AGENTS="" PROJECT="" MODE=link ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --copy) MODE=copy; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    --list) ACTION=list; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

ALL="codex cursor gemini copilot opencode goose windsurf amp roo kiro claude"

# agent -> user-level skills dir (paths per each agent's docs / the `skills` CLI table)
skills_dir() {
  case "$1" in
    codex) echo "$HOME/.agents/skills" ;;
    cursor) echo "$HOME/.cursor/skills" ;;
    gemini) echo "$HOME/.gemini/skills" ;;
    copilot) echo "$HOME/.copilot/skills" ;;
    opencode) echo "$HOME/.config/opencode/skills" ;;
    goose) echo "$HOME/.config/goose/skills" ;;
    windsurf) echo "$HOME/.codeium/windsurf/skills" ;;
    amp) echo "$HOME/.config/agents/skills" ;;
    roo) echo "$HOME/.roo/skills" ;;
    kiro) echo "$HOME/.kiro/skills" ;;
    claude) echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
    *) return 1 ;;
  esac
}

# Is the agent present on this machine? (its config dir exists)
detected() {
  case "$1" in
    codex) [ -d "$HOME/.codex" ] || [ -d "$HOME/.agents" ] ;;
    cursor) [ -d "$HOME/.cursor" ] ;;
    gemini) [ -d "$HOME/.gemini" ] ;;
    copilot) [ -d "$HOME/.copilot" ] ;;
    opencode) [ -d "$HOME/.config/opencode" ] ;;
    goose) [ -d "$HOME/.config/goose" ] ;;
    windsurf) [ -d "$HOME/.codeium/windsurf" ] ;;
    amp) [ -d "$HOME/.config/amp" ] || [ -d "$HOME/.config/agents" ] ;;
    roo) [ -d "$HOME/.roo" ] ;;
    kiro) [ -d "$HOME/.kiro" ] ;;
    claude) return 1 ;; # opt-in only; use the plugin
  esac
}

ours() { # was $1 installed by this script?
  { [ -L "$1" ] && [ "$(readlink "$1")" = "$SRC" ]; } || [ -f "$1/$MARK" ]
}

install_to() {
  local dir="$1" label="$2" dest="$1/$NAME"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if ! ours "$dest"; then echo "  skip $label: $dest exists and wasn't installed by this script"; return; fi
    rm -rf "$dest"
  fi
  mkdir -p "$dir"
  if [ "$MODE" = copy ]; then
    cp -R "$SRC" "$dest" && touch "$dest/$MARK"
  else
    ln -s "$SRC" "$dest"
  fi
  echo "  ✓ $label → $dest"
}

uninstall_from() {
  local dest="$1/$NAME" label="$2"
  if { [ -e "$dest" ] || [ -L "$dest" ]; } && ours "$dest"; then rm -rf "$dest"; echo "  removed $label: $dest"; fi
}

if [ -n "$PROJECT" ]; then
  [ -d "$PROJECT" ] || { echo "no such project dir: $PROJECT" >&2; exit 1; }
  P="$(cd "$PROJECT" && pwd)"
  case "$ACTION" in
    install) install_to "$P/.agents/skills" "project (.agents/skills)" ;;
    uninstall) uninstall_from "$P/.agents/skills" "project" ;;
    list) ls -la "$P/.agents/skills/$NAME" 2>/dev/null || echo "  not installed in $P" ;;
  esac
  exit 0
fi

TARGETS="${AGENTS//,/ }"
if [ -z "$TARGETS" ]; then
  for a in $ALL; do if detected "$a"; then TARGETS="$TARGETS $a"; fi; done
fi

SEEN=" "
for a in $TARGETS; do
  dir="$(skills_dir "$a")" || { echo "  unknown agent: $a (known: $ALL)" >&2; continue; }
  case "$ACTION" in
    list)
      state="not installed"
      if [ -e "$dir/$NAME" ]; then if ours "$dir/$NAME"; then state="installed"; else state="other ui-diff present"; fi; fi
      printf '  %-9s %-40s %s\n' "$a" "$dir" "$state" ;;
    install)
      # Several agents can share one dir (e.g. ~/.agents/skills); install once.
      case "$SEEN" in *" $dir "*) echo "  ✓ $a (shares $dir)"; continue ;; esac
      SEEN="$SEEN$dir "
      install_to "$dir" "$a" ;;
    uninstall) uninstall_from "$dir" "$a" ;;
  esac
done
[ -n "${TARGETS// /}" ] || echo "  no supported agents detected; use --agents or --project"
