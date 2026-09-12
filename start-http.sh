#!/usr/bin/env sh
# Start TerminalMCP as a remote HTTP server (Linux / macOS / Git Bash / WSL).
#
# This script binds 0.0.0.0 on purpose: it exists for remote access. There is
# NO authentication — anyone who can reach the port gets a shell on this box.
# For a local-only server use ./start.sh --http instead (binds 127.0.0.1).
#
# Override with env vars or extra arguments:
#   PORT=9000 ./start-http.sh
#   ./start-http.sh --host 127.0.0.1 --shell gitbash
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8787}

if ! command -v node >/dev/null 2>&1; then
  echo "TerminalMCP needs Node.js >= 18 on PATH. Install it from https://nodejs.org" >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $(node -v) is too old; TerminalMCP needs >= 18." >&2
  exit 1
fi

exec node "$DIR/bin/terminalmcp.js" --http --host "$HOST" --port "$PORT" "$@"
