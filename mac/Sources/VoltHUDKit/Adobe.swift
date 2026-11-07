import Foundation

/// The identity fields of a CEP `CSXS/manifest.xml`.
public struct PanelManifest: Equatable, Sendable {
    public var bundleId: String
    public var bundleName: String?
    public var version: String

    /// Reads the `<ExtensionManifest>` attributes.
    public static func parse(_ xml: Data) -> PanelManifest? {
        guard let doc = try? XMLDocument(data: xml), let root = doc.rootElement(), root.name == "ExtensionManifest",
              let id = root.attribute(forName: "ExtensionBundleId")?.stringValue, !id.isEmpty else { return nil }
        let version = root.attribute(forName: "ExtensionBundleVersion")?.stringValue ?? ""
        let name = root.attribute(forName: "ExtensionBundleName")?.stringValue
        return PanelManifest(bundleId: id, bundleName: (name?.isEmpty ?? true) ? nil : name, version: version)
    }

    /// Reads the manifest inside a ZXP (a signed zip) without unpacking it.
    public static func read(zxp: URL, runner: CommandRunner = ProcessRunner()) -> PanelManifest? {
        guard let r = try? runner.run("/usr/bin/unzip", ["-p", zxp.path, "CSXS/manifest.xml"], timeout: 30), r.exitCode == 0 else { return nil }
        return parse(Data(r.stdout.utf8))
    }

    /// Finds an installed extension with this bundle id in the CEP folders.
    public static func findInstalled(bundleId: String, in folders: [String]) -> (manifest: PanelManifest, folder: String)? {
        let fm = FileManager.default
        for base in folders {
            guard let items = try? fm.contentsOfDirectory(atPath: base) else { continue }
            for item in items.sorted() {
                let dir = base + "/" + item
                guard let data = fm.contents(atPath: dir + "/CSXS/manifest.xml"),
                      let m = parse(data), m.bundleId == bundleId else { continue }
                return (m, dir)
            }
        }
        return nil
    }
}

public struct AfterEffectsInstall: Equatable, Sendable {
    public var appPath: String
    public var version: String
}

public enum Adobe {
    /// Newest "Adobe After Effects <year>" app under /Applications, read from its Info.plist.
    public static func findAfterEffects(applications: String = "/Applications") -> AfterEffectsInstall? {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: applications) else { return nil }
        var found: [AfterEffectsInstall] = []
        for folder in items where folder.hasPrefix("Adobe After Effects") {
            let app = "\(applications)/\(folder)/\(folder).app"
            guard let plist = NSDictionary(contentsOfFile: app + "/Contents/Info.plist"),
                  let v = plist["CFBundleShortVersionString"] as? String else { continue }
            found.append(AfterEffectsInstall(appPath: app, version: v))
        }
        return found.max { (Version($0.version) ?? Version("0")!) < (Version($1.version) ?? Version("0")!) }
    }

    public static func isProcessRunning(_ exactName: String, runner: CommandRunner = ProcessRunner()) -> Bool {
        (try? runner.run("/usr/bin/pgrep", ["-x", exactName], timeout: 10))?.exitCode == 0
    }

    public static func isCreativeCloudRunning() -> Bool { isProcessRunning("Creative Cloud") }

    public static func isAfterEffectsRunning() -> Bool { isProcessRunning("After Effects") }

    public static let creativeCloudBundleId = "com.adobe.acc.AdobeCreativeCloud"

    /// Opens Creative Cloud and waits (up to `timeout`) for it to be running.
    @discardableResult
    public static func openCreativeCloud(timeout: TimeInterval = 90) -> Bool {
        _ = try? ProcessRunner().run("/usr/bin/open", ["-g", "-b", creativeCloudBundleId], timeout: 30)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isCreativeCloudRunning() { return true }
            Thread.sleep(forTimeInterval: 2)
        }
        return isCreativeCloudRunning()
    }
}
