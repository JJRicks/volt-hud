import AppKit
import ApplicationServices
import Foundation

/// Exports .360 files to MP4 by driving GoPro Player's Export Queue.
/// GoPro Player has no scripting interface, so this presses its real controls through Accessibility.
/// Controls are found by their identifiers. The Add, Remove and Start toolbar buttons accept only a real click.
public enum GoProExport {
    public static let bundleID = "com.gopro.GoPro-Player"

    /// Folder-listing names of the .360 files with no `<name>_*.mp4` beside them. Same rule as scanFolder in core/assemble.js.
    public static func missingMP4s(names: [String]) -> [String] {
        let visible = names.filter { !$0.hasPrefix(".") }
        var covered = Set<String>()
        for n in visible where n.lowercased().hasSuffix(".mp4") {
            if let u = n.firstIndex(of: "_"), u != n.startIndex { covered.insert(n[..<u].lowercased()) }
        }
        return visible.filter { n in
            n.lowercased().hasSuffix(".360") && !covered.contains((n as NSString).deletingPathExtension.lowercased())
        }.sorted()
    }

    public static func missingMP4s(inFolder folder: String) -> [String] {
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: folder)) ?? []).filter { n in
            var isDir: ObjCBool = false
            return fm.fileExists(atPath: (folder as NSString).appendingPathComponent(n), isDirectory: &isDir) && !isDir.boolValue
        }
        return missingMP4s(names: names)
    }

    /// The note the app shows once a folder is chosen.
    public static func note(missing: Int) -> String? {
        guard missing > 0 else { return nil }
        let what = missing == 1 ? "1 .360 file has no MP4." : "\(missing) .360 files have no MP4."
        return "\(what) Go exports \(missing == 1 ? "it" : "them") with GoPro Player first. Stay off the mouse and keyboard while it sets up."
    }

    static func isRunning(status: String, hasBar: Bool) -> Bool {
        hasBar || status.hasSuffix("%") || status.hasPrefix("Exporting")
    }

    /// Clears GoPro Player's queue, exports `files` (names in `folder`) back into `folder`, and returns when they have all finished.
    public static func run(folder: String, files: [String], runner: CommandRunner, progress: @escaping (String) -> Void) throws {
        try GoProDriver(runner: runner, say: progress).run(folder: folder, files: files)
    }
}

private final class GoProDriver {
    struct Row { var name: String; var dest: String; var status: String; var hasBar: Bool; var element: AXUIElement
        var running: Bool { GoProExport.isRunning(status: status, hasBar: hasBar) }
        var finished: Bool { status == "Finished" }
    }

    static let queueID = "batchExportWindow"
    let runner: CommandRunner
    let say: (String) -> Void
    var pid: pid_t = 0
    var app: AXUIElement = AXUIElementCreateSystemWide()

    init(runner: CommandRunner, say: @escaping (String) -> Void) { self.runner = runner; self.say = say }

