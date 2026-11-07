import Foundation

/// A dotted version such as `1.2.3`, `v0.4.0` or `1.0.0-beta.2`.
/// Build metadata after `+` is ignored. Missing parts count as zero (`1.2` == `1.2.0`).
/// A prerelease sorts before the same version without one (`1.0.0-beta` < `1.0.0`).
public struct Version: Comparable, Hashable, CustomStringConvertible, Sendable {
    public let parts: [Int]
    public let prerelease: String?

    public init?(_ text: String) {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        if let plus = s.firstIndex(of: "+") { s = String(s[..<plus]) }
        var pre: String?
        if let dash = s.firstIndex(of: "-") {
            pre = String(s[s.index(after: dash)...])
            s = String(s[..<dash])
            if pre?.isEmpty == true { return nil }
        }
        let fields = s.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(fields.count) else { return nil }
        var nums: [Int] = []
        for f in fields {
            guard !f.isEmpty, f.allSatisfy(\.isASCII), f.allSatisfy(\.isNumber), let n = Int(f) else { return nil }
            nums.append(n)
        }
        parts = nums
        prerelease = pre
    }

    public var isPrerelease: Bool { prerelease != nil }

    public var description: String {
        parts.map(String.init).joined(separator: ".") + (prerelease.map { "-\($0)" } ?? "")
    }

    private func padded(_ n: Int) -> [Int] { parts + Array(repeating: 0, count: max(0, n - parts.count)) }

    public static func == (a: Version, b: Version) -> Bool {
        let n = max(a.parts.count, b.parts.count)
        return a.padded(n) == b.padded(n) && a.prerelease == b.prerelease
    }

    public func hash(into h: inout Hasher) {
        var p = parts
        while p.count > 1, p.last == 0 { p.removeLast() }
        h.combine(p)
        h.combine(prerelease)
    }

    public static func < (a: Version, b: Version) -> Bool {
        let n = max(a.parts.count, b.parts.count)
        let pa = a.padded(n), pb = b.padded(n)
        for i in 0..<n where pa[i] != pb[i] { return pa[i] < pb[i] }
        switch (a.prerelease, b.prerelease) {
        case (nil, nil), (nil, _): return false
        case (_, nil): return true
        case let (x?, y?): return x.compare(y, options: .numeric) == .orderedAscending
        }
    }
}
