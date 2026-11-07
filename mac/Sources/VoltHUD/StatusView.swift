import SwiftUI
import VoltHUDKit

struct StatusView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Volt HUD").font(.largeTitle.bold())
                Text("app \(Model.appVersion)").foregroundStyle(.secondary)
                Spacer()
                if model.installer.config.isOverridden {
                    Text("TEST MODE").font(.caption.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.orange.opacity(0.25), in: Capsule())
                        .help("Environment overrides are active: \(model.installer.config.bundleId)")
                }
            }

            if let s = model.status {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                    row("After Effects", s.afterEffects.map { ("Installed, version \($0.version)", .good) }
                        ?? ("Not found in Applications", .bad))
                    row("Volt HUD panel", panelText(s))
                    row("Latest available", latestText(s))
                    row("Creative Cloud", s.creativeCloudRunning ? ("Running", .good)
                        : ("Not running. It opens automatically when you install.", .neutral))
                    row("GitHub (gh)", ghText(s.gh))
                }
            } else {
                HStack { ProgressView().controlSize(.small); Text("Checking…") }
            }

            Divider()

            HStack(spacing: 10) {
                primaryButton
                if model.status?.installed != nil {
                    Button("Remove", role: .destructive) { model.remove() }
                }
                Spacer()
                Button("Check again") { model.refresh() }
            }
            .disabled(model.busy != nil)

            if let busy = model.busy {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text(busy) }
            }
            if let msg = model.message {
                Text(msg)
                    .foregroundStyle(model.messageIsError ? Color.red : Color.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background((model.messageIsError ? Color.red : Color.green).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                if model.messageIsError, model.status?.creativeCloudRunning == false {
                    Button("Open Creative Cloud") { model.openCreativeCloud() }.disabled(model.busy != nil)
                }
            }

            Spacer(minLength: 0)
            HStack {
                Button("Install from a file…") { model.installFromFile() }
                    .buttonStyle(.link).disabled(model.busy != nil)
                if let s = model.status, let latest = s.latest, latest.assets.app != nil,
                   let mine = Version(Model.appVersion), mine < latest.version {
                    Text("·").foregroundStyle(.secondary)
                    Button("A newer app (\(latest.version.description)) is available. Download") { model.downloadApp() }
                        .buttonStyle(.link).disabled(model.busy != nil)
                }
            }
            .font(.callout)
        }
        .padding(24)
    }

    @ViewBuilder private var primaryButton: some View {
        switch model.status?.primaryAction ?? .none {
        case .install:
            Button("Install \(model.status?.latest?.version.description ?? "")") { model.installLatest() }
                .buttonStyle(.borderedProminent)
        case .update:
            Button("Update to \(model.status?.latest?.version.description ?? "")") { model.installLatest() }
                .buttonStyle(.borderedProminent)
        case .upToDate:
            Button("Up to date") {}.disabled(true)
        case .none:
            Button("Install") {}.disabled(true).help("No release is available to install.")
        }
    }

    enum Tone { case good, bad, neutral }

    @ViewBuilder private func row(_ label: String, _ value: (String, Tone)) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle().fill(color(value.1)).frame(width: 8, height: 8)
                Text(value.0).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
        }
    }

    private func color(_ t: Tone) -> Color {
        switch t { case .good: .green; case .bad: .red; case .neutral: .gray }
    }

    private func panelText(_ s: InstallerStatus) -> (String, Tone) {
        if !s.upiaAvailable { return ("Can't check: Adobe's extension installer wasn't found. Install or update Creative Cloud.", .bad) }
        guard let p = s.installed else { return ("Not installed", .neutral) }
        return ("Installed, version \(p.version)\(p.enabled ? "" : " (turned off in Creative Cloud)")", .good)
    }

    private func latestText(_ s: InstallerStatus) -> (String, Tone) {
        if let l = s.latest {
            let date = l.publishedAt.flatMap { ISO8601DateFormatter().date(from: $0) }
                .map { " (released \($0.formatted(date: .abbreviated, time: .omitted)))" } ?? ""
            return ("\(l.version)\(date)", s.primaryAction == .update ? .neutral : .good)
        }
        let noneYet = s.latestError?.hasPrefix("No Volt HUD releases") == true
        return (s.latestError ?? "Unknown", noneYet ? .neutral : .bad)
    }

    private func ghText(_ g: GHState) -> (String, Tone) {
        switch g {
        case .ready: ("Logged in", .good)
        case .missing: ("Not installed. Install it with Homebrew (brew install gh), then run “gh auth login” in Terminal.", .bad)
        case .loggedOut: ("Logged out. Run “gh auth login” in Terminal, then click Check again.", .bad)
        }
    }
}
