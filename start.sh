#!/usr/bin/env sh
# Start TerminalMCP (Linux / macOS / Git Bash / WSL).
# Any extra arguments are passed straight through, e.g.
#   ./start.sh --shell bash --cwd /srv/app
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "TerminalMCP needs Node.js >= 18 on PATH. Install it from https://nodejs.org" >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $(node -v) is too old; TerminalMCP needs >= 18." >&2
  exit 1
fi

exec node "$DIR/bin/terminalmcp.js" "$@"
