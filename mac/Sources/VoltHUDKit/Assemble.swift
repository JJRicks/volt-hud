import Foundation

public enum AssembleSize: String, CaseIterable, Sendable { case hd = "1080", uhd = "4k"
    public var label: String { self == .hd ? "1080p" : "4K" }
}
public enum AssembleShape: String, CaseIterable, Sendable { case wide = "16:9", tall = "9:16" }

/// Written by the After Effects engine page (ae/ext/engine.js).
public struct AssembleProgress: Codable, Sendable { public var done: Bool; public var text: String }
public struct AssembleReport: Codable, Sendable { public var ok: Bool; public var text: String; public var error: String? }

/// Starts an assembly: queues a job for the engine in After Effects, opens both apps, and follows the engine's progress.
public enum Assemble {
    public static func findPremiere(applications: String = "/Applications") -> AfterEffectsInstall? {
        Adobe.findApp(prefix: "Adobe Premiere Pro", applications: applications)
    }

    /// The upscale note the app shows for 4K 9:16.
    public static func upscaleNote(size: AssembleSize, shape: AssembleShape) -> String? {
        size == .uhd && shape == .tall
            ? "4K 9:16 video is upscaled: GoPro Reframe has no 2160×3840 size, so Social 9:16 is scaled to 200%." : nil
    }

    static func runningApps(runner: CommandRunner) -> [String] {
        let patterns = [("After Effects", "/Adobe After Effects [0-9]+\\.app/Contents/MacOS/After Effects$"),
                        ("Premiere", "/Adobe Premiere Pro [0-9]+\\.app/Contents/MacOS/Adobe Premiere Pro [0-9]+$")]
        return patterns.filter { (_, re) in (try? runner.run("/usr/bin/pgrep", ["-f", re], timeout: 10))?.exitCode == 0 }.map(\.0)
    }

    public static func queueDirectory(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home + "/Library/Application Support/Volt HUD/assemble", isDirectory: true)
    }

    /// The job the engine picks up. `probe` is a test-only hook (JSON pass-through).
    public static func jobJSON(folder: String, size: AssembleSize, shape: AssembleShape, workDir: String, now: Date = Date(), probeJSON: String? = nil) throws -> Data {
        var obj: [String: Any] = ["folder": folder, "size": size.rawValue, "shape": shape.rawValue,
                                  "workDir": workDir, "createdMs": Int(now.timeIntervalSince1970 * 1000)]
        if let probeJSON, let d = probeJSON.data(using: .utf8), let p = try? JSONSerialization.jsonObject(with: d) { obj["probe"] = p }
        return try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    }

    /// Runs the whole assembly and returns the report text. Throws a readable message when it can't start or the engine never answers.
    public static func run(folder: String, size: AssembleSize, shape: AssembleShape, environment: [String: String] = ProcessInfo.processInfo.environment,
                           runner: CommandRunner = ProcessRunner(), progress: @escaping (String) -> Void) throws -> String {
        guard let ae = Adobe.findAfterEffects() else { throw AssembleError("After Effects isn't in the Applications folder.") }
        guard let pr = findPremiere() else { throw AssembleError("Premiere Pro isn't in the Applications folder.") }
        let open = runningApps(runner: runner)
        if !open.isEmpty {
            throw AssembleError("Save your work and quit \(open.joined(separator: " and ")) first. Assemble starts them itself so it doesn't disturb an open project.")
        }
        let fm = FileManager.default
        let queue = queueDirectory()
        try fm.createDirectory(at: queue, withIntermediateDirectories: true)
        let stamp = String(Int(Date().timeIntervalSince1970))
        let work = URL(fileURLWithPath: environment["VOLTHUD_ASSEMBLE_WORKDIR"] ?? queue.appendingPathComponent(stamp).path, isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let progressFile = work.appendingPathComponent("progress.json"), reportFile = work.appendingPathComponent("report.json")
        try? fm.removeItem(at: progressFile); try? fm.removeItem(at: reportFile)
        let job = try jobJSON(folder: folder, size: size, shape: shape, workDir: work.path, probeJSON: environment["VOLTHUD_ASSEMBLE_PROBE"])
        try job.write(to: queue.appendingPathComponent("pending.json"), options: .atomic)

        progress("Starting After Effects and Premiere…")
        // The engine page only starts once After Effects has been brought to the front, so it opens last.
        _ = try? runner.run("/usr/bin/open", [pr.appPath], timeout: 30)
        _ = try? runner.run("/usr/bin/open", [ae.appPath], timeout: 30)

        let start = Date()
        var seen = false
        var last = ""
        var lastNudge = start
        var toldToClick = false
        while true {
            if let data = try? Data(contentsOf: progressFile), let p = try? JSONDecoder().decode(AssembleProgress.self, from: data) {
                seen = true
                if p.text != last { last = p.text; progress(p.text) }
                if p.done { break }
            }
            let elapsed = Date().timeIntervalSince(start)
            if !seen && Date().timeIntervalSince(lastNudge) >= 10 {
                lastNudge = Date()
                _ = try? runner.run("/usr/bin/open", [ae.appPath], timeout: 30)
            }
            if !seen && !toldToClick && elapsed > 30 {
                toldToClick = true
                progress("Still waiting for After Effects. If its Dock icon is bouncing, click it once.")
            }
            if !seen && elapsed > 240 { throw AssembleError("After Effects didn't pick up the job after 4 minutes. Is the Volt HUD panel up to date?") }
            if elapsed > 3600 { throw AssembleError("The assembly did not finish within an hour.") }
            Thread.sleep(forTimeInterval: 1)
        }
        guard let data = try? Data(contentsOf: reportFile), let r = try? JSONDecoder().decode(AssembleReport.self, from: data) else {
            throw AssembleError("The assembly finished but wrote no report.")
        }
        if !r.ok { throw AssembleError(r.text) }
        return r.text
    }
}

public struct AssembleError: LocalizedError, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
