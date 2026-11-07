import CryptoKit
import Foundation

public struct InstalledPanel: Equatable, Sendable {
    public var name: String
    public var version: String
    public var enabled: Bool
}

/// Everything the status screen shows.
public struct InstallerStatus: Sendable {
    public var afterEffects: AfterEffectsInstall?
    public var upiaAvailable: Bool
    public var installed: InstalledPanel?
    public var creativeCloudRunning: Bool
    public var afterEffectsRunning: Bool
    public var gh: GHState
    public var latest: GitHubReleases.Latest?
    public var latestError: String?
    public var details: String

    public enum Action: Equatable, Sendable { case install, update, upToDate, none }

    /// The main button: Install when absent, Update when a newer release exists.
    public var primaryAction: Action {
        guard let latest else { return .none }
        guard let installed else { return .install }
        if let v = Version(installed.version), v >= latest.version { return .upToDate }
        return .update
    }
}

/// Installs, updates and removes the panel. Shared by the app and the `volthud-installer` CLI.
public final class Installer: @unchecked Sendable {
    public let config: AppConfig
    public let upia: UPIAClient
    public let github: GitHubReleases
    /// How long to wait between retries while Creative Cloud is busy (-626).
    public var busyRetryDelay: TimeInterval = 20
    public var busyRetries = 4
    /// Creative Cloud checks, replaceable in tests.
    public var isCreativeCloudRunning: @Sendable () -> Bool = { Adobe.isCreativeCloudRunning() }
    public var openCreativeCloud: @Sendable () -> Bool = { Adobe.openCreativeCloud() }
    public var isAfterEffectsRunning: @Sendable () -> Bool = { Adobe.isAfterEffectsRunning() }
    public var creativeCloudSettleDelay: TimeInterval = 10

    public init(config: AppConfig = .fromEnvironment(), upia: UPIAClient? = nil, github: GitHubReleases? = nil) {
        self.config = config
        self.upia = upia ?? UPIAClient(path: config.upiaPath)
        self.github = github ?? GitHubReleases(repo: config.repo, ghPath: config.ghPath)
    }

    /// The name UPIA knows the panel by: from the installed manifest if present, else the default.
    public func extensionName() -> String {
        PanelManifest.findInstalled(bundleId: config.bundleId, in: config.cepFolders)?.manifest.bundleName ?? config.extensionName
    }

    public func installedPanel(listing: UPIAListing?) -> InstalledPanel? {
        let onDisk = PanelManifest.findInstalled(bundleId: config.bundleId, in: config.cepFolders)
        let name = onDisk?.manifest.bundleName ?? config.extensionName
        if let e = listing?.find(extensionNamed: name) {
            return InstalledPanel(name: name, version: e.version, enabled: e.status == "Enabled")
        }
        // UPIA missing or not listing it, but the files are there.
        if listing == nil, let m = onDisk?.manifest { return InstalledPanel(name: name, version: m.version, enabled: true) }
        return nil
    }

    public func status(checkReleases: Bool = true) -> InstallerStatus {
        var details: [String] = []
        var listing: UPIAListing?
        if upia.isAvailable {
            if let l = try? upia.list() { listing = l.listing; details.append(l.raw) }
        }
        var latest: GitHubReleases.Latest?
        var latestError: String?
        let gh = github.state()
        if checkReleases {
            do { latest = try github.latest(includePrereleases: config.includePrereleases) }
            catch { latestError = error.localizedDescription }
        }
        return InstallerStatus(
            afterEffects: Adobe.findAfterEffects(),
            upiaAvailable: upia.isAvailable,
            installed: installedPanel(listing: listing),
            creativeCloudRunning: isCreativeCloudRunning(),
            afterEffectsRunning: isAfterEffectsRunning(),
            gh: gh,
            latest: latest,
            latestError: latestError,
            details: details.joined(separator: "\n"))
    }

    // MARK: Install and update

