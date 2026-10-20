#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npm run build:native
SUPPORT="$HOME/Library/Application Support/MacOSAgentBridge"
RUNTIME="$SUPPORT/runtime"
APP="$HOME/Applications/MacOS Agent Bridge Helper.app"
mkdir -p "$SUPPORT" "$RUNTIME/bin" "$RUNTIME/dist" "$HOME/Applications" "$HOME/Documents/Agent Bridge Workspace"
chmod 700 "$SUPPORT" "$HOME/Documents/Agent Bridge Workspace"
# Refuse to replace a live helper: its socket lock is authoritative.
if /usr/sbin/lsof -t "$SUPPORT/helper.lock" >/dev/null 2>&1; then
  echo 'Helper is running. Quit MacOS Agent Bridge Helper with Activity Monitor before reinstalling.' >&2
  exit 1
fi
/usr/bin/ditto artifacts/'MacOS Agent Bridge Helper.app' "$APP"
cp "$(node -p 'process.execPath')" "$RUNTIME/bin/node"
cp -R dist/mcp-server dist/shared "$RUNTIME/dist/"
node scripts/prepare-runtime.cjs "$RUNTIME"
npm ci --prefix "$RUNTIME" --omit=dev --ignore-scripts --no-audit --no-fund --workspaces=false
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
npm run build:extension
node scripts/configure-extension.cjs "$SUPPORT/bridge"
/usr/bin/open -g "$APP"
echo 'Installed. Import raycast-extension with Raycast Import Extension or run npm run dev -w raycast-extension.'
