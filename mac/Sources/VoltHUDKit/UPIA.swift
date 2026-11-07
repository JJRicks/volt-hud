import Foundation

/// What `UnifiedPluginInstallerAgent --list all` reports.
public struct UPIAListing: Equatable, Sendable {
    public struct Product: Equatable, Sendable {
        public var name: String
        public var version: String?
        public var extensions: [Extension]
    }
    public struct Extension: Equatable, Sendable {
        public var status: String   // "Enabled" or "Disabled"
        public var name: String
        public var version: String
    }

    public var products: [Product]

    /// The After Effects section (UPIA calls it "After Effects", with no year).
    public var afterEffects: Product? {
        products.first { $0.name.hasPrefix("After Effects") }
    }

    /// The first installed extension with this display name, in any product section.
    public func find(extensionNamed name: String) -> Extension? {
        for p in products { if let e = p.extensions.first(where: { $0.name == name }) { return e } }
        return nil
    }
}

/// The outcome of `--install` or `--remove`. UPIA exits 0 even on failure, so this comes from its text.
public enum UPIAOutcome: Equatable, Sendable {
    case success
    case failure(code: Int)
    case unrecognized
}

public enum UPIAParser {
    /// Parses the `--list` table. Verified against UPIA 8.6.0.49 on 2026-11-06:
    ///
    ///     1 extension installed for After Effects (ver 26.5.0)
    ///      Status                        Extension Name                         Version
    ///     =========  =======================================================  ==========
    ///      Enabled    Volt HUD install test                                        0.0.1
    public static func parseList(_ text: String) -> UPIAListing {
        var products: [UPIAListing.Product] = []
        let header = try! NSRegularExpression(pattern: #"^\s*\d+\s+extensions?\s+installed\s+for\s*(.*?)\s*(?:\(ver\s+([^)]*)\))?\s*$"#)
        let row = try! NSRegularExpression(pattern: #"^\s*(Enabled|Disabled)\s+(.+?)\s+(\S+)\s*$"#)
        for raw in text.components(separatedBy: .newlines) {
            let line = raw
            let ns = line as NSString
            let range = NSRange(location: 0, length: ns.length)
            if let m = header.firstMatch(in: line, range: range) {
                let name = ns.substring(with: m.range(at: 1))
                let ver = m.range(at: 2).location == NSNotFound ? nil : ns.substring(with: m.range(at: 2))
                products.append(.init(name: name, version: ver, extensions: []))
            } else if let m = row.firstMatch(in: line, range: range), !products.isEmpty {
                products[products.count - 1].extensions.append(.init(
                    status: ns.substring(with: m.range(at: 1)),
                    name: ns.substring(with: m.range(at: 2)),
                    version: ns.substring(with: m.range(at: 3))))
            }
        }
        return UPIAListing(products: products)
    }

    /// Parses `--install`/`--remove` output, e.g. "Installation Successful for extension …",
    /// "Removal Successful for extension …", "Failed to install, status = -160!".
    public static func parseOutcome(_ text: String) -> UPIAOutcome {
        if text.range(of: "Installation Successful", options: .caseInsensitive) != nil ||
            text.range(of: "Removal Successful", options: .caseInsensitive) != nil {
            return .success
        }
        let re = try! NSRegularExpression(pattern: #"status\s*=\s*(-?\d+)"#, options: .caseInsensitive)
        let ns = text as NSString
        if let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
           let code = Int(ns.substring(with: m.range(at: 1))) {
            return .failure(code: code)
        }
        return .unrecognized
    }
}

public enum UPIAAction: String, Sendable { case install, remove }

/// Plain-language explanations of UPIA status codes, for an owner who isn't a developer.
public enum UPIAErrors {
    /// The code UPIA returns when Creative Cloud isn't running (it waits about 5 minutes first).
    public static let creativeCloudNotRunning = -642
    /// The code UPIA returns while Creative Cloud is busy (for example, updating itself).
    public static let busy = -626

    /// Codes worth retrying after a short wait.
    public static func isRetryable(_ code: Int) -> Bool { code == busy }

    public static func explain(code: Int, action: UPIAAction) -> String {
        switch code {
        // Seen on this Mac (M0 spike, M7 tests).
        case creativeCloudNotRunning:
            return "Open Creative Cloud first. Adobe's installer only works while the Creative Cloud app is running. Open it, wait until it finishes loading, then try again."
        case busy:
            return "Creative Cloud is busy, probably updating itself. Wait a minute or two and try again."
        case -160:
            return "Adobe's installer couldn't open the panel file. The download may be missing or damaged; try again."
        case -406:
            return action == .remove
                ? "Adobe's installer says the panel isn't installed, so there was nothing to remove."
                : "Adobe's installer couldn't find the extension (code -406)."
        // From Adobe community reports; not reproduced here.
        case -402:
            return "Adobe's installer rejected the panel's signature. The file may be damaged, or it was signed incorrectly."
        case -459:
            return "Adobe's installer says the panel doesn't fit any installed Adobe app. Check that After Effects is installed and up to date."
        case -403, -408:
            return "Adobe's installer couldn't write the panel files. Restart the Mac and try again."
        default:
            let verb = action == .install ? "install" : "remove"
            return "Adobe's installer couldn't \(verb) the panel (error \(code)). Make sure Creative Cloud is open and signed in, then try again."
        }
    }
}

/// A thin wrapper around Adobe's UnifiedPluginInstallerAgent command-line tool.
public struct UPIAClient: Sendable {
    public static let defaultPath = "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

    public var path: String
    public var runner: CommandRunner

    public init(path: String = UPIAClient.defaultPath, runner: CommandRunner = ProcessRunner()) {
        self.path = path
        self.runner = runner
    }

    public var isAvailable: Bool { FileManager.default.isExecutableFile(atPath: path) }

    public func list() throws -> (listing: UPIAListing, raw: String) {
        let r = try runner.run(path, ["--list", "all"], timeout: 60)
        return (UPIAParser.parseList(r.stdout), r.combined)
    }

    /// UPIA can wait about 5 minutes before giving up with -642, so allow 7.
    public func install(zxpPath: String) throws -> (outcome: UPIAOutcome, raw: String) {
        let r = try runner.run(path, ["--install", zxpPath], timeout: 420)
        return (r.timedOut ? .failure(code: UPIAErrors.creativeCloudNotRunning) : UPIAParser.parseOutcome(r.combined), r.combined)
    }

    public func remove(extensionName: String) throws -> (outcome: UPIAOutcome, raw: String) {
        let r = try runner.run(path, ["--remove", extensionName], timeout: 420)
        return (r.timedOut ? .failure(code: UPIAErrors.creativeCloudNotRunning) : UPIAParser.parseOutcome(r.combined), r.combined)
    }
}