    /// Downloads the newest release's ZXP, checks its SHA-256 and installs it.
    public func installLatest(progress: (String) -> Void = { _ in }) throws -> String {
        progress("Checking GitHub for the latest release…")
        let latest = try github.latest(includePrereleases: config.includePrereleases)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("volthud-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        progress("Downloading Volt HUD \(latest.version)…")
        try github.download(tag: latest.tag, assets: [latest.assets.zxp, latest.assets.checksums], to: dir)
        let zxp = dir.appendingPathComponent(latest.assets.zxp)
        try Installer.verifyChecksum(file: zxp, sumsFile: dir.appendingPathComponent(latest.assets.checksums))
        return try install(zxp: zxp, progress: progress)
    }

    public static func sha256(of url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func verifyChecksum(file: URL, sumsFile: URL) throws {
        let sums = Checksums.parse((try? String(contentsOf: sumsFile, encoding: .utf8)) ?? "")
        guard let expected = sums[file.lastPathComponent] else { throw VoltError.checksumMissing(file: file.lastPathComponent) }
        guard try sha256(of: file) == expected else { throw VoltError.checksumMismatch(file: file.lastPathComponent) }
    }

    /// Installs (or updates over) the panel from a local ZXP. Refuses any other extension.
    public func install(zxp: URL, progress: (String) -> Void = { _ in }) throws -> String {
        guard upia.isAvailable else { throw VoltError.upiaMissing }
        guard let manifest = PanelManifest.read(zxp: zxp) else { throw VoltError.notAPanel(zxp.lastPathComponent) }
        guard manifest.bundleId == config.bundleId else {
            throw VoltError.wrongPanel(expected: config.bundleId, found: manifest.bundleId)
        }
        let name = manifest.bundleName ?? config.extensionName
        try ensureCreativeCloud(progress: progress)

        var attempt = 0
        while true {
            attempt += 1
            progress(attempt == 1 ? "Installing Volt HUD \(manifest.version) with Adobe's installer…" : "Trying again (attempt \(attempt))…")
            let (outcome, _) = try upia.install(zxpPath: zxp.path)
            switch outcome {
            case .success:
                break
            case .failure(let code) where UPIAErrors.isRetryable(code) && attempt < busyRetries:
                progress("Creative Cloud is busy. Waiting \(Int(busyRetryDelay)) seconds before trying again…")
                Thread.sleep(forTimeInterval: busyRetryDelay)
                continue
            case .failure(let code):
                throw VoltError.upia(code: code, action: .install)
            case .unrecognized:
                // Trust the listing over the missing message.
                if (try? upia.list())?.listing.find(extensionNamed: name)?.version != manifest.version {
                    throw VoltError.upiaUnrecognized(action: .install)
                }
            }
            break
        }
        let listed = (try? upia.list())?.listing.find(extensionNamed: name)
        var message = "Installed Volt HUD \(listed?.version ?? manifest.version)."
        if isAfterEffectsRunning() { message += " Quit and reopen After Effects to load it." }
        else { message += " Open After Effects and choose Window › Extensions › \(name)." }
        return message
    }

    private func ensureCreativeCloud(progress: (String) -> Void) throws {
        if isCreativeCloudRunning() { return }
        progress("Opening Creative Cloud (Adobe's installer needs it)…")
        guard openCreativeCloud() else { throw VoltError.creativeCloudDidNotStart }
        progress("Waiting for Creative Cloud to finish loading…")
        Thread.sleep(forTimeInterval: creativeCloudSettleDelay)
    }

    // MARK: Remove

    public func remove(progress: (String) -> Void = { _ in }) throws -> String {
        guard upia.isAvailable else { throw VoltError.upiaMissing }
        let listing = try upia.list().listing
        guard let panel = installedPanel(listing: listing) else { throw VoltError.notInstalled }
        try ensureCreativeCloud(progress: progress)
        var attempt = 0
        while true {
            attempt += 1
            progress("Removing Volt HUD \(panel.version)…")
            let (outcome, _) = try upia.remove(extensionName: panel.name)
            switch outcome {
            case .success:
                break
            case .failure(let code) where UPIAErrors.isRetryable(code) && attempt < busyRetries:
                progress("Creative Cloud is busy. Waiting \(Int(busyRetryDelay)) seconds before trying again…")
                Thread.sleep(forTimeInterval: busyRetryDelay)
                continue
            case .failure(let code):
                throw VoltError.upia(code: code, action: .remove)
            case .unrecognized:
                if (try? upia.list())?.listing.find(extensionNamed: panel.name) != nil {
                    throw VoltError.upiaUnrecognized(action: .remove)
                }
            }
            break
        }
        var message = "Removed Volt HUD \(panel.version)."
        if isAfterEffectsRunning() { message += " Quit and reopen After Effects to finish." }
        return message
    }

    // MARK: App download

    /// Downloads the release's zipped app into `folder` (normally ~/Downloads) and returns its path.
    public func downloadApp(_ latest: GitHubReleases.Latest, to folder: URL) throws -> URL {
        guard let app = latest.assets.app else { throw VoltError.ghFailed("this release has no app download") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("volthud-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try github.download(tag: latest.tag, assets: [app, latest.assets.checksums], to: dir)
        try Installer.verifyChecksum(file: dir.appendingPathComponent(app), sumsFile: dir.appendingPathComponent(latest.assets.checksums))
        let dest = folder.appendingPathComponent(app)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: dir.appendingPathComponent(app), to: dest)
        return dest
    }
}
