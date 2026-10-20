import Foundation
import AppKit
import Darwin
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let bridge = MainActor.assumeIsolated { Bridge() }
let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MacOSAgentBridge")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let socketPath = directory.appendingPathComponent("helper.sock").path
// A per-app advisory lock prevents duplicate helpers from unlinking a live socket.
let lockFD = Darwin.open(directory.appendingPathComponent("helper.lock").path, O_CREAT | O_RDWR, 0o600)
guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { exit(0) }
unlink(socketPath)
let listener = socket(AF_UNIX, SOCK_STREAM, 0)
guard listener >= 0 else { fatalError("socket failed") }
var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
let bytes = socketPath.utf8CString
guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { fatalError("Socket path too long") }
withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
let bound = withUnsafePointer(to: &address) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
guard bound == 0 else { fatalError("bind failed") }
chmod(socketPath, 0o600)
guard listen(listener, 16) == 0 else { fatalError("listen failed") }
DispatchQueue.global(qos: .userInitiated).async {
    while true {
        let client = accept(listener, nil, nil); if client < 0 { continue }
        var uid: uid_t = 0; var gid: gid_t = 0
        guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { close(client); continue }
        DispatchQueue.global().async {
            var timeout = timeval(tv_sec: 10, tv_usec: 0); setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            var noSigPipe: Int32 = 1; setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            var data = Data(); var chunk = [UInt8](repeating: 0, count: 8192)
            while data.count < 2_000_000 { let n = read(client, &chunk, chunk.count); if n <= 0 { close(client); return }; data.append(contentsOf: chunk.prefix(n)); if data.contains(10) { break } }
            guard data.count < 2_000_000, let end = data.firstIndex(of: 10), let request = try? JSONSerialization.jsonObject(with: data[..<end]) as? [String: Any], let tool = request["tool"] as? String, let args = request["args"] as? [String: Any] else { close(client); return }
            Task { @MainActor in
                let response: [String: Any]
                do { response = ["ok": true, "data": try await bridge.handle(tool, args)] }
                catch let error as NativeError { response = ["ok": false, "error": ["code": error.code, "message": error.message]] }
                catch { response = ["ok": false, "error": ["code": "NATIVE_ERROR", "message": error.localizedDescription]] }
                if var payload = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) { payload.append(10); payload.withUnsafeBytes { raw in guard let base = raw.baseAddress else { return }; var sent = 0; while sent < raw.count { let n = write(client, base.advanced(by: sent), raw.count - sent); if n <= 0 { break }; sent += n } } }
                close(client)
            }
        }
    }
}
app.run()
