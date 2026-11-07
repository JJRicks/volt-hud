import Foundation

/// Every error the app shows, worded for a non-developer.
public enum VoltError: LocalizedError, Equatable {
    case ghMissing
    case ghLoggedOut
    case ghNoAccess(repo: String)
    case ghFailed(String)
    case noReleases(repo: String)
    case releaseHasNoPanel(version: String)
    case releaseAmbiguous(version: String, names: [String])
    case releaseHasNoChecksums(version: String)
    case checksumMissing(file: String)
    case checksumMismatch(file: String)
    case upiaMissing
    case upia(code: Int, action: UPIAAction)
    case upiaUnrecognized(action: UPIAAction)
    case notAPanel(String)
    case wrongPanel(expected: String, found: String)
    case creativeCloudDidNotStart
    case notInstalled

    public var errorDescription: String? {
        switch self {
        case .ghMissing:
            return "The GitHub command-line tool (gh) isn't installed, so updates can't be checked. Install it with Homebrew (brew install gh), then run “gh auth login” in Terminal."
        case .ghLoggedOut:
            return "The GitHub command-line tool (gh) is logged out. Open Terminal, run “gh auth login”, then click Check again."
        case .ghNoAccess(let repo):
            return "GitHub didn't show the releases for \(repo). Check that gh is logged in to an account that can see that private repository (run “gh auth status” in Terminal)."
        case .ghFailed(let detail):
            return "Checking GitHub failed. Check your internet connection and try again. (\(detail))"
        case .noReleases(let repo):
            return "No Volt HUD releases are published on \(repo) yet."
        case .releaseHasNoPanel(let v):
            return "Release \(v) doesn't include the panel file (.zxp)."
        case .releaseAmbiguous(let v, let names):
            return "Release \(v) has more than one panel file (\(names.joined(separator: ", "))), so the app can't tell which to install."
        case .releaseHasNoChecksums(let v):
            return "Release \(v) has no SHA256SUMS file, so the download can't be checked. Nothing was installed."
        case .checksumMissing(let f):
            return "The release's SHA256SUMS file doesn't list \(f), so it can't be checked. Nothing was installed."
        case .checksumMismatch(let f):
            return "The downloaded \(f) doesn't match its checksum (it may be damaged). Nothing was installed. Try again."
        case .upiaMissing:
            return "Adobe's extension installer wasn't found. Install or update the Creative Cloud app, then try again."
        case .upia(let code, let action):
            return UPIAErrors.explain(code: code, action: action)
        case .upiaUnrecognized(let action):
            return "Adobe's installer finished but didn't say whether the \(action.rawValue) worked. Click Check again to see the current state."
        case .notAPanel(let f):
            return "\(f) isn't a valid After Effects panel file."
        case .wrongPanel(let expected, let found):
            return "That file is a different extension (\(found)), not the Volt HUD panel (\(expected)). Nothing was installed."
        case .creativeCloudDidNotStart:
            return "Open Creative Cloud first. The app tried to open it, but it didn't start in time. Open Creative Cloud yourself, wait for it to load, then try again."
        case .notInstalled:
            return "The Volt HUD panel isn't installed, so there's nothing to remove."
        }
    }
}
