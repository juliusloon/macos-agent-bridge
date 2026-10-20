#!/bin/bash
set -euo pipefail
BASE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/MacOSAgentBridge"
if /usr/sbin/lsof -t "$SUPPORT/helper.lock" >/dev/null 2>&1; then
  echo 'Close MacOS Agent Bridge Helper in Activity Monitor before reinstalling.' >&2
  exit 1
fi
mkdir -p "$SUPPORT" "$HOME/Applications" "$HOME/Documents/Agent Bridge Workspace"
chmod 700 "$SUPPORT" "$HOME/Documents/Agent Bridge Workspace"
/usr/bin/ditto "$BASE/Runtime" "$SUPPORT/runtime"
/usr/bin/ditto "$BASE/Native/MacOS Agent Bridge Helper.app" "$HOME/Applications/MacOS Agent Bridge Helper.app"
codesign --verify --strict "$HOME/Applications/MacOS Agent Bridge Helper.app"
cat > "$SUPPORT/bridge" <<'LAUNCHER'
#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)/runtime"
if [[ "${1:-}" == '--serve' ]]; then
  shift
  exec "$ROOT/bin/node" "$ROOT/dist/mcp-server/src/server.js" "$@"
else
  exec "$ROOT/bin/node" "$ROOT/dist/mcp-server/src/cli.js" "$@"
fi
LAUNCHER
chmod 700 "$SUPPORT/bridge"
"$SUPPORT/runtime/bin/node" "$BASE/configure.cjs" "$BASE/Extension" "$SUPPORT/bridge"
/usr/bin/open -g "$HOME/Applications/MacOS Agent Bridge Helper.app"
echo "Ready. Tinycast → Settings → Extensions → Add from folder → $BASE/Extension"
echo 'Then connect MCP using the Connect Tinycast AI Chat command.'
