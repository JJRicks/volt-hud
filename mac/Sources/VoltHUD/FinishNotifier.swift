import Foundation
import UserNotifications

/// Posts the Assemble result. This app is ad-hoc signed, so the system API may refuse; `display notification` is the fallback.
final class FinishNotifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = FinishNotifier()

    enum Delivery: Equatable { case system, fallback(reason: String) }

    @discardableResult
    func post(_ text: String) async -> Delivery {
        // UNUserNotificationCenter crashes in a process with no app bundle.
        guard Bundle.main.bundleIdentifier != nil else { return fallback(text, reason: "no app bundle") }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let (granted, why) = await authorize(center)
        guard granted else { return fallback(text, reason: why) }
        let content = UNMutableNotificationContent()
        content.title = text
        do {
            try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            return .system
        } catch {
            return fallback(text, reason: "add: \(error.localizedDescription)")
        }
    }

    /// Show the banner even when this app is the frontmost one (the failure case).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    /// The completion only arrives once a first-run prompt is answered, and the rider may have walked away.
    private func authorize(_ center: UNUserNotificationCenter) async -> (Bool, String) {
        await withCheckedContinuation { continuation in
            let once = ResumeOnce()
            let finish: @Sendable (Bool, String) -> Void = { granted, why in
                if once.claim() { continuation.resume(returning: (granted, why)) }
            }
            center.requestAuthorization(options: [.alert]) { granted, error in
                finish(granted, error?.localizedDescription ?? (granted ? "" : "not allowed"))
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) { finish(false, "no answer to the permission prompt") }
        }
    }

    private func fallback(_ text: String, reason: String) -> Delivery {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title \"Volt HUD\"", "-e", "end run", text]
        try? process.run()
        return .fallback(reason: reason)
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        defer { claimed = true }
        return !claimed
    }
}
