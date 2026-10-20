import Foundation
import EventKit
@MainActor final class CalendarAdapter {
    let store = EKEventStore()
    func require(_ entity: EKEntityType) throws {
        guard EKEventStore.authorizationStatus(for: entity) == .fullAccess else { throw fail("PERMISSION_REQUIRED", "Grant \(entity == .event ? "calendar" : "reminders") access in Raycast → macOS Agent Bridge → Request Permission.") }
    }
    func calendar(_ item: EKCalendar) -> [String: Any] { ["id": item.calendarIdentifier, "title": item.title, "writable": item.allowsContentModifications, "source": item.source.title] }
    func event(_ item: EKEvent) -> [String: Any] { ["id": item.eventIdentifier ?? "", "calendarId": item.calendar.calendarIdentifier, "title": item.title ?? "", "start": iso(item.startDate), "end": iso(item.endDate), "timezone": nullable(item.timeZone?.identifier), "allDay": item.isAllDay, "location": nullable(item.location), "notes": nullable(item.notes), "recurring": item.hasRecurrenceRules, "availability": item.availability.rawValue, "status": item.status.rawValue] }
    func reminder(_ item: EKReminder) -> [String: Any] { ["id": item.calendarItemIdentifier, "listId": item.calendar.calendarIdentifier, "title": item.title ?? "", "notes": nullable(item.notes), "completed": item.isCompleted, "priority": item.priority, "due": iso(item.dueDateComponents?.date)] }
    func events(_ args: [String: Any]) throws -> [EKEvent] {
        let start = try date(args, "start"); let end = try date(args, "end")
        guard end > start, end.timeIntervalSince(start) <= 366*86400 else { throw fail("INVALID_RANGE", "Calendar range must be positive and <=366 days.") }
        let ids = args["calendarIds"] as? [String]
        let calendars = ids.map { list in store.calendars(for: .event).filter { list.contains($0.calendarIdentifier) } }
        if let ids, let calendars, calendars.count != Set(ids).count { throw fail("NOT_FOUND", "A requested calendar is inaccessible.") }
        return store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars)).sorted { $0.startDate < $1.startDate }
    }
    func handle(_ name: String, _ args: [String: Any]) async throws -> Any {
        let reminders = name.hasPrefix("reminders_"); try require(reminders ? .reminder : .event)
        if name == "calendar_list_calendars" || name == "reminders_list_lists" { return ["calendars": store.calendars(for: reminders ? .reminder : .event).map(calendar)] }
        if name == "calendar_list_events" { let all = try events(args); return ["events": Array(all.prefix(limit(args))).map(event), "truncated": all.count > limit(args), "timezone": try text(args, "timezone")] }
        if name == "calendar_find_free_slots" {
            var cursor = try date(args, "start"); let end = try date(args, "end"); let duration = Double(args["durationMinutes"] as? Int ?? 30) * 60
            var slots: [[String: Any]] = []
            for item in try events(args) where item.availability != .free && item.status != .canceled {
                if item.startDate.timeIntervalSince(cursor) >= duration { slots.append(["start": iso(cursor), "end": iso(min(item.startDate, end))]) }
                cursor = max(cursor, item.endDate); if cursor >= end { break }
            }
            if end.timeIntervalSince(cursor) >= duration { slots.append(["start": iso(cursor), "end": iso(end)]) }
            return ["slots": slots, "timezone": try text(args, "timezone")]
        }
        if name.hasPrefix("calendar_") {
            let item: EKEvent
            if name == "calendar_create_event" { item = EKEvent(eventStore: store); item.calendar = store.defaultCalendarForNewEvents }
            else { guard let found = store.event(withIdentifier: try text(args, "id")) else { throw fail("NOT_FOUND", "Event not found") }; item = found }
            if let cid = args["calendarId"] as? String { item.calendar = store.calendar(withIdentifier: cid) }
            guard let target = item.calendar, target.allowsContentModifications else { throw fail("READ_ONLY", "No writable destination calendar") }
            if name == "calendar_delete_event" { let previous = event(item); try store.remove(item, span: .thisEvent, commit: true); return ["deleted": previous] }
            if let title = args["title"] as? String { item.title = title }
            if args["start"] != nil { item.startDate = try date(args, "start") }
            if args["end"] != nil { item.endDate = try date(args, "end") }
            if let tz = args["timezone"] as? String { guard let zone = TimeZone(identifier: tz) else { throw fail("INVALID_TIMEZONE", "Unknown time zone") }; item.timeZone = zone }
            if let v = args["location"] as? String { item.location = v }; if let v = args["notes"] as? String { item.notes = v }
            guard let start = item.startDate, let end = item.endDate, end > start else { throw fail("INVALID_RANGE", "Event end must be after start") }
            try store.save(item, span: .thisEvent, commit: true); return event(item)
        }
        if name == "reminders_list_tasks" {
            let calendars: [EKCalendar]?
            if let id = args["listId"] as? String { guard let c = store.calendar(withIdentifier: id), c.allowedEntityTypes.contains(.reminder) else { throw fail("NOT_FOUND", "Reminder list not found") }; calendars = [c] } else { calendars = nil }
            let predicate = store.predicateForReminders(in: calendars)
            let items: [EKReminder] = await withCheckedContinuation { cont in store.fetchReminders(matching: predicate) { cont.resume(returning: $0 ?? []) } }
            let filtered = items.filter { args["completed"] == nil || $0.isCompleted == (args["completed"] as? Bool) }
            return ["tasks": Array(filtered.prefix(limit(args))).map(reminder), "truncated": filtered.count > limit(args)]
        }
        let item: EKReminder
        if name == "reminders_create_task" { item = EKReminder(eventStore: store); item.calendar = store.defaultCalendarForNewReminders() }
        else { guard let found = store.calendarItem(withIdentifier: try text(args, "id")) as? EKReminder else { throw fail("NOT_FOUND", "Reminder not found") }; item = found }
        if let id = args["listId"] as? String { item.calendar = store.calendar(withIdentifier: id) }
        guard let target = item.calendar, target.allowsContentModifications else { throw fail("READ_ONLY", "No writable reminder list") }
        if name == "reminders_delete_task" { let previous = reminder(item); try store.remove(item, commit: true); return ["deleted": previous] }
        if let v = args["title"] as? String { item.title = v }; if let v = args["notes"] as? String { item.notes = v }; if let v = args["priority"] as? Int { item.priority = v }
        if args["due"] != nil { var cal = Calendar(identifier: .gregorian); guard let tz = TimeZone(identifier: try text(args, "timezone")) else { throw fail("INVALID_TIMEZONE", "Unknown time zone") }; cal.timeZone = tz; item.dueDateComponents = cal.dateComponents([.year,.month,.day,.hour,.minute,.second,.timeZone], from: try date(args, "due")) }
        if let v = args["completed"] as? Bool { item.isCompleted = v }
        try store.save(item, commit: true); return reminder(item)
    }
}