    func run(folder: String, files: [String]) throws {
        guard AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) else {
            throw AssembleError("Volt HUD needs Accessibility permission to drive GoPro Player. Turn it on in System Settings > Privacy & Security > Accessibility, then click Go again.")
        }
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: GoProExport.bundleID) != nil else {
            throw AssembleError("\(files.count == 1 ? "A .360 file has" : "Some .360 files have") no MP4, and GoPro Player isn't installed.")
        }
        say("Opening GoPro Player…")
        try launch()
        try openQueue()
        if rows().contains(where: \.running) { throw AssembleError("GoPro Player is already exporting. Let it finish, then click Go again.") }

        say("Setting up the export in GoPro Player. Stay off the mouse and keyboard for a moment.")
        let name = (folder as NSString).lastPathComponent
        do {
            cancelPicker()   // A failed run can leave one open.
            try clearQueue()
            try setOutput(folder, name: name)   // Must come first: a row keeps the output folder it was added with.
            for f in files { try add((folder as NSString).appendingPathComponent(f), folderName: name) }
            try checkRows(folder: folder, files: files)
            try applySettings()
            try start()
        } catch {
            cancelPicker()
            throw error
        }
        try follow(folder: folder)
    }

    // MARK: Accessibility helpers

    func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
    }
    func str(_ e: AXUIElement, _ n: String) -> String {
        let a = attr(e, n)
        if let s = a as? String { return s }
        if let v = a as? NSNumber { return v.stringValue }
        return ""
    }
    func kids(_ e: AXUIElement) -> [AXUIElement] { attr(e, "AXChildren") as? [AXUIElement] ?? [] }
    func enabled(_ e: AXUIElement) -> Bool { (attr(e, "AXEnabled") as? Bool) ?? false }
    func find(_ e: AXUIElement, _ id: String) -> AXUIElement? {
        if str(e, "AXIdentifier") == id { return e }
        for k in kids(e) { if let f = find(k, id) { return f } }
        return nil
    }
    func press(_ e: AXUIElement) { AXUIElementPerformAction(e, "AXPress" as CFString) }
    func queueWindow() -> AXUIElement? {
        (attr(app, "AXWindows") as? [AXUIElement] ?? []).first { str($0, "AXIdentifier") == Self.queueID }
    }
    /// `path` is one identifier, or `parent/child` where the child's identifier isn't unique.
    func control(_ path: String) -> AXUIElement? {
        var cur = queueWindow()
        for part in path.split(separator: "/") { cur = cur.flatMap { find($0, String(part)) } }
        return cur
    }
    func moved(_ what: String) -> AssembleError {
        let info = NSWorkspace.shared.urlForApplication(withBundleIdentifier: GoProExport.bundleID).flatMap { Bundle(url: $0)?.infoDictionary }
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        return AssembleError("Couldn't \(what) in GoPro Player \(version). An update may have changed its window, or something got in the way.")
    }
    func need(_ path: String) throws -> AXUIElement {
        try wait(5, "find \(path)") { control(path) }
    }
    @discardableResult func wait<T>(_ seconds: TimeInterval, _ what: String, _ check: () -> T?) throws -> T {
        let end = Date().addingTimeInterval(seconds)
        while true {
            if let v = check() { return v }
            if pid != 0 && kill(pid, 0) != 0 { throw AssembleError("GoPro Player closed while Volt HUD was using it.") }
            if Date() > end { throw moved(what) }
            Thread.sleep(forTimeInterval: 0.15)
        }
    }

    // MARK: Focus and input

    /// The app that owns the frontmost ordinary window. Live even without a run loop, and right for the out-of-process file picker.
    func frontPid() -> pid_t? {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
            return (w[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) }
        }
        return nil
    }
    func bringForward() throws {
        let end = Date().addingTimeInterval(20)
        var last = Date.distantPast
        while frontPid() != pid {
            if Date() > end { throw AssembleError("GoPro Player couldn't come to the front. If a focus tool like FocusGuard is running, pause it or allow GoPro Player, then click Go again.") }
            if Date().timeIntervalSince(last) >= 1 {
                last = Date()
                _ = try? runner.run("/usr/bin/open", ["-b", GoProExport.bundleID], timeout: 15)
                if let w = queueWindow() { AXUIElementPerformAction(w, "AXRaise" as CFString) }
            }
            Thread.sleep(forTimeInterval: 0.15)
        }
    }
    func requireFront() throws {
        if frontPid() != pid { throw AssembleError("Another window came forward while Volt HUD was setting up GoPro Player. Click Go to try again, and stay off the mouse and keyboard until the export starts.") }
    }
    func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = attr(e, "AXPosition"), let s = attr(e, "AXSize") else { return nil }
        var o = CGPoint.zero, z = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &o), AXValueGetValue(s as! AXValue, .cgSize, &z) else { return nil }
        return CGRect(origin: o, size: z)
    }
    func onDisplay(_ point: CGPoint) -> Bool {
        var count: UInt32 = 0
        return CGGetDisplaysWithPoint(point, 0, nil, &count) == .success && count > 0
    }
    /// Whether the queue window is the top ordinary window at `point`. GoPro Player's Welcome window can overlap it,
    /// and Accessibility can't hit-test this app's toolbar, so this reads the window stack.
    func queueOnTop(at point: CGPoint) -> Bool {
        guard let want = queueWindow().flatMap(frame) else { return false }
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
            guard let d = w[kCGWindowBounds as String] as? NSDictionary, let b = CGRect(dictionaryRepresentation: d), b.contains(point) else { continue }
            return (w[kCGWindowOwnerPID as String] as? Int) == Int(pid) && abs(b.minX - want.minX) < 2 && abs(b.minY - want.minY) < 2 && abs(b.width - want.width) < 2
        }
        return false
    }
    /// A real mouse click, only after confirming the queue window is on top at that point. The pointer goes back afterwards.
    func click(_ path: String, _ what: String) throws {
        try bringForward()
        if let w = queueWindow() { AXUIElementPerformAction(w, "AXRaise" as CFString) }
        Thread.sleep(forTimeInterval: 0.3)
        guard var f = frame(try need(path)) else { throw moved("find \(what)") }
        if !onDisplay(CGPoint(x: f.midX, y: f.midY)), let w = queueWindow() {   // The window can sit partly off-screen.
            var origin = CGPoint(x: 40, y: 60)
            if let v = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(w, "AXPosition" as CFString, v) }
            Thread.sleep(forTimeInterval: 0.5)
            guard let again = frame(try need(path)) else { throw moved("find \(what)") }
            f = again
        }
        let c = CGPoint(x: f.midX, y: f.midY)
        guard onDisplay(c) else { throw AssembleError("GoPro Player's Export Queue window doesn't fit on screen, so Volt HUD can't reach \(what). Make the window smaller, then click Go again.") }
        try wait(5, "reach \(what)") { queueOnTop(at: c) ? true : nil }
        let back = CGEvent(source: nil)?.location
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.07)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: c, mouseButton: .left)?.post(tap: .cghidEventTap)
        if let back { CGWarpMouseCursorPosition(back) }
        Thread.sleep(forTimeInterval: 0.5)
    }
    func key(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
        try requireFront()
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            e?.flags = flags
            e?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.03)
        }
    }
    /// Command+Shift+G, with the modifier keys really pressed.
    func goToFolderShortcut() throws {
        try requireFront()
        let both: CGEventFlags = [.maskCommand, .maskShift]
        for (code, down, flags) in [(CGKeyCode(55), true, CGEventFlags.maskCommand), (56, true, both), (5, true, both), (5, false, both), (56, false, .maskCommand), (55, false, [])] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            e?.flags = flags
            e?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.03)
        }
    }
    func type(_ text: String) throws {
        for ch in text {
            try requireFront()
            var units = Array(String(ch).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                e?.post(tap: .cghidEventTap)
            }
            Thread.sleep(forTimeInterval: 0.02)   // The Go to Folder field autocompletes; fast typing scrambles it.
        }
    }

    // MARK: Steps

    func launch() throws {
        func running() -> pid_t? {
            guard let r = try? runner.run("/usr/bin/pgrep", ["-x", "GoPro Player"], timeout: 10), r.exitCode == 0 else { return nil }
            return r.stdout.split(whereSeparator: \.isNewline).first.flatMap { pid_t($0) }
        }
        if running() == nil { _ = try? runner.run("/usr/bin/open", ["-b", GoProExport.bundleID], timeout: 30) }
        pid = try wait(90, "start the app") { running() }
        app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 6)
    }

    func openQueue() throws {
        if queueWindow() != nil { return }
        let item: AXUIElement = try wait(60, "find the Batch Exporter menu") { attr(app, "AXMenuBar").flatMap { find($0 as! AXUIElement, "batchExporterFile") } }
        try wait(30, "open the Batch Exporter") { () -> Bool? in
            if queueWindow() != nil { return true }
            if enabled(item) { press(item); Thread.sleep(forTimeInterval: 1) }
            return nil
        }
    }

    func rows() -> [Row] {
        guard let table = control("batchExportTable") else { return [] }
        return (attr(table, "AXRows") as? [AXUIElement] ?? []).compactMap { r in
            let cells = kids(r)
            guard cells.count >= 4 else { return nil }
            func text(_ c: AXUIElement) -> String { kids(c).first { str($0, "AXRole") == "AXStaticText" }.map { str($0, "AXValue") } ?? "" }
            return Row(name: text(cells[0]), dest: text(cells[1]), status: text(cells[3]),
                       hasBar: kids(cells[3]).contains { str($0, "AXRole") == "AXProgressIndicator" }, element: r)
        }
    }
    /// Reads the rows fresh on every try: right after the app comes forward, or after Apply, the table can briefly refuse.
    func select(_ pick: ([Row]) -> [Row]) throws {
        var code = AXError.success
        do {
            try wait(6, "select the queue rows") { () -> Bool? in
                guard let table = control("batchExportTable") else { return nil }
                code = AXUIElementSetAttributeValue(table, "AXSelectedRows" as CFString, pick(rows()).map(\.element) as CFArray)
                return code == .success ? true : nil
            }
        } catch let e as AssembleError {
            throw AssembleError("\(e.message) (Accessibility error \(code.rawValue))")
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    func clearQueue() throws {
        if rows().isEmpty { return }
        try bringForward()
        try select { $0 }
        try click("deleteButton", "the Remove button")
        try wait(10, "clear the queue") { rows().isEmpty ? true : nil }
    }

    func sheet() -> AXUIElement? { control("open-panel") }
    func cancelPicker() {
        guard let s = sheet(), let c = find(s, "CancelButton") else { return }
        press(c)
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// Sends the open file picker to `target` by path, then waits until it shows the folder named `name`.
    func goTo(_ target: String, name: String) throws {
        try wait(15, "open the file picker") { sheet() }
        Thread.sleep(forTimeInterval: 1.2)   // The picker runs in another process and drops keys until it's ready.
        try goToFolderShortcut()
        Thread.sleep(forTimeInterval: 1.0)
        try type(target)
        Thread.sleep(forTimeInterval: 0.8)
        try key(36)   // Return
        try wait(15, "go to \(target)") { () -> Bool? in
            guard let s = sheet(), let w = find(s, "where popup") else { return nil }
            return str(w, "AXValue") == name ? true : nil
        }
        Thread.sleep(forTimeInterval: 0.5)
    }
    func confirmPicker() throws {
        let ok: AXUIElement = try wait(15, "confirm the file picker") { () -> AXUIElement? in
            guard let s = sheet(), let b = find(s, "OKButton"), enabled(b) else { return nil }
            return b
        }
        press(ok)
        try wait(20, "close the file picker") { sheet() == nil ? true : nil }
    }

    func setOutput(_ folder: String, name: String) throws {
        try bringForward()
        let popup = try need("outputDirectoryPopup")
        press(popup)
        let menu: AXUIElement = try wait(5, "open the Output Directory menu") { kids(popup).first }
        guard let other = kids(menu).first(where: { str($0, "AXIdentifier") == "changeDirectorySelected:" }) else {
            AXUIElementPerformAction(menu, "AXCancel" as CFString)
            throw moved("find the Output Directory chooser")
        }
        press(other)
        try goTo(folder, name: name)
        try confirmPicker()
        try wait(5, "set the output folder") { str(popup, "AXValue") == name ? true : nil }
    }

    func add(_ file: String, folderName: String) throws {
        let before = rows().count
        try click("addButton", "the Add button")
        try goTo(file, name: folderName)
        try confirmPicker()
        try wait(60, "add \((file as NSString).lastPathComponent)") { rows().count > before ? true : nil }
    }

    func checkRows(folder: String, files: [String]) throws {
        let want = URL(fileURLWithPath: folder).resolvingSymlinksInPath().path
        let list = rows()
        guard Set(list.map(\.name)) == Set(files), list.count == files.count else { throw moved("add every file to the queue") }
        for r in list where URL(fileURLWithPath: (r.dest as NSString).deletingLastPathComponent).resolvingSymlinksInPath().path != want {
            throw AssembleError("GoPro Player would export \(r.name) to the wrong folder, so Volt HUD stopped before exporting.")
        }
    }

    func pick(_ path: String, _ title: String) throws {
        let popup = try need(path)
        if str(popup, "AXValue") == title { return }
        press(popup)
        let menu: AXUIElement = try wait(5, "open \(path)") { kids(popup).first }
        guard let item = kids(menu).first(where: { str($0, "AXTitle") == title }) else {
            AXUIElementPerformAction(menu, "AXCancel" as CFString)
            throw moved("find the \(title) preset")
        }
        press(item)
        try wait(5, "choose \(title)") { str(popup, "AXValue") == title ? true : nil }
    }
    func toggle(_ path: String, to want: String, _ what: String) throws {
        for _ in 0..<4 {
            let box = try need(path)
            if str(box, "AXValue") == want { return }
            press(box)
            Thread.sleep(forTimeInterval: 0.35)
        }
        if str(try need(path), "AXValue") != want { throw moved("set \(what)") }
    }

    /// Selects every row, changes the settings as one batch, then reads each row back.
    func applySettings() throws {
        try select { $0 }
        try pick("presetPicker", "Faster")
        try toggle("worldLockHeader/toggle", to: "0", "Direction Lock")
        try toggle("horizonLevelHeader/toggle", to: "1", "Horizon Level")
        let apply = try need("batchExportSettingsApply")
        if enabled(apply) {
            press(apply)
            try wait(10, "apply the export settings") { enabled(apply) ? nil : true }
        }
        for i in rows().indices {
            try select { $0.indices.contains(i) ? [$0[i]] : [] }
            try wait(5, "confirm the settings for row \(i + 1)") { () -> Bool? in
                guard let p = control("presetPicker"), let l = control("worldLockHeader/toggle"), let h = control("horizonLevelHeader/toggle") else { return nil }
                return str(p, "AXValue") == "Faster" && str(l, "AXValue") == "0" && str(h, "AXValue") == "1" ? true : nil
            }
        }
    }

    func start() throws {
        try select { $0 }
        try click("startStopButton", "the Start button")
        try wait(20, "start the export") { rows().contains { $0.running || $0.finished } ? true : nil }
    }

    func follow(folder: String) throws {
        var shown = "", lastKey = "", lastChange = Date()
        var quietSince: Date?
        while true {
            guard kill(pid, 0) == 0 else { throw AssembleError("GoPro Player closed before the export finished.") }
            let list = rows()
            if !list.isEmpty && list.allSatisfy(\.finished) { break }
            let key = list.map(\.status).joined(separator: "|")
            if key != lastKey { lastKey = key; lastChange = Date() }
            if let i = list.firstIndex(where: \.running) {
                quietSince = nil
                let base = (list[i].name as NSString).deletingPathExtension
                let text = "Exporting \(base) (\(i + 1) of \(list.count)): \(list[i].status). You can use the Mac now."
                if text != shown { shown = text; say(text) }
            } else if list.contains(where: { $0.status == "Paused" }) {
                quietSince = nil; lastChange = Date()
                if shown != "paused" { shown = "paused"; say("The export is paused in GoPro Player.") }
            } else {
                let since = quietSince ?? Date()
                quietSince = since
                if Date().timeIntervalSince(since) > 45 {
                    let left = list.filter { !$0.finished }.map { "\($0.name) (\($0.status))" }.joined(separator: ", ")
                    throw AssembleError("GoPro Player stopped before finishing: \(left).")
                }
            }
            if Date().timeIntervalSince(lastChange) > 2700 { throw AssembleError("GoPro Player's export made no progress for 45 minutes.") }
            Thread.sleep(forTimeInterval: 1.5)
        }
        for r in rows() {
            let size = (try? FileManager.default.attributesOfItem(atPath: r.dest)[.size] as? NSNumber)?.int64Value ?? 0
            if size <= 0 { throw AssembleError("GoPro Player said it finished \(r.name), but its MP4 isn't there.") }
        }
        let left = GoProExport.missingMP4s(inFolder: folder)
        if !left.isEmpty { throw AssembleError("These still have no MP4 after the export: \(left.joined(separator: ", ")).") }
    }
}
