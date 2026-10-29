#!/usr/bin/env bash
# Agent Command Post one-step installer. Usage: ./install.sh [--no-service | --uninstall]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  # Claude Code users often have node through nvm; load it if present.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it, then run this again." >&2
  exit 1
fi
exec node "$DIR/install.js" "$@"
