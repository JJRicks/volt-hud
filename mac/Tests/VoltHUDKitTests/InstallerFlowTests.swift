import XCTest
@testable import VoltHUDKit

/// End-to-end install/update/remove through real processes, with a stub `gh` (serving a local
/// release fixture) and a stub UPIA (recording calls). Nothing touches GitHub or Adobe.
final class InstallerFlowTests: XCTestCase {
    var dir: URL!
    var log: URL { dir.appendingPathComponent("upia.log") }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("volthud-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("cep"), withIntermediateDirectories: true)
        try script("gh", ghStub)
        try script("upia", upiaStub)
        try "0".write(to: dir.appendingPathComponent("auth"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    // MARK: helpers

    func script(_ name: String, _ body: String) throws {
        let url = dir.appendingPathComponent(name)
        try body.replacingOccurrences(of: "@DIR@", with: dir.path).write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    func write(_ text: String, _ path: String) throws {
        let url = dir.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    /// Builds a ZXP-shaped zip holding CSXS/manifest.xml.
    func makeZXP(_ path: String, bundleId: String = "com.jjricks.volthud", version: String) throws -> URL {
        let stage = dir.appendingPathComponent("stage-\(UUID().uuidString)/CSXS")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        try #"<?xml version="1.0"?><ExtensionManifest Version="12.0" ExtensionBundleId="\#(bundleId)" ExtensionBundleVersion="\#(version)" ExtensionBundleName="Volt HUD"/>"#
            .write(to: stage.appendingPathComponent("manifest.xml"), atomically: true, encoding: .utf8)
        let out = dir.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        let r = try ProcessRunner().run("/bin/sh", ["-c", "cd \"\(stage.deletingLastPathComponent().path)\" && /usr/bin/zip -qr \"\(out.path)\" CSXS"], timeout: 30)
        XCTAssertEqual(r.exitCode, 0, r.combined)
        return out
    }

    /// Publishes a fake release `tag` with a ZXP and a correct (or tampered) SHA256SUMS.
    func publish(tag: String, version: String, bundleId: String = "com.jjricks.volthud", tamper: Bool = false) throws {
        let zxp = try makeZXP("rel/\(tag)/VoltHUD-\(version).zxp", bundleId: bundleId, version: version)
        var sum = try Installer.sha256(of: zxp)
        if tamper { sum = String(repeating: "0", count: 64) }
        try write("\(sum)  VoltHUD-\(version).zxp\n", "rel/\(tag)/SHA256SUMS")
        try write(#"[{"tagName":"\#(tag)","isDraft":false,"isPrerelease":false,"publishedAt":"2026-11-06T12:00:00Z"}]"#, "list.json")
        try write(#"{"assets":[{"name":"VoltHUD-\#(version).zxp"},{"name":"SHA256SUMS"}]}"#, "view-\(tag).json")
    }

    func installer() -> Installer {
        var c = AppConfig()
        c.ghPath = dir.appendingPathComponent("gh").path
        c.upiaPath = dir.appendingPathComponent("upia").path
        c.cepFolders = [dir.appendingPathComponent("cep").path]
        let i = Installer(config: c)
        i.isCreativeCloudRunning = { true }
        i.openCreativeCloud = { true }
        i.isAfterEffectsRunning = { false }
        i.busyRetryDelay = 0.05
        return i
    }

    var upiaCalls: [String] {
        ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init).filter { !$0.hasPrefix("--list") }
    }

    // MARK: tests

    func testFreshInstallFromRelease() throws {
        try publish(tag: "v0.4.0", version: "0.4.0")
        let i = installer()
        let before = i.status()
        XCTAssertEqual(before.gh, .ready(path: dir.appendingPathComponent("gh").path))
        XCTAssertEqual(before.latest?.version, Version("0.4.0"))
        XCTAssertNil(before.installed)
        XCTAssertEqual(before.primaryAction, .install)

        let msg = try i.installLatest()
        XCTAssertTrue(msg.hasPrefix("Installed Volt HUD 0.4.0."), msg)
        XCTAssertEqual(upiaCalls.count, 1)
        XCTAssertTrue(upiaCalls[0].hasPrefix("--install ") && upiaCalls[0].hasSuffix("/VoltHUD-0.4.0.zxp"))
        XCTAssertEqual(i.status().primaryAction, .upToDate)
    }

    func testUpdateOffered() throws {
        try write("Volt HUD 0.3.0", "installed")
        try publish(tag: "v0.4.0", version: "0.4.0")
        let s = installer().status()
        XCTAssertEqual(s.installed, InstalledPanel(name: "Volt HUD", version: "0.3.0", enabled: true))
        XCTAssertEqual(s.primaryAction, .update)
        XCTAssertEqual(s.afterEffects == nil, Adobe.findAfterEffects() == nil)
    }

    func testChecksumMismatchInstallsNothing() throws {
        try publish(tag: "v0.4.0", version: "0.4.0", tamper: true)
        XCTAssertThrowsError(try installer().installLatest()) {
            XCTAssertEqual($0 as? VoltError, .checksumMismatch(file: "VoltHUD-0.4.0.zxp"))
        }
        XCTAssertEqual(upiaCalls, [])
    }

    func testOtherBundleIdRefused() throws {
        try publish(tag: "v0.4.0", version: "0.4.0", bundleId: "com.example.other")
        XCTAssertThrowsError(try installer().installLatest()) {
            XCTAssertEqual($0 as? VoltError, .wrongPanel(expected: "com.jjricks.volthud", found: "com.example.other"))
        }
        XCTAssertEqual(upiaCalls, [])
    }

    func testBusyIsRetried() throws {
        try write("2", "busy")    // the stub answers -626 twice, then succeeds
        try publish(tag: "v0.4.0", version: "0.4.0")
        var steps: [String] = []
        _ = try installer().installLatest { steps.append($0) }
        XCTAssertEqual(upiaCalls.count, 3)
        XCTAssertTrue(steps.contains { $0.contains("busy") })
    }

    func testCreativeCloudNotRunningMessage() throws {
        try write("-642", "fail")
        try publish(tag: "v0.4.0", version: "0.4.0")
        XCTAssertThrowsError(try installer().installLatest()) {
            XCTAssertTrue($0.localizedDescription.hasPrefix("Open Creative Cloud first"), $0.localizedDescription)
        }
    }

    func testCreativeCloudIsOpenedFirst() throws {
        try publish(tag: "v0.4.0", version: "0.4.0")
        let i = installer()
        i.creativeCloudSettleDelay = 0
        final class Flag: @unchecked Sendable { var on = false }
        let opened = Flag()
        i.isCreativeCloudRunning = { opened.on }
        i.openCreativeCloud = { opened.on = true; return true }
        _ = try i.installLatest()
        XCTAssertTrue(opened.on)
        i.isCreativeCloudRunning = { false }
        i.openCreativeCloud = { false }
        XCTAssertThrowsError(try i.installLatest()) { XCTAssertEqual($0 as? VoltError, .creativeCloudDidNotStart) }
    }

    func testRemove() throws {
        let i = installer()
        XCTAssertThrowsError(try i.remove()) { XCTAssertEqual($0 as? VoltError, .notInstalled) }
        try write("Volt HUD 0.4.0", "installed")
        XCTAssertEqual(try i.remove(), "Removed Volt HUD 0.4.0.")
        XCTAssertEqual(upiaCalls, ["--remove Volt HUD"])
        XCTAssertNil(i.status(checkReleases: false).installed)
    }

    func testNameComesFromInstalledManifest() throws {
        try write(#"<ExtensionManifest ExtensionBundleId="com.jjricks.volthud" ExtensionBundleVersion="0.5.0" ExtensionBundleName="Volt HUD Panel"/>"#,
                  "cep/Volt HUD Panel/CSXS/manifest.xml")
        try write("Volt HUD Panel 0.5.0", "installed")
        let i = installer()
        XCTAssertEqual(i.extensionName(), "Volt HUD Panel")
        XCTAssertEqual(i.status(checkReleases: false).installed?.version, "0.5.0")
    }

    func testGHStates() throws {
        try publish(tag: "v0.4.0", version: "0.4.0")
        try write("1", "auth")
        let i = installer()
        XCTAssertEqual(i.github.state(), .loggedOut(path: dir.appendingPathComponent("gh").path))
        XCTAssertThrowsError(try i.github.latest()) { XCTAssertEqual($0 as? VoltError, .ghLoggedOut) }

        let missing = GitHubReleases(repo: "JJRicks/volt-hud", ghPath: dir.appendingPathComponent("nope").path)
        XCTAssertEqual(missing.state(), .missing)
        XCTAssertThrowsError(try missing.latest()) { XCTAssertEqual($0 as? VoltError, .ghMissing) }
    }

    func testRepoNotVisibleAndNoReleases() throws {
        try write("[]", "list.json")
        XCTAssertThrowsError(try installer().github.latest()) { XCTAssertEqual($0 as? VoltError, .noReleases(repo: "JJRicks/volt-hud")) }
        try write("404", "list-fail")
        let s = installer().status()
        XCTAssertNil(s.latest)
        XCTAssertEqual(s.latestError, VoltError.ghNoAccess(repo: "JJRicks/volt-hud").localizedDescription)
        XCTAssertEqual(s.primaryAction, .none)
    }
}

/// A fake `gh`: answers auth/list/view/download from files under @DIR@.
private let ghStub = #"""
#!/bin/sh
D="@DIR@"
case "$1 $2" in
  "auth status") exit "$(cat "$D/auth")" ;;
  "release list")
    if [ -f "$D/list-fail" ]; then echo "GraphQL: Could not resolve to a Repository with the name 'JJRicks/volt-hud'. (repository)" >&2; exit 1; fi
    cat "$D/list.json" ;;
  "release view") cat "$D/view-$3.json" ;;
  "release download")
    tag="$3"; shift 3; out=""; pats=""
    while [ $# -gt 0 ]; do
      case "$1" in -D) out="$2"; shift 2 ;; -p) pats="$pats $2"; shift 2 ;; -R) shift 2 ;; *) shift ;; esac
    done
    for p in $pats; do cp "$D/rel/$tag/$p" "$out/" || exit 1; done ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
