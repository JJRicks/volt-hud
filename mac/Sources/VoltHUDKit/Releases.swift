import Foundation

/// One row of `gh release list --json tagName,isDraft,isPrerelease,publishedAt`.
public struct ReleaseSummary: Decodable, Equatable, Sendable {
    public var tagName: String
    public var isDraft: Bool
    public var isPrerelease: Bool
    public var publishedAt: String?

    public init(tagName: String, isDraft: Bool = false, isPrerelease: Bool = false, publishedAt: String? = nil) {
        self.tagName = tagName
        self.isDraft = isDraft
        self.isPrerelease = isPrerelease
        self.publishedAt = publishedAt
    }
}

/// The release-asset convention (see docs/mac-app.md):
/// tag `vX.Y.Z`, assets `VoltHUD-X.Y.Z.zxp`, `VoltHUD-App-X.Y.Z.zip`, `SHA256SUMS`.
public struct ReleaseAssets: Equatable, Sendable {
    public var zxp: String
    public var checksums: String
    public var app: String?
}

public enum ReleasePicker {
    /// The newest published release whose tag parses as a version. Drafts are always skipped;
    /// prereleases are skipped unless asked for.
    public static func latest(_ releases: [ReleaseSummary], includePrereleases: Bool = false) -> (release: ReleaseSummary, version: Version)? {
        releases
            .filter { !$0.isDraft && (includePrereleases || !$0.isPrerelease) }
            .compactMap { r in Version(r.tagName).map { (release: r, version: $0) } }
            .filter { includePrereleases || !$0.version.isPrerelease }
            .max { $0.version < $1.version }
    }
}

public enum AssetPicker {
    public static let checksumNames = ["SHA256SUMS", "SHA256SUMS.txt", "checksums.txt"]

    /// Picks the panel ZXP, the checksum file and (optionally) the zipped app from a release's asset names.
    public static func pick(assetNames names: [String], version: Version) throws -> ReleaseAssets {
        let v = version.description
        let zxps = names.filter { $0.lowercased().hasSuffix(".zxp") }
        let zxp: String
        if let exact = zxps.first(where: { $0 == "VoltHUD-\(v).zxp" }) {
            zxp = exact
        } else if zxps.count == 1 {
            zxp = zxps[0]
        } else if zxps.isEmpty {
            throw VoltError.releaseHasNoPanel(version: v)
        } else {
            throw VoltError.releaseAmbiguous(version: v, names: zxps)
        }
        guard let sums = checksumNames.first(where: names.contains) else {
            throw VoltError.releaseHasNoChecksums(version: v)
        }
        let apps = names.filter { $0.lowercased().hasSuffix(".zip") && $0.hasPrefix("VoltHUD-App") }
        let app = apps.first(where: { $0 == "VoltHUD-App-\(v).zip" }) ?? (apps.count == 1 ? apps[0] : nil)
        return ReleaseAssets(zxp: zxp, checksums: sums, app: app)
    }
}

public enum Checksums {
    /// Parses `shasum -a 256` / `sha256sum` output: `<64 hex>  <name>` or `<64 hex> *<name>`.
    public static func parse(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.count > 66 else { continue }
            let hex = String(line.prefix(64)).lowercased()
            guard hex.allSatisfy({ $0.isHexDigit }) else { continue }
            var name = line.dropFirst(64).drop(while: { $0 == " " || $0 == "\t" })
            if name.hasPrefix("*") { name = name.dropFirst() }
            // Accept paths like `out/VoltHUD-1.0.0.zxp` by keeping just the file name.
            let base = String(name).split(separator: "/").last.map(String.init) ?? String(name)
            if !base.isEmpty { out[base] = hex }
        }
        return out
    }
}
