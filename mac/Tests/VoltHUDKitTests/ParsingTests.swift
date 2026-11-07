import XCTest
@testable import VoltHUDKit

func fixture(_ name: String) throws -> String {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/" + name, withExtension: nil))
    return try String(contentsOf: url, encoding: .utf8)
}

final class VersionTests: XCTestCase {
    func v(_ s: String) -> Version { Version(s)! }

    func testParsing() {
        XCTAssertEqual(v("v1.2.3").parts, [1, 2, 3])
        XCTAssertEqual(v("V0.4").description, "0.4")
        XCTAssertEqual(v(" 1.0.0-beta.2 ").prerelease, "beta.2")
        XCTAssertEqual(v("1.0.0+build.7").description, "1.0.0")
        for bad in ["", "v", "1..2", "1.2.x", "release-1", "1.2.3.4.5", "1.0-", "١.٢"] {
            XCTAssertNil(Version(bad), bad)
        }
    }

    func testOrdering() {
        XCTAssertLessThan(v("0.9.9"), v("0.10.0"))       // numeric, not string
        XCTAssertLessThan(v("1.2"), v("1.2.1"))
        XCTAssertEqual(v("1.2"), v("1.2.0"))
        XCTAssertEqual(Set([v("1.2"), v("1.2.0")]).count, 1)
        XCTAssertLessThan(v("1.0.0-beta.2"), v("1.0.0"))
        XCTAssertLessThan(v("1.0.0-beta.2"), v("1.0.0-beta.10"))
        XCTAssertLessThan(v("1.0.0-alpha"), v("1.0.0-beta"))
        XCTAssertFalse(v("1.0.0") < v("1.0.0-rc.1"))
        XCTAssertGreaterThan(v("2.0.0-rc.1"), v("1.9.9"))
    }
}

final class ReleaseSelectionTests: XCTestCase {
    func testLatestSkipsDraftsPrereleasesAndOddTags() throws {
        let json = """
        [{"tagName":"v0.3.0","isDraft":false,"isPrerelease":false,"publishedAt":"2026-11-01T00:00:00Z"},
         {"tagName":"v0.10.0","isDraft":true,"isPrerelease":false,"publishedAt":null},
         {"tagName":"v0.5.0-beta.1","isDraft":false,"isPrerelease":true,"publishedAt":"2026-11-05T00:00:00Z"},
         {"tagName":"v0.4.1","isDraft":false,"isPrerelease":false,"publishedAt":"2026-11-03T00:00:00Z"},
         {"tagName":"nightly","isDraft":false,"isPrerelease":false,"publishedAt":"2026-11-06T00:00:00Z"},
         {"tagName":"v0.6.0-rc.1","isDraft":false,"isPrerelease":false,"publishedAt":"2026-11-06T00:00:00Z"}]
        """
        let rels = try JSONDecoder().decode([ReleaseSummary].self, from: Data(json.utf8))
        XCTAssertEqual(ReleasePicker.latest(rels)?.release.tagName, "v0.4.1")
        XCTAssertEqual(ReleasePicker.latest(rels, includePrereleases: true)?.release.tagName, "v0.6.0-rc.1")
        XCTAssertNil(ReleasePicker.latest([]))
        XCTAssertNil(ReleasePicker.latest([ReleaseSummary(tagName: "v1.0.0", isDraft: true)]))
    }

    func testAssetPickPrefersExactNames() throws {
        let a = try AssetPicker.pick(assetNames: ["VoltHUD-0.4.0.zxp", "VoltHUD-App-0.4.0.zip", "SHA256SUMS", "VoltHUD-0.3.0.zxp"],
                                     version: Version("0.4.0")!)
        XCTAssertEqual(a, ReleaseAssets(zxp: "VoltHUD-0.4.0.zxp", checksums: "SHA256SUMS", app: "VoltHUD-App-0.4.0.zip"))
    }

    func testAssetPickSingleZxpAnyNameAndNoApp() throws {
        let a = try AssetPicker.pick(assetNames: ["panel.ZXP", "SHA256SUMS.txt", "notes.md"], version: Version("1.0")!)
        XCTAssertEqual(a, ReleaseAssets(zxp: "panel.ZXP", checksums: "SHA256SUMS.txt", app: nil))
    }

    func testAssetPickErrors() {
        let v = Version("0.4.0")!
        XCTAssertThrowsError(try AssetPicker.pick(assetNames: ["SHA256SUMS"], version: v)) {
            XCTAssertEqual($0 as? VoltError, .releaseHasNoPanel(version: "0.4.0"))
        }
        XCTAssertThrowsError(try AssetPicker.pick(assetNames: ["a.zxp", "b.zxp", "SHA256SUMS"], version: v)) {
            XCTAssertEqual($0 as? VoltError, .releaseAmbiguous(version: "0.4.0", names: ["a.zxp", "b.zxp"]))
        }
        XCTAssertThrowsError(try AssetPicker.pick(assetNames: ["VoltHUD-0.4.0.zxp"], version: v)) {
            XCTAssertEqual($0 as? VoltError, .releaseHasNoChecksums(version: "0.4.0"))
        }
    }

