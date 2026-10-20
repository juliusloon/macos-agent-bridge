import Foundation
import AppKit
import EventKit
import Contacts
import ApplicationServices
@MainActor final class Bridge {
    let calendar = CalendarAdapter(); let contacts = ContactsAdapter(); let system = SystemAdapter()
    func status(_ value: Int) -> String { [0: "notDetermined", 1: "restricted", 2: "denied", 3: "authorized", 4: "fullAccess", 5: "writeOnly"][value] ?? "unknown:\(value)" }
    func permissions() -> [String: Any] { ["calendar": status(EKEventStore.authorizationStatus(for: .event).rawValue), "reminders": status(EKEventStore.authorizationStatus(for: .reminder).rawValue), "contacts": CNContactStore.authorizationStatus(for: .contacts).rawValue == 4 ? "limited" : status(CNContactStore.authorizationStatus(for: .contacts).rawValue), "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "automation": "per-application; system prompts on first scripting request", "shortcuts": "workflow-specific"] }
    func handle(_ name: String, _ args: [String: Any]) async throws -> Any {
        if name == "diagnostics" { return ["version": "0.1.0", "bundleId": Bundle.main.bundleIdentifier ?? "unbundled", "pid": ProcessInfo.processInfo.processIdentifier, "bundlePath": Bundle.main.bundlePath, "permissions": permissions(), "ipc": "user-only Unix domain socket"] }
        if name == "permissions_request" {
            let permission = try text(args, "permission")
            switch permission {
            case "calendar": guard try await calendar.store.requestFullAccessToEvents() else { throw fail("PERMISSION_NOT_GRANTED", "Calendar access was not granted. Check system Privacy & Security settings.") }; calendar.store.reset()
            case "reminders": guard try await calendar.store.requestFullAccessToReminders() else { throw fail("PERMISSION_NOT_GRANTED", "Reminders access was not granted. Check system Privacy & Security settings.") }; calendar.store.reset()
            case "contacts": _ = try await contacts.store.requestAccess(for: .contacts)
            case "accessibility": _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case "screenRecording": _ = CGRequestScreenCaptureAccess()
            default: throw fail("INVALID_PERMISSION", "Use calendar, reminders, contacts, accessibility or screenRecording")
            }
            return permissions()
        }
        if name.hasPrefix("calendar_") || name.hasPrefix("reminders_") { return try await calendar.handle(name, args) }
        if name.hasPrefix("contacts_") { return try contacts.handle(name, args) }
        if ["notes_", "mail_", "safari_", "music_"].contains(where: { name.hasPrefix($0) }) {
            guard let script = Bundle.main.url(forResource: "automation", withExtension: "js") else { throw fail("SCRIPT_MISSING", "Reinstall native helper") }
            let data = try JSONSerialization.data(withJSONObject: ["tool": name, "args": args]); let input = String(data: data, encoding: .utf8)!
            let output = try await runProcess("/usr/bin/osascript", ["-l", "JavaScript", script.path, input])
            guard let response = output.data(using: .utf8) else { throw fail("BAD_RESPONSE", "Automation returned invalid JSON") }
            return try JSONSerialization.jsonObject(with: response)
        }
        return try await system.handle(name, args)
    }
}
