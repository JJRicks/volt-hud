// volthud-installer: the app's install logic without the window, for testing and scripting.
//   volthud-installer status [--offline]
//   volthud-installer install-latest
//   volthud-installer install <file.zxp>
//   volthud-installer remove
// The same VOLTHUD_* environment overrides as the app apply (see AppConfig).
import Foundation
import VoltHUDKit

let args = Array(CommandLine.arguments.dropFirst())
let installer = Installer()
func say(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

if installer.config.isOverridden {
    say("[test mode] repo=\(installer.config.repo) bundleId=\(installer.config.bundleId) name=\(installer.config.extensionName)")
}

do {
    switch args.first {
    case "status":
        let s = installer.status(checkReleases: !args.contains("--offline"))
        print("After Effects: \(s.afterEffects.map { "\($0.version) (\($0.appPath))" } ?? "not found")")
        print("UPIA: \(s.upiaAvailable ? "found" : "missing")")
        print("Creative Cloud running: \(s.creativeCloudRunning)")
        print("Panel installed: \(s.installed.map { "\($0.name) \($0.version)\($0.enabled ? "" : " (disabled)")" } ?? "no")")
        switch s.gh {
        case .ready(let p): print("gh: logged in (\(p))")
        case .loggedOut(let p): print("gh: logged out (\(p))")
        case .missing: print("gh: missing")
        }
        if let l = s.latest { print("Latest release: \(l.version) [\(l.tag)] zxp=\(l.assets.zxp) sums=\(l.assets.checksums) app=\(l.assets.app ?? "-")") }
        if let e = s.latestError { print("Latest release: unavailable: \(e)") }
        print("Action: \(s.primaryAction)")
    case "install-latest":
        print(try installer.installLatest(progress: say))
    case "install":
        guard args.count == 2 else { say("usage: volthud-installer install <file.zxp>"); exit(2) }
        print(try installer.install(zxp: URL(fileURLWithPath: args[1]), progress: say))
    case "remove":
        print(try installer.remove(progress: say))
    default:
        say("usage: volthud-installer status [--offline] | install-latest | install <file.zxp> | remove")
        exit(2)
    }
} catch {
    say("Error: \(error.localizedDescription)")
    exit(1)
}
