#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'Release packaging requires macOS.' >&2
  exit 1
fi
ARCH="$(node -p 'process.arch')"
if [[ "$ARCH" != 'arm64' && "$ARCH" != 'x64' ]]; then
  echo "Unsupported release architecture: $ARCH" >&2
  exit 1
fi
# Fixed official distribution; do not copy any user's installed runtime or state.
NODE_VERSION="${BRIDGE_NODE_VERSION:-22.23.1}"
if [[ ! "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'BRIDGE_NODE_VERSION must be a numeric Node release version.' >&2
  exit 1
fi
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/macos-agent-bridge-release.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
export COPYFILE_DISABLE=1
npm run build
npm run build:extension
BRIDGE_CONFIGURATION=release BRIDGE_SIGN_IDENTITY=- npm run build:native
RELEASE="$STAGE/MacOS Agent Bridge"
mkdir -p "$RELEASE/Extension" "$RELEASE/Native" "$RELEASE/Runtime/bin" "$RELEASE/Runtime/dist" "$RELEASE/docs/licenses"
/usr/bin/ditto --noextattr --norsrc --noqtn raycast-extension/dist "$RELEASE/Extension"
# No machine-specific launch path is distributed; Install.command sets it for its user.
node scripts/sanitize-package.cjs "$RELEASE/Extension"
/usr/bin/ditto --noextattr --norsrc --noqtn 'artifacts/MacOS Agent Bridge Helper.app' "$RELEASE/Native/MacOS Agent Bridge Helper.app"
curl --fail --location --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" --output "$STAGE/$NODE_ARCHIVE"
curl --fail --location --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" --output "$STAGE/SHASUMS256.txt"
(cd "$STAGE" && awk -v name="$NODE_ARCHIVE" '$2 == name {print}' SHASUMS256.txt > node-sha256.txt && test -s node-sha256.txt && shasum -a 256 -c node-sha256.txt)
tar -xzf "$STAGE/$NODE_ARCHIVE" -C "$STAGE"
cp "$STAGE/node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" "$RELEASE/Runtime/bin/node"
cp "$STAGE/node-v${NODE_VERSION}-darwin-${ARCH}/LICENSE" "$RELEASE/docs/licenses/Node-LICENSE.txt"
cp -R dist/mcp-server dist/shared "$RELEASE/Runtime/dist/"
node scripts/prepare-runtime.cjs "$RELEASE/Runtime"
(cd "$RELEASE/Runtime" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspaces=false)
cp README.md README-EN.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md "$RELEASE/"
# Only public documentation; validation logs, generated configs and machine state stay local.
for document in docs/*.md; do cp "$document" "$RELEASE/docs/"; done
cp docs/capability-coverage.json docs/mcp-client.example.json "$RELEASE/docs/"
if [[ -d assets ]]; then /usr/bin/ditto --noextattr --norsrc --noqtn assets "$RELEASE/assets"; fi
cp scripts/install-package.sh "$RELEASE/Install.command"
cp scripts/configure-package.cjs "$RELEASE/configure.cjs"
chmod +x "$RELEASE/Install.command"
node scripts/scan-release.cjs "$RELEASE"
mkdir -p release
ARCHIVE="macos-agent-bridge-macos-${ARCH}.zip"
/usr/bin/ditto -c -k --noextattr --norsrc --noqtn --keepParent "$RELEASE" "$PWD/release/$ARCHIVE"
(cd release && shasum -a 256 "$ARCHIVE" > SHA256SUMS)
printf 'Created release/%s and release/SHA256SUMS\n' "$ARCHIVE"