    func testChecksumParsing() {
        let h1 = String(repeating: "a", count: 64), h2 = String(repeating: "B", count: 64)
        let sums = Checksums.parse("\(h1)  VoltHUD-0.4.0.zxp\n\(h2) *out/VoltHUD-App-0.4.0.zip\nnot a line\n\(h1.prefix(10)) short\n")
        XCTAssertEqual(sums, ["VoltHUD-0.4.0.zxp": h1, "VoltHUD-App-0.4.0.zip": h2.lowercased()])
    }
}

final class UPIAParsingTests: XCTestCase {
    func testListWithOurExtension() throws {
        let l = UPIAParser.parseList(try fixture("upia-list2.txt"))
        XCTAssertEqual(l.products.count, 8)
        XCTAssertEqual(l.afterEffects?.version, "26.5.0")
        XCTAssertEqual(l.find(extensionNamed: "Volt HUD install test"),
                       .init(status: "Enabled", name: "Volt HUD install test", version: "0.0.2"))
        XCTAssertEqual(l.find(extensionNamed: "Timeline Batch Tools")?.version, "0.2.3")
        XCTAssertNil(l.find(extensionNamed: "Volt HUD"))
        XCTAssertNil(l.products.last?.version)   // "Others" has no (ver …)
    }

    func testListAfterRemoval() throws {
        let l = UPIAParser.parseList(try fixture("upia-list3.txt"))
        XCTAssertEqual(l.afterEffects?.extensions, [])
        XCTAssertNil(l.find(extensionNamed: "Volt HUD install test"))
    }

    func testDisabledRowAndEmptyOutput() {
        let l = UPIAParser.parseList("""
        1 extension installed for After Effects (ver 27.0)
         Status                        Extension Name                         Version
        =========  =======================================================  ==========
         Disabled   Volt HUD                                                     1.2.0
        """)
        XCTAssertEqual(l.find(extensionNamed: "Volt HUD")?.status, "Disabled")
        XCTAssertEqual(UPIAParser.parseList("").products, [])
    }

    func testOutcomes() throws {
        XCTAssertEqual(UPIAParser.parseOutcome(try fixture("upia-install1.txt")), .success)
        XCTAssertEqual(UPIAParser.parseOutcome(try fixture("upia-remove.txt")), .success)
        XCTAssertEqual(UPIAParser.parseOutcome(try fixture("upia-missing.txt")), .failure(code: -160))
        XCTAssertEqual(UPIAParser.parseOutcome(try fixture("upia-remove-unknown.txt")), .failure(code: -406))
        XCTAssertEqual(UPIAParser.parseOutcome("Failed to install, status = -642!"), .failure(code: -642))
        XCTAssertEqual(UPIAParser.parseOutcome("something else"), .unrecognized)
    }

    func testErrorMapping() {
        XCTAssertTrue(UPIAErrors.explain(code: -642, action: .install).hasPrefix("Open Creative Cloud first"))
        XCTAssertTrue(UPIAErrors.explain(code: -626, action: .install).contains("busy"))
        XCTAssertTrue(UPIAErrors.isRetryable(-626))
        XCTAssertFalse(UPIAErrors.isRetryable(-642))
        XCTAssertTrue(UPIAErrors.explain(code: -406, action: .remove).contains("isn't installed"))
        XCTAssertTrue(UPIAErrors.explain(code: -160, action: .install).contains("damaged"))
        let unknown = UPIAErrors.explain(code: -999, action: .remove)
        XCTAssertTrue(unknown.contains("-999") && unknown.contains("remove"))
        XCTAssertEqual(VoltError.upia(code: -642, action: .install).localizedDescription,
                       UPIAErrors.explain(code: -642, action: .install))
    }

    func testManifestParse() {
        let xml = #"<?xml version="1.0"?><ExtensionManifest Version="12.0" ExtensionBundleId="com.jjricks.volthud" ExtensionBundleVersion="0.4.0" ExtensionBundleName="Volt HUD"></ExtensionManifest>"#
        XCTAssertEqual(PanelManifest.parse(Data(xml.utf8)), PanelManifest(bundleId: "com.jjricks.volthud", bundleName: "Volt HUD", version: "0.4.0"))
        XCTAssertNil(PanelManifest.parse(Data("<Other/>".utf8)))
        XCTAssertNil(PanelManifest.parse(Data("not xml".utf8)))
    }
}
