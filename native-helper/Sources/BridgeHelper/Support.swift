import Foundation
struct NativeError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) -> NativeError { NativeError(code: code, message: message) }
func text(_ args: [String: Any], _ key: String) throws -> String { guard let s = args[key] as? String else { throw fail("INVALID_ARGUMENTS", "Missing string: \(key)") }; return s }
func date(_ args: [String: Any], _ key: String) throws -> Date {
    let value = try text(args, key)
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = formatter.date(from: value) { return d }
    formatter.formatOptions = [.withInternetDateTime]
    guard let d = formatter.date(from: value) else { throw fail("INVALID_DATE", "Invalid ISO date: \(key)") }; return d
}
func iso(_ d: Date?) -> Any { guard let d else { return NSNull() }; return ISO8601DateFormatter().string(from: d) }
func nullable(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }
func limit(_ args: [String: Any], _ fallback: Int = 100) -> Int { min(500, max(1, args["limit"] as? Int ?? fallback)) }
final class ProcessBuffer: @unchecked Sendable {
    let lock = NSLock(); private var output = Data(); private var errors = Data(); private var expired = false
    func append(_ data: Data, error: Bool = false) { lock.lock(); defer { lock.unlock() }; if error { if errors.count < 65536 { errors.append(data) } } else if output.count < 4_000_000 { output.append(data) } }
    func markExpired() { lock.lock(); expired = true; lock.unlock() }
    func snapshot() -> (Data, Data, Bool) { lock.lock(); defer { lock.unlock() }; return (output, errors, expired) }
}
func runProcess(_ file: String, _ argv: [String], timeout: TimeInterval = 30) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
        let process = Process(); process.executableURL = URL(fileURLWithPath: file); process.arguments = argv
        let output = Pipe(); let errors = Pipe(); process.standardOutput = output; process.standardError = errors
        let buffer = ProcessBuffer()
        output.fileHandleForReading.readabilityHandler = { buffer.append($0.availableData) }
        errors.fileHandleForReading.readabilityHandler = { buffer.append($0.availableData, error: true) }
        process.terminationHandler = { p in
            output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
            buffer.append(output.fileHandleForReading.readDataToEndOfFile()); buffer.append(errors.fileHandleForReading.readDataToEndOfFile(), error: true)
            let (out, err, expired) = buffer.snapshot()
            if expired { continuation.resume(throwing: fail("NATIVE_TIMEOUT", "Native utility timed out; inspect before retry.")) }
            else if p.terminationStatus != 0 {
                let message = String(data: err, encoding: .utf8) ?? "Native utility failed"
                continuation.resume(throwing: fail(message.contains("-1743") || message.contains("not authorized") ? "PERMISSION_DENIED" : "AUTOMATION_FAILED", message))
            } else { continuation.resume(returning: String(data: out, encoding: .utf8) ?? "") }
        }
        do { try process.run() } catch { continuation.resume(throwing: error); return }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if process.isRunning { buffer.markExpired(); process.terminate() } }
    }
}
