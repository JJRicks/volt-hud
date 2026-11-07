# Volt HUD.app (Mac installer and updater)

A small Mac app that installs, updates and removes the Volt HUD panel in After Effects. It holds no
data logic. It shows:

- whether After Effects is installed, and its version;
- whether the Volt HUD panel is installed, and its version;
- the latest version on GitHub Releases;
- whether Creative Cloud is running and whether `gh` is logged in;
- **Install** / **Update to X** / **Remove** buttons, plus **Install from a file…** for a `.zxp` you already have.

Errors are shown in plain words. For example, "Open Creative Cloud first" when Adobe's installer
reports -642.

## First launch (Gatekeeper)

The app is **ad-hoc signed** (`codesign -s -`). There's no Apple Developer ID, so macOS doesn't
recognise the developer the first time you open it:

1. Unzip `VoltHUD-App-<version>.zip` and drag **Volt HUD.app** into **Applications**.
2. **Right-click** (or Control-click) the app and choose **Open**, then click **Open** in the dialog.
3. If macOS only offers **Move to Trash** or **Done**, click **Done**. Then open
   **System Settings › Privacy & Security**, scroll to "Volt HUD was blocked…" and click **Open Anyway**.
   Confirm with your password or Touch ID.

You only do this once per downloaded copy. The download from the app itself
("A newer app is available. Download") goes through `gh`. Files fetched by `gh` aren't marked as
downloaded from the internet, so that copy usually opens without the prompt.

## What it needs

- **After Effects** (2025 or later). The panel targets CEP 12.
- **Creative Cloud** (desktop app). Adobe's installer (UPIA) only works while Creative Cloud is
  running. The app opens it for you before installing if it isn't running, and leaves it open.
  If Creative Cloud is updating itself, UPIA answers -626; the app waits 20 seconds and tries again,
  up to 4 times.
- **GitHub CLI (`gh`)**, logged in to an account that can see the private `JJRicks/volt-hud` repo
  (`brew install gh`, then `gh auth login`). The app runs `gh release list/view/download` and never
  reads, prints or stores a token. If `gh` is missing or logged out, the app says so.

After installing or updating, quit and reopen After Effects, then choose
**Window › Extensions › Volt HUD**.

## How it installs

1. `gh release list` picks the newest **published, non-prerelease** release whose tag is a version
   (`v0.4.0`). Drafts and prereleases are skipped.
2. `gh release download` fetches the panel `.zxp` and `SHA256SUMS` into a temporary folder.
3. The `.zxp`'s SHA-256 must match `SHA256SUMS`. Its `CSXS/manifest.xml` must have
   `ExtensionBundleId="com.jjricks.volthud"`. Anything else is refused.
4. `UnifiedPluginInstallerAgent --install <zxp>` installs it, over any older version. UPIA prints
   its result as text and always exits 0, so the app reads the text: "Installation Successful", or
   "Failed to install, status = <code>".
5. **Remove** runs `UnifiedPluginInstallerAgent --remove "<ExtensionBundleName>"`. The name comes
   from the installed manifest, so a renamed panel is still found.

UPIA codes the app explains (seen on this Mac: -642, -626, -160, -406; from Adobe community
reports: -402, -459, -403/-408). Any other code is shown with its number.

## Release layout

A release is tag `vX.Y.Z` with three assets:

| Asset | What |
|---|---|
| `VoltHUD-X.Y.Z.zxp` | The signed panel. Its `ExtensionBundleVersion` is `X.Y.Z` |
| `VoltHUD-App-X.Y.Z.zip` | `Volt HUD.app` (universal, ad-hoc signed) |
| `SHA256SUMS` | `shasum -a 256` of both |

`tools/package-release.sh <version> <panel.zxp> [outdir]` builds this folder (default
`out/release/vX.Y.Z/`). It checks the ZXP's bundle id and version, builds the app at the same version,
zips it and writes the checksums. **It never creates or publishes a GitHub release or tag**; it
prints the `gh release create` command for when the owner agrees.

## Build and test

```sh
cd mac
swift test                      # parsing, version, asset-selection and error-mapping tests, plus
                                # install/update/remove flows against a stub gh and a stub UPIA
./build-app.sh 0.1.0            # -> mac/build/Volt HUD.app and mac/build/volthud-installer
open "build/Volt HUD.app"
build/volthud-installer status  # the same logic without the window
```

Requirements: Xcode 16 or later (built here with Xcode 27.2, Swift 6.4), macOS 13+.

**Testing without GitHub or the real panel.** These environment variables point the app or the CLI
somewhere else (the app shows a TEST MODE badge):

| Variable | Default |
|---|---|
| `VOLTHUD_REPO` | `JJRicks/volt-hud` |
| `VOLTHUD_BUNDLE_ID` | `com.jjricks.volthud` |
| `VOLTHUD_EXT_NAME` | `Volt HUD` |
| `VOLTHUD_GH` | `gh` from Homebrew or `PATH` |
| `VOLTHUD_UPIA` | Adobe's UPIA path |
| `VOLTHUD_PRERELEASES=1` | Prereleases are skipped |

`tools/fake-gh.sh` serves releases from a local folder laid out like `package-release.sh`'s output:

```sh
VOLTHUD_GH="$PWD/tools/fake-gh.sh" VOLTHUD_FAKE_RELEASES="$PWD/out/release" \
  "mac/build/Volt HUD.app/Contents/MacOS/VoltHUD"
```

**The real UPIA round trip (2026-11-06)** used a throwaway, inert extension with its own bundle id,
`com.jjricks.volthud.installtest` ("Volt HUD install test"), built with
`ae/cep-spike/make-zxp.sh`. It never used the real panel's id. The steps were: package 0.0.1 →
`install-latest` through `fake-gh.sh` → installed 0.0.1 → publish 0.0.2 locally → status showed
"update" → `install-latest` → UPIA listed 0.0.2 → `remove` → nothing left in either CEP extensions
folder. Each UPIA call took about 1–5 s with Creative Cloud already running.
