#!/usr/bin/env sh
# Start TerminalMCP on HTTP and open a Cloudflare quick tunnel to it, so the
# server can be reached from outside this network — no port forwarding, no
# router, no account. Every tool group is enabled.
#
#   READ THIS BEFORE USING IT
#
#   The tunnel gives out a public https://<random>.trycloudflare.com URL and
#   there is NO authentication. Anyone who has that URL has a full shell on
#   this machine. The hostname is random, but random is not secret: it goes
#   wherever you paste it, and a paste into the wrong window is enough.
#
#   Stop the server when you are finished. The URL dies with it, and the next
#   run gets a different one.
#
# Needs cloudflared on PATH:
#   macOS:  brew install cloudflared
#   Linux:  https://github.com/cloudflare/cloudflared/releases/latest
#
# The server binds 127.0.0.1 here on purpose: cloudflared reaches it locally,
# so the port does not also need to be open on the local network.
#
# Override with env vars or extra arguments:
#   PORT=9000 ./start-http-tunnel.sh
#   ./start-http-tunnel.sh --tools web --plugin fivem
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT=${PORT:-8787}
TOOLS=${TOOLS:-all}

if ! command -v node >/dev/null 2>&1; then
  echo "TerminalMCP needs Node.js >= 18 on PATH. Install it from https://nodejs.org" >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $(node -v) is too old; TerminalMCP needs >= 18." >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "" >&2
  echo "cloudflared was not found on PATH. The server will start, but without a" >&2
  echo "tunnel it is only reachable on this machine." >&2
  echo "  macOS: brew install cloudflared" >&2
  echo "" >&2
fi

# --tools all is every group, which is a lot of schema. Some MCP clients cap how
# much they accept and drop the rest without saying so; if a tool goes missing
# in your client, trim it — ./start-http-tunnel.sh --tools web
exec node "$DIR/bin/terminalmcp.js" --http --port "$PORT" --tunnel --tools "$TOOLS" "$@"
