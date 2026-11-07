import Foundation

public enum GHState: Equatable, Sendable {
    case ready(path: String)
    case missing
    case loggedOut(path: String)
}

/// Reads releases through the owner's logged-in `gh`. This code never reads, prints or stores
/// a token: `gh` handles authentication itself.
public struct GitHubReleases: Sendable {
    public var repo: String
    public var ghPath: String?
    public var runner: CommandRunner

    public init(repo: String, ghPath: String?, runner: CommandRunner = ProcessRunner(extraEnvironment: GitHubReleases.ghEnvironment)) {
        self.repo = repo
        self.ghPath = ghPath
        self.runner = runner
    }

    /// No prompts, no colour, no update nags: the app reads gh's output, nobody types into it.
    public static let ghEnvironment = ["GH_PROMPT_DISABLED": "1", "NO_COLOR": "1", "GH_NO_UPDATE_NOTIFIER": "1", "GH_SPINNER_DISABLED": "1"]

    /// Apps opened from Finder get a minimal PATH, so look in the usual Homebrew places too.
    public static func findGH(explicit: String?, environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let fm = FileManager.default
        if let e = explicit { return fm.isExecutableFile(atPath: e) ? e : nil }
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        dirs += (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for d in dirs where fm.isExecutableFile(atPath: d + "/gh") { return d + "/gh" }
        return nil
    }

    public func state() -> GHState {
        guard let gh = GitHubReleases.findGH(explicit: ghPath) else { return .missing }
        // Only the exit code is used; gh's own text is not shown or kept.
        guard let r = try? runner.run(gh, ["auth", "status", "--hostname", "github.com"], timeout: 30), r.exitCode == 0 else {
            return .loggedOut(path: gh)
        }
        return .ready(path: gh)
    }

    private func requireGH() throws -> String {
        switch state() {
        case .ready(let p): return p
        case .missing: throw VoltError.ghMissing
        case .loggedOut: throw VoltError.ghLoggedOut
        }
    }

    private func classify(_ r: CommandResult) -> VoltError {
        let text = r.stderr.lowercased()
        if text.contains("could not resolve to a repository") || text.contains("http 404") || text.contains("not found") {
            return .ghNoAccess(repo: repo)
        }
        if text.contains("auth login") || text.contains("http 401") || text.contains("authentication") {
            return .ghLoggedOut
        }
        let firstLine = r.stderr.split(whereSeparator: \.isNewline).first.map(String.init) ?? "exit \(r.exitCode)"
        return .ghFailed(String(firstLine.prefix(160)))
    }

    public struct Latest: Equatable, Sendable {
        public var tag: String
        public var version: Version
        public var publishedAt: String?
        public var assets: ReleaseAssets
    }

    /// The newest release and its chosen assets.
    public func latest(includePrereleases: Bool = false) throws -> Latest {
        let gh = try requireGH()
        let r = try runner.run(gh, ["release", "list", "-R", repo, "--limit", "50",
                                    "--json", "tagName,isDraft,isPrerelease,publishedAt"], timeout: 60)
        guard r.exitCode == 0 else { throw classify(r) }
        let releases = (try? JSONDecoder().decode([ReleaseSummary].self, from: Data(r.stdout.utf8))) ?? []
        guard let pick = ReleasePicker.latest(releases, includePrereleases: includePrereleases) else {
            throw VoltError.noReleases(repo: repo)
        }
        let v = try runner.run(gh, ["release", "view", pick.release.tagName, "-R", repo, "--json", "assets"], timeout: 60)
        guard v.exitCode == 0 else { throw classify(v) }
        struct View: Decodable { struct Asset: Decodable { var name: String }; var assets: [Asset] }
        let names = (try? JSONDecoder().decode(View.self, from: Data(v.stdout.utf8)))?.assets.map(\.name) ?? []
        let assets = try AssetPicker.pick(assetNames: names, version: pick.version)
        return Latest(tag: pick.release.tagName, version: pick.version, publishedAt: pick.release.publishedAt, assets: assets)
    }

    /// Downloads the named assets of a release into `directory`.
    public func download(tag: String, assets: [String], to directory: URL) throws {
        let gh = try requireGH()
        var args = ["release", "download", tag, "-R", repo, "-D", directory.path, "--clobber"]
        for a in assets { args += ["-p", a] }
        let r = try runner.run(gh, args, timeout: 600)
        guard r.exitCode == 0 else { throw classify(r) }
    }
}
