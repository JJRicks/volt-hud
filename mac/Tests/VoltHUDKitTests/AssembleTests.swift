import XCTest
@testable import VoltHUDKit

final class AssembleTests: XCTestCase {
    func testJobJSONHasEngineFields() throws {
        let data = try Assemble.jobJSON(folder: "/a b", size: .uhd, shape: .tall, workDir: "/w", now: Date(timeIntervalSince1970: 1000))
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(o["folder"] as? String, "/a b")
        XCTAssertEqual(o["size"] as? String, "4k")
        XCTAssertEqual(o["shape"] as? String, "9:16")
        XCTAssertEqual(o["workDir"] as? String, "/w")
        XCTAssertEqual(o["createdMs"] as? Int, 1_000_000)
    }

    func testUpscaleNoteOnlyFor4KTall() {
        XCTAssertNotNil(Assemble.upscaleNote(size: .uhd, shape: .tall))
        XCTAssertNil(Assemble.upscaleNote(size: .hd, shape: .tall))
        XCTAssertNil(Assemble.upscaleNote(size: .uhd, shape: .wide))
    }

    func testProgressDecodes() throws {
        let p = try JSONDecoder().decode(AssembleProgress.self, from: Data(#"{"done":true,"text":"Done"}"#.utf8))
        XCTAssertTrue(p.done)
    }

    func testRunRefusesWhenAdobeAppsOpen() {
        struct Fake: CommandRunner {
            func run(_ e: String, _ a: [String], timeout: TimeInterval) throws -> CommandResult { CommandResult(exitCode: 0, stdout: "", stderr: "") }
        }
        XCTAssertEqual(Assemble.runningApps(runner: Fake()), ["After Effects", "Premiere"])
    }
}
