import Foundation
import Capacitor
import EventKit
import UIKit

/// Native bridge to Apple Calendar (EventKit) for PRCD.
///
/// The JavaScript contract lives in `src/calendar/bridge.ts` (`PRCDCalendarPlugin` interface); the
/// synchronisation logic, conflict handling and duplicate prevention are in `src/calendar/sync.ts`.
/// This file is deliberately thin: it translates between EventKit and plain JSON.
///
/// Rules enforced HERE (in addition to the JS layer), so a bug above can never harm other apps' data:
///  - `updateEvent` / `deleteEvent` only touch events whose `url` carries PRCD's `prcd://` marker.
///  - The only calendar this plugin ever creates is the app-managed one ("Procedo").
///  - No permission prompt is shown unless JS calls `requestFullAccess` (after a user action).
///
/// STATUS: written on Windows, **never compiled or run** (no Xcode available). See docs/IOS_BUILD.md for the
/// verification checklist.
@objc(PRCDCalendarPlugin)
public class PRCDCalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PRCDCalendarPlugin"
    public let jsName = "PRCDCalendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestFullAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listCalendars", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ensureManagedCalendar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private static let markerPrefix = "prcd://"
    private static let accentHex = "#1F35C7"

    private var store = EKEventStore()
    private var storeObserver: NSObjectProtocol?
    private let work = DispatchQueue(label: "app.prcd.calendar", qos: .userInitiated)

    // MARK: - Lifecycle

    override public func load() {
        // EKEventStoreChanged fires when ANY app (or iCloud) changes calendar data. JS debounces and re-syncs.
        storeObserver = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("storeChanged", data: [:])
        }
    }

    deinit {
        if let o = storeObserver { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: - Permission

    private func statusString() -> String {
        let s = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            switch s {
            case .notDetermined: return "notDetermined"
            case .restricted: return "restricted"
            case .denied: return "denied"
            case .fullAccess: return "fullAccess"
            case .writeOnly: return "writeOnly"   // "add events only": NOT enough to read or sync
            @unknown default: return "denied"
            }
        } else {
            switch s {
            case .notDetermined: return "notDetermined"
            case .restricted: return "restricted"
            case .denied: return "denied"
            default: return "fullAccess"          // .authorized (pre-iOS 17 only has all-or-nothing access)
            }
        }
    }

    private var hasFullAccess: Bool { statusString() == "fullAccess" }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["status": statusString()])
    }

    /// Shows the system prompt (only the first time; later calls just return the current status).
    @objc func requestFullAccess(_ call: CAPPluginCall) {
        guard statusString() == "notDetermined" else {
            call.resolve(["status": statusString()])
            return
        }
        let done: (Bool, Error?) -> Void = { [weak self] _, _ in
            guard let self = self else { return }
            self.work.async {
                // A store created before the grant can return stale data: start fresh.
                self.store = EKEventStore()
                call.resolve(["status": self.statusString()])
            }
        }
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents(completion: done)
        } else {
            store.requestAccess(to: .event, completion: done)
        }
    }

    private func requireAccess(_ call: CAPPluginCall) -> Bool {
        if hasFullAccess { return true }
        call.reject("Accesso a Calendario non autorizzato.", "ACCESS_DENIED")
        return false
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:]) { _ in call.resolve() }
            } else {
                call.resolve()
            }
        }
    }

    // MARK: - Calendars

    @objc func listCalendars(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        work.async {
            let cals = self.store.calendars(for: .event).map { self.json(of: $0) }
            call.resolve(["calendars": cals])
        }
    }

    /// Finds or creates the app-managed calendar. Order: known id → same-named writable calendar → create.
    /// Never touches any other calendar.
    @objc func ensureManagedCalendar(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("Nome del calendario mancante", "BAD_ARGS")
            return
        }
        let knownId = call.getString("knownId")
        work.async {
            if let id = knownId, let existing = self.store.calendar(withIdentifier: id), existing.allowsContentModifications {
                call.resolve(self.json(of: existing))
                return
            }
            if let byName = self.store.calendars(for: .event).first(where: { $0.title == name && $0.allowsContentModifications && $0.type != .subscription && $0.type != .birthday }) {
                call.resolve(self.json(of: byName))
                return
            }
            let cal = EKCalendar(for: .event, eventStore: self.store)
            cal.title = name
            cal.cgColor = Self.color(fromHex: Self.accentHex).cgColor
            guard let source = self.preferredSource() else {
                call.reject("Nessuna sorgente di calendario disponibile per creare «\(name)».", "NO_SOURCE")
                return
            }
            cal.source = source
            do {
                try self.store.saveCalendar(cal, commit: true)
                call.resolve(self.json(of: cal))
            } catch {
                call.reject("Impossibile creare il calendario «\(name)»: \(error.localizedDescription)", "CREATE_CALENDAR_FAILED", error)
            }
        }
    }

    /// iCloud (CalDAV) if the user's default calendar lives there, else any CalDAV source, else "On My iPad".
    private func preferredSource() -> EKSource? {
        if let def = store.defaultCalendarForNewEvents?.source, def.sourceType == .calDAV { return def }
        if let dav = store.sources.first(where: { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }) { return dav }
        if let local = store.sources.first(where: { $0.sourceType == .local }) { return local }
        return store.defaultCalendarForNewEvents?.source ?? store.sources.first
    }

    // MARK: - Events

    @objc func fetchEvents(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        let ids = Set((call.getArray("calendarIds") as? [String]) ?? [])
        guard let from = call.getString("from"), let to = call.getString("to"),
              let start = Self.parseDay(from, endOfDay: false), let end = Self.parseDay(to, endOfDay: true) else {
            call.reject("Intervallo di date non valido", "BAD_ARGS")
            return
        }
        work.async {
            let calendars = self.store.calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
            if calendars.isEmpty {
                call.resolve(["events": [Any]()])
                return
            }
            let predicate = self.store.predicateForEvents(withStart: start, end: end, calendars: calendars)
            let events = self.store.events(matching: predicate).map { self.json(of: $0) }
            call.resolve(["events": events])
        }
    }

    @objc func getEvent(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        guard let id = call.getString("id") else {
            call.reject("Identificatore mancante", "BAD_ARGS")
            return
        }
        work.async {
            if let ev = self.event(for: id) {
                call.resolve(["event": self.json(of: ev)])
            } else {
                call.resolve(["event": NSNull()])
            }
        }
    }

    @objc func createEvent(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        guard let calendarId = call.getString("calendarId") else {
            call.reject("Calendario di destinazione mancante", "BAD_ARGS")
            return
        }
        guard let url = call.getString("url"), url.hasPrefix(Self.markerPrefix) else {
            call.reject("Marcatore PRCD mancante", "BAD_ARGS")
            return
        }
        work.async {
            guard let cal = self.store.calendar(withIdentifier: calendarId), cal.allowsContentModifications else {
                call.reject("Il calendario di destinazione non è modificabile.", "CALENDAR_NOT_WRITABLE")
                return
            }
            let ev = EKEvent(eventStore: self.store)
            ev.calendar = cal
            do {
                try self.apply(call.jsObjectRepresentation, to: ev, creating: true)
                try self.store.save(ev, span: .thisEvent, commit: true)
                call.resolve(self.json(of: ev))
            } catch {
                call.reject("Impossibile creare l'evento: \(error.localizedDescription)", "CREATE_FAILED", error)
            }
        }
    }

    @objc func updateEvent(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        guard let id = call.getString("id"), let changes = call.getObject("changes") else {
            call.reject("Argomenti mancanti", "BAD_ARGS")
            return
        }
        work.async {
            guard let ev = self.event(for: id) else {
                call.reject("Evento non trovato", "NOT_FOUND")
                return
            }
            guard self.isPRCD(ev) else {
                call.reject("L'evento non è stato creato da PRCD e non viene modificato.", "NOT_PRCD_EVENT")
                return
            }
            do {
                try self.apply(changes, to: ev, creating: false)
                try self.store.save(ev, span: .thisEvent, commit: true)
                call.resolve(self.json(of: ev))
            } catch {
                call.reject("Impossibile aggiornare l'evento: \(error.localizedDescription)", "UPDATE_FAILED", error)
            }
        }
    }

    @objc func deleteEvent(_ call: CAPPluginCall) {
        guard requireAccess(call) else { return }
        guard let id = call.getString("id") else {
            call.reject("Identificatore mancante", "BAD_ARGS")
            return
        }
        work.async {
            guard let ev = self.event(for: id) else {
                call.resolve() // already gone: the goal state is reached
                return
            }
            guard self.isPRCD(ev) else {
                call.reject("L'evento non è stato creato da PRCD e non viene eliminato.", "NOT_PRCD_EVENT")
                return
            }
            do {
                try self.store.remove(ev, span: .thisEvent, commit: true)
                call.resolve()
            } catch {
                call.reject("Impossibile eliminare l'evento: \(error.localizedDescription)", "DELETE_FAILED", error)
            }
        }
    }

    // MARK: - EventKit <-> JSON

    private func isPRCD(_ ev: EKEvent) -> Bool {
        return ev.url?.absoluteString.hasPrefix(Self.markerPrefix) ?? false
    }

    /// Ids of occurrences of third-party recurring events are suffixed with "@<start>" so every occurrence
    /// has a unique key in PRCD's read-only cache. PRCD's own events are never recurring (one EKEvent each).
    private func event(for id: String) -> EKEvent? {
        let base = id.split(separator: "@", maxSplits: 1).first.map(String.init) ?? id
        return store.event(withIdentifier: base)
    }

    private func json(of cal: EKCalendar) -> [String: Any] {
        return [
            "id": cal.calendarIdentifier,
            "title": cal.title,
            "sourceTitle": cal.source?.title ?? "",
            "color": Self.hex(from: cal.cgColor),
            "allowsModifications": cal.allowsContentModifications,
            "isSubscribed": cal.type == .subscription
        ]
    }

    private func json(of ev: EKEvent) -> [String: Any] {
        let baseId = ev.eventIdentifier ?? ""
        let occurrenceKey = ev.hasRecurrenceRules ? "\(baseId)@\(Self.localString(ev.startDate, tz: ev.timeZone))" : baseId
        let allDay = ev.isAllDay
        var endDate = ev.endDate ?? ev.startDate ?? Date()
        if allDay {
            // All-day events: expose an inclusive last day ("…T23:59"). Some writers store the exclusive next midnight.
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = ev.timeZone ?? TimeZone.current
            if let start = ev.startDate, endDate > start, cal.startOfDay(for: endDate) == endDate {
                endDate = endDate.addingTimeInterval(-1)
            }
        }
        let start = ev.startDate ?? Date()
        return [
            "ekEventId": occurrenceKey,
            "externalId": Self.orNull(ev.calendarItemExternalIdentifier),
            "calendarId": ev.calendar?.calendarIdentifier ?? "",
            "title": ev.title ?? "",
            "notes": ev.notes ?? "",
            "location": ev.location ?? "",
            "start": allDay ? Self.localString(start, tz: ev.timeZone, dayOnly: true) + "T00:00" : Self.localString(start, tz: ev.timeZone),
            "end": allDay ? Self.localString(endDate, tz: ev.timeZone, dayOnly: true) + "T23:59" : Self.localString(endDate, tz: ev.timeZone),
            "allDay": allDay,
            "url": Self.orNull(ev.url?.absoluteString),
            "lastModified": Self.orNull(ev.lastModifiedDate.map { ISO8601DateFormatter().string(from: $0) })
        ]
    }

    /// Applies the (possibly partial) JS payload. Times are floating wall-clock strings in the device zone.
    private func apply(_ o: [String: Any], to ev: EKEvent, creating: Bool) throws {
        if let t = o["title"] as? String { ev.title = t }
        if let n = o["notes"] as? String { ev.notes = n }
        if let l = o["location"] as? String { ev.location = l }
        if let u = o["url"] as? String { ev.url = URL(string: u) }
        if let calId = o["calendarId"] as? String, let cal = store.calendar(withIdentifier: calId), cal.allowsContentModifications {
            ev.calendar = cal
        }
        let allDay = (o["allDay"] as? Bool) ?? ev.isAllDay
        if o["allDay"] != nil { ev.isAllDay = allDay }
        if creating || o["timeZone"] != nil { ev.timeZone = nil } // nil = floating: lessons stay at the same wall-clock time
        if let s = o["start"] as? String, let d = Self.parseLocal(s) { ev.startDate = allDay ? Calendar.current.startOfDay(for: d) : d }
        if let e = o["end"] as? String, let d = Self.parseLocal(e) {
            if allDay {
                // end of the last day, inclusive
                let day = Calendar.current.startOfDay(for: d)
                ev.endDate = Calendar.current.date(byAdding: DateComponents(day: 1, second: -1), to: day) ?? d
            } else {
                ev.endDate = d
            }
        }
        if ev.endDate != nil, ev.startDate != nil, ev.endDate < ev.startDate { ev.endDate = ev.startDate }
        if o.keys.contains("alarmMinutesBefore") {
            ev.alarms?.forEach { ev.removeAlarm($0) }
            if let m = o["alarmMinutesBefore"] as? Int {
                ev.addAlarm(EKAlarm(relativeOffset: -TimeInterval(m * 60)))
            }
        }
    }

    // MARK: - Date and colour helpers

    private static func localString(_ d: Date, tz: TimeZone?, dayOnly: Bool = false) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz ?? TimeZone.current
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        let day = String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
        return dayOnly ? day : day + String(format: "T%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "yyyy-MM-ddTHH:mm" (or "yyyy-MM-dd") interpreted in the device's current time zone.
    private static func parseLocal(_ s: String) -> Date? {
        let parts = s.split(separator: "T", maxSplits: 1).map(String.init)
        let day = parts[0].split(separator: "-").compactMap { Int($0) }
        guard day.count == 3 else { return nil }
        var comps = DateComponents(year: day[0], month: day[1], day: day[2])
        if parts.count == 2 {
            let hm = parts[1].split(separator: ":").compactMap { Int($0) }
            guard hm.count >= 2 else { return nil }
            comps.hour = hm[0]
            comps.minute = hm[1]
        } else {
            comps.hour = 0
            comps.minute = 0
        }
        return Calendar.current.date(from: comps)
    }

    private static func parseDay(_ s: String, endOfDay: Bool) -> Date? {
        guard let d = parseLocal(s) else { return nil }
        let start = Calendar.current.startOfDay(for: d)
        return endOfDay ? Calendar.current.date(byAdding: DateComponents(day: 1, second: -1), to: start) : start
    }

    private static func orNull(_ v: Any?) -> Any {
        return v ?? NSNull()
    }

    private static func hex(from cg: CGColor?) -> String {
        guard let cg = cg else { return "#000000" }
        let ui = UIColor(cgColor: cg)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02X%02X%02X", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }

    private static func color(fromHex hex: String) -> UIColor {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: h).scanHexInt64(&v)
        return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}