"""#

/// A fake UPIA: keeps "<name> <version>" in @DIR@/installed and logs every call.
private let upiaStub = #"""
#!/bin/sh
D="@DIR@"
echo "$*" >> "$D/upia.log"
case "$1" in
  --list)
    if [ -f "$D/installed" ]; then
      name="$(sed 's/ [^ ]*$//' "$D/installed")"; ver="$(sed 's/.* //' "$D/installed")"
      echo "1 extension installed for After Effects (ver 26.5.0)"
      echo " Status                        Extension Name                         Version"
      echo "=========  =======================================================  =========="
      printf ' Enabled    %-55s  %10s\n' "$name" "$ver"
    else
      echo "0 extension installed for After Effects (ver 26.5.0)"
    fi ;;
  --install)
    echo "Installing extension with file path = $2"
    if [ -f "$D/fail" ]; then echo "Failed to install, status = $(cat "$D/fail")!"; exit 0; fi
    if [ -f "$D/busy" ] && [ "$(cat "$D/busy")" -gt 0 ]; then
      echo $(( $(cat "$D/busy") - 1 )) > "$D/busy"; echo "Failed to install, status = -626!"; exit 0
    fi
    ver="$(/usr/bin/unzip -p "$2" CSXS/manifest.xml | sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p')"
    echo "Volt HUD $ver" > "$D/installed"
    echo "Installation Successful for extension with file path = $2" ;;
  --remove)
    echo "Removing $2"
    if [ -f "$D/installed" ]; then rm "$D/installed"; echo "Removal Successful for extension $2"
    else echo "Failed to remove $2, status = -406"; fi ;;
esac
"""#
