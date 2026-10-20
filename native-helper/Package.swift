// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "MacOSAgentBridgeHelper", platforms: [.macOS(.v14)], products: [.executable(name: "BridgeHelper", targets: ["BridgeHelper"])], targets: [.executableTarget(name: "BridgeHelper")])
