import XCTest
@testable import VoltHUDKit

final class GoProExportTests: XCTestCase {
    func testAMatchingMP4CoversA360() {
        XCTAssertEqual(GoProExport.missingMP4s(names: ["GS011308.360", "GS011308_2026-11-09_12-02-52-680.mp4"]), [])
    }

    func testOnlyMissingOnesAreListedInOrder() {
        let names = ["GS011309.360", "GS011307.360", "GS011307_x.mp4", "GS011308.360", "ride-1-everything.json", "notes.txt"]
        XCTAssertEqual(GoProExport.missingMP4s(names: names), ["GS011308.360", "GS011309.360"])
    }

    func testMatchingIgnoresCaseLikeTheFolderScan() {
        XCTAssertEqual(GoProExport.missingMP4s(names: ["gs011308.360", "GS011308_a.MP4"]), [])
        XCTAssertEqual(GoProExport.missingMP4s(names: ["GS011308.360", "gs011308_a.mp4"]), [])
    }

    func testAnMP4WithoutTheUnderscoreDoesNotCountLikeTheFolderScan() {
        XCTAssertEqual(GoProExport.missingMP4s(names: ["GS011308.360", "GS011308.mp4", "Rides1080.mp4"]), ["GS011308.360"])
    }

    func testAnotherChaptersMP4DoesNotCover() {
        XCTAssertEqual(GoProExport.missingMP4s(names: ["GS011308.360", "GS021308.360", "GS011308_a.mp4"]), ["GS021308.360"])
    }

    func testHiddenFilesAreIgnored() {
        XCTAssertEqual(GoProExport.missingMP4s(names: ["._GS011308.360", ".GS011309.360"]), [])
        XCTAssertEqual(GoProExport.missingMP4s(names: ["GS011308.360", "._GS011308_a.mp4"]), ["GS011308.360"])
    }

    func testFolderListingSkipsDirectories() throws {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("gopro-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: d.appendingPathComponent("GS011300.360"), withIntermediateDirectories: true)
        try Data().write(to: d.appendingPathComponent("GS011308.360"))
        defer { try? FileManager.default.removeItem(at: d) }
        XCTAssertEqual(GoProExport.missingMP4s(inFolder: d.path), ["GS011308.360"])
    }

    func testNoteOnlyWhenSomethingIsMissing() {
        XCTAssertNil(GoProExport.note(missing: 0))
        XCTAssertTrue(GoProExport.note(missing: 1)?.hasPrefix("1 .360 file has no MP4. Go exports it") == true)
        XCTAssertTrue(GoProExport.note(missing: 3)?.hasPrefix("3 .360 files have no MP4. Go exports them") == true)
    }

    func testRowStatuses() {
        XCTAssertTrue(GoProExport.isRunning(status: "3%", hasBar: false))
        XCTAssertTrue(GoProExport.isRunning(status: "", hasBar: true))
        XCTAssertTrue(GoProExport.isRunning(status: "Exporting...", hasBar: false))
        XCTAssertFalse(GoProExport.isRunning(status: "Ready", hasBar: false))
        XCTAssertFalse(GoProExport.isRunning(status: "Finished", hasBar: false))
        XCTAssertFalse(GoProExport.isRunning(status: "Paused", hasBar: false))
    }
}
