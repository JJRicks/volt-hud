import AppKit
import SwiftUI
import UniformTypeIdentifiers
import VoltHUDKit

@main
struct VoltHUDApp: App {
    @StateObject private var model = Model()

    init() {
        // Built as a bare SwiftPM executable it would start as a background process; make it a normal app.
        NSApplication.shared.setActivationPolicy(.regular)
    }

    var body: some Scene {
        WindowGroup("Volt HUD") {
            StatusView(model: model)
                .frame(minWidth: 520, idealWidth: 600, maxWidth: 900, minHeight: 560)
                .onAppear { NSApplication.shared.activate(ignoringOtherApps: true) }
        }
        .defaultSize(width: 600, height: 620)
        .windowResizability(.contentSize)
    }
}

@MainActor
final class Model: ObservableObject {
    let installer = Installer()
    @Published var status: InstallerStatus?
    @Published var busy: String?          // what's happening now; nil when idle
    @Published var message: String?       // last result
    @Published var messageIsError = false

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    init() { refresh() }

    func refresh() {
        run("Checking…", refreshAfter: false) { inst, _ in
            let s = inst.status()
            await MainActor.run { self.status = s }
            return nil
        }
    }

    func installLatest() {
        run("Starting…") { inst, progress in try inst.installLatest(progress: progress) }
    }

    func installFromFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "zxp") ?? .data]
        panel.message = "Choose a Volt HUD panel file (.zxp)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run("Starting…") { inst, progress in try inst.install(zxp: url, progress: progress) }
    }

    func remove() {
        let alert = NSAlert()
        alert.messageText = "Remove the Volt HUD panel from After Effects?"
        alert.informativeText = "Your projects are not touched. You can install it again at any time."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        run("Starting…") { inst, progress in try inst.remove(progress: progress) }
    }

    @Published var assembleFolder: URL?
    @Published var assembleMissing = 0
    @Published var assembleSize: AssembleSize = .hd
    @Published var assembleShape: AssembleShape = .wide

    func chooseAssembleFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.message = "Choose the folder with your recordings"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        assembleFolder = url
        assembleMissing = GoProExport.missingMP4s(inFolder: url.path).count
    }

    func assemble() {
        guard let folder = assembleFolder?.path else { return }
        let size = assembleSize, shape = assembleShape
        run("Starting…", refreshAfter: false) { _, progress in
            defer {
                let left = GoProExport.missingMP4s(inFolder: folder).count
                Task { @MainActor in self.assembleMissing = left }
            }
            do {
                let report = try Assemble.run(folder: folder, size: size, shape: shape, progress: progress)
                Self.finishAssemble(.succeeded)
                return report
            } catch {
                Self.finishAssemble(AssembleOutcome(error: error))
                throw error
            }
        }
    }

    private nonisolated static func finishAssemble(_ outcome: AssembleOutcome) {
        AssembleFinish(outcome: outcome, premiere: Assemble.findPremiere()).perform(runner: ProcessRunner()) { text in
            // Not awaited: a first-run permission prompt mustn't hold up the app.
            Task.detached { await FinishNotifier.shared.post(text) }
        }
    }

    func openCreativeCloud() {
        run("Opening Creative Cloud…") { _, _ in
            Adobe.openCreativeCloud() ? "Creative Cloud is open." : VoltError.creativeCloudDidNotStart.localizedDescription
        }
    }

    func downloadApp() {
        guard let latest = status?.latest else { return }
        run("Downloading the new app…") { inst, _ in
            let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            let zip = try inst.downloadApp(latest, to: downloads)
            await MainActor.run { NSWorkspace.shared.activateFileViewerSelecting([zip]) }
            return "Saved \(zip.lastPathComponent) to Downloads. Quit this app, unzip it and replace Volt HUD.app in Applications."
        }
    }

    /// Runs work off the main thread, shows progress, then refreshes the status.
    private func run(_ label: String, refreshAfter: Bool = true,
                     _ work: @escaping @Sendable (Installer, @escaping (String) -> Void) async throws -> String?) {
        guard busy == nil else { return }
        busy = label
        if refreshAfter { message = nil }
        let inst = installer
        Task.detached {
            let progress: (String) -> Void = { text in Task { @MainActor in self.busy = text } }
            let (result, failed): (String?, Bool)
            do { (result, failed) = (try await work(inst, progress), false) }
            catch { (result, failed) = (error.localizedDescription, true) }
            let s = refreshAfter ? inst.status() : nil
            await MainActor.run {
                if let result { self.message = result; self.messageIsError = failed }
                if let s { self.status = s }
                self.busy = nil
            }
        }
    }
}
