import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
@MainActor final class SystemAdapter {
    func app(_ app: NSRunningApplication) -> [String: Any] { ["pid": app.processIdentifier, "name": nullable(app.localizedName), "bundleId": nullable(app.bundleIdentifier)] }
    func focused() throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw fail("PERMISSION_REQUIRED", "Enable Accessibility for MacOS Agent Bridge Helper in System Settings.") }
        guard let front = NSWorkspace.shared.frontmostApplication else { throw fail("NOT_FOUND", "No frontmost application") }
        return AXUIElementCreateApplication(front.processIdentifier)
    }
    func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef {
        var value: CFTypeRef?; let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard error == .success, let value else { throw fail("ACCESSIBILITY_UNAVAILABLE", "Focused application does not expose \(name). AX error: \(error.rawValue)") }; return value
    }
    func window() throws -> AXUIElement { let v = try attribute(focused(), kAXFocusedWindowAttribute); guard CFGetTypeID(v) == AXUIElementGetTypeID() else { throw fail("NOT_FOUND", "No focused window") }; return unsafeBitCast(v, to: AXUIElement.self) }
    func frame(_ element: AXUIElement) throws -> [String: Any] {
        let p = try attribute(element, kAXPositionAttribute); let s = try attribute(element, kAXSizeAttribute)
        guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { throw fail("ACCESSIBILITY_UNAVAILABLE", "Window geometry unavailable") }
        var point = CGPoint.zero; var size = CGSize.zero
        AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point); AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size)
        return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
    }
    func handle(_ name: String, _ args: [String: Any]) async throws -> Any {
        switch name {
        case "clipboard_read": return ["text": nullable(NSPasteboard.general.string(forType: .string)), "changeCount": NSPasteboard.general.changeCount]
        case "clipboard_write": let board = NSPasteboard.general; board.clearContents(); guard board.setString(try text(args, "text"), forType: .string) else { throw fail("CLIPBOARD_FAILED", "Failed to set clipboard") }; return ["changeCount": board.changeCount]
        case "system_get_frontmost_app": guard let front = NSWorkspace.shared.frontmostApplication else { throw fail("NOT_FOUND", "No frontmost app") }; return app(front)
        case "system_list_apps": return ["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(app)]
        case "system_open_app": let id = try text(args, "bundleId"); guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { throw fail("NOT_FOUND", "App not installed") }; let running = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()); return app(running)
        case "system_activate_app": guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: try text(args, "bundleId")).first else { throw fail("NOT_FOUND", "App is not running") }; return ["activated": target.activate(), "app": app(target)]
        case "system_open_url": guard let url = URL(string: try text(args, "url")), ["https", "http"].contains(url.scheme), url.user == nil else { throw fail("INVALID_URL", "Only HTTP(S) URLs without credentials") }; return ["opened": NSWorkspace.shared.open(url), "url": url.absoluteString]
        case "finder_open_file": let url = URL(fileURLWithPath: try text(args, "path")); return ["opened": NSWorkspace.shared.open(url), "path": url.path]
        case "finder_trash_file": let url = URL(fileURLWithPath: try text(args, "path")); var resulting: NSURL?; try FileManager.default.trashItem(at: url, resultingItemURL: &resulting); return ["originalPath": url.path, "trashPath": nullable(resulting?.path)]
        case "system_status": let info = ProcessInfo.processInfo; return ["os": info.operatingSystemVersionString, "uptimeSeconds": info.systemUptime, "processorCount": info.processorCount, "physicalMemoryBytes": info.physicalMemory, "timezone": TimeZone.current.identifier]
        case "system_get_selected_text": let app = try focused(); let raw = try attribute(app, kAXFocusedUIElementAttribute); guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw fail("NOT_FOUND", "No focused text element") }; let element = unsafeBitCast(raw, to: AXUIElement.self); return ["text": try attribute(element, kAXSelectedTextAttribute) as? String ?? ""]
        case "system_get_active_window": let w = try window(); return ["title": (try? attribute(w, kAXTitleAttribute) as? String) ?? "", "frame": try frame(w)]
        case "system_set_window_frame": let w = try window(); var point = CGPoint(x: args["x"] as? Int ?? 0, y: args["y"] as? Int ?? 0); var size = CGSize(width: args["width"] as? Int ?? 800, height: args["height"] as? Int ?? 600); guard let position = AXValueCreate(.cgPoint, &point), let dimensions = AXValueCreate(.cgSize, &size) else { throw fail("INVALID_ARGUMENTS", "Bad geometry") }; guard AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, position) == .success, AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, dimensions) == .success else { throw fail("WINDOW_NOT_SETTABLE", "Application refused window geometry") }; return try frame(w)
        case "system_list_windows": let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []; return ["screenRecordingGranted": CGPreflightScreenCaptureAccess(), "windows": raw.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.map { ["id": $0[kCGWindowNumber as String] ?? 0, "owner": $0[kCGWindowOwnerName as String] ?? "", "title": $0[kCGWindowName as String] ?? NSNull(), "pid": $0[kCGWindowOwnerPID as String] ?? 0, "bounds": $0[kCGWindowBounds as String] ?? [:]] }]
        case "system_capture_screen":
            guard CGPreflightScreenCaptureAccess() else { throw fail("PERMISSION_REQUIRED", "Enable Screen Recording for MacOS Agent Bridge Helper") }
            let path = try text(args, "outputPath"); guard !FileManager.default.fileExists(atPath: path) else { throw fail("DESTINATION_EXISTS", "Refusing to overwrite screenshot") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let filter: SCContentFilter; let config = SCStreamConfiguration()
            if let id = args["windowId"] as? UInt32 { guard let w = content.windows.first(where: { $0.windowID == id }) else { throw fail("NOT_FOUND", "Window no longer exists") }; filter = SCContentFilter(desktopIndependentWindow: w); config.width = Int(w.frame.width * 2); config.height = Int(w.frame.height * 2) }
            else { guard let display = content.displays.first else { throw fail("NOT_FOUND", "No display") }; filter = SCContentFilter(display: display, excludingWindows: []); config.width = display.width; config.height = display.height }
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let rep = NSBitmapImageRep(cgImage: image); guard let data = rep.representation(using: .png, properties: [:]) else { throw fail("CAPTURE_FAILED", "PNG encoding failed") }
            try data.write(to: URL(fileURLWithPath: path), options: .withoutOverwriting); return ["path": path, "width": image.width, "height": image.height, "bytes": data.count]
        case "shortcuts_list": let output = try await runProcess("/usr/bin/shortcuts", ["list"]); return ["shortcuts": output.split(separator: "\n").map(String.init)]
        case "shortcuts_run": let name = try text(args, "name"); let list = try await runProcess("/usr/bin/shortcuts", ["list"]); guard list.split(separator: "\n").contains(Substring(name)) else { throw fail("NOT_FOUND", "Shortcut name is not installed") }; let out = try await runProcess("/usr/bin/shortcuts", ["run", name], timeout: 30); return ["name": name, "output": out]
        default: throw fail("UNKNOWN_TOOL", name)
        }
    }
}
