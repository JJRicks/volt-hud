import Foundation

/// What the app installs and where it looks. The defaults are the real Volt HUD panel;
/// the environment variables exist so tests can point the app at a throwaway extension,
/// a stub `gh` or a fake UPIA without touching the real panel.
public struct AppConfig: Sendable {
    /// GitHub repository holding the releases.
    public var repo = "JJRicks/volt-hud"
    /// The panel's `ExtensionBundleId` (CSXS/manifest.xml). Anything else is refused.
    public var bundleId = "com.jjricks.volthud"
    /// The panel's `ExtensionBundleName`, used by UPIA to list and remove it. If an installed
    /// manifest with `bundleId` is found, its name wins over this default.
    public var extensionName = "Volt HUD"
    /// Explicit `gh` path; otherwise it's searched for.
    public var ghPath: String?
    public var upiaPath = UPIAClient.defaultPath
    public var includePrereleases = false
    /// Folders holding installed CEP extensions (system-wide first, as UPIA installs there).
    public var cepFolders = [
        "/Library/Application Support/Adobe/CEP/extensions",
        NSHomeDirectory() + "/Library/Application Support/Adobe/CEP/extensions",
    ]

    public init() {}

    public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> AppConfig {
        var c = AppConfig()
        if let v = env["VOLTHUD_REPO"], !v.isEmpty { c.repo = v }
        if let v = env["VOLTHUD_BUNDLE_ID"], !v.isEmpty { c.bundleId = v }
        if let v = env["VOLTHUD_EXT_NAME"], !v.isEmpty { c.extensionName = v }
        if let v = env["VOLTHUD_GH"], !v.isEmpty { c.ghPath = v }
        if let v = env["VOLTHUD_UPIA"], !v.isEmpty { c.upiaPath = v }
        if env["VOLTHUD_PRERELEASES"] == "1" { c.includePrereleases = true }
        return c
    }

    /// True when anything differs from the real panel's defaults (shown in the app as a test-mode note).
    public var isOverridden: Bool {
        let d = AppConfig()
        return repo != d.repo || bundleId != d.bundleId || extensionName != d.extensionName || ghPath != nil || upiaPath != d.upiaPath
    }
}
