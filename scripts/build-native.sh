#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIGURATION="${BRIDGE_CONFIGURATION:-debug}"
BUILD_ARGS=(--package-path native-helper --configuration "$CONFIGURATION")
if [[ "$CONFIGURATION" == 'release' ]]; then
  BUILD_ARGS+=(-Xswiftc -file-prefix-map -Xswiftc "$PWD=/src/macos-agent-bridge" -Xswiftc -debug-prefix-map -Xswiftc "$PWD=/src/macos-agent-bridge" -Xswiftc -gnone)
fi
swift build "${BUILD_ARGS[@]}"
APP="$PWD/artifacts/MacOS Agent Bridge Helper.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "native-helper/.build/$CONFIGURATION/BridgeHelper" "$APP/Contents/MacOS/BridgeHelper"
if [[ "$CONFIGURATION" == 'release' ]]; then
  /usr/bin/strip -S "$APP/Contents/MacOS/BridgeHelper"
fi
cp native-helper/Info.plist "$APP/Contents/Info.plist"
cp native-helper/Scripts/automation.js "$APP/Contents/Resources/automation.js"
# Local builds use ad-hoc signing unless a developer explicitly selects an identity.
SIGN_ID="${BRIDGE_SIGN_IDENTITY:--}"
codesign --force --options runtime --entitlements native-helper/entitlements.plist --sign "$SIGN_ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"
