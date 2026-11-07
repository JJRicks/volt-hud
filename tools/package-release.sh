#!/bin/sh
# package-release.sh <version> <panel.zxp> [outdir]
# Packages a Volt HUD release into <outdir>/v<version>/ (default: out/release/v<version>/):
#   VoltHUD-<version>.zxp       the signed After Effects panel (checked: bundle id + version)
#   VoltHUD-App-<version>.zip   "Volt HUD.app", universal, ad-hoc signed (built by mac/build-app.sh)
#   SHA256SUMS                  shasum -a 256 of both
# It never creates, publishes or edits a GitHub release or tag. To try the folder in the app first:
#   VOLTHUD_GH="$PWD/tools/fake-gh.sh" VOLTHUD_FAKE_RELEASES=<outdir> "mac/build/Volt HUD.app/Contents/MacOS/VoltHUD"
# VOLTHUD_BUNDLE_ID overrides the expected bundle id (tests only).
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <version> <panel.zxp> [outdir]" >&2; exit 2; }
version="${1#v}"; zxp="$2"
repo="$(cd "$(dirname "$0")/.." && pwd)"
outdir="${3:-$repo/out/release}"
bundle="${VOLTHUD_BUNDLE_ID:-com.jjricks.volthud}"
case "$version" in *[!0-9A-Za-z.-]*|"") echo "bad version: $version" >&2; exit 2 ;; esac
[ -f "$zxp" ] || { echo "no such file: $zxp" >&2; exit 2; }

manifest="$(/usr/bin/unzip -p "$zxp" CSXS/manifest.xml)" || { echo "$zxp has no CSXS/manifest.xml" >&2; exit 1; }
attr() { printf '%s' "$manifest" | tr '\n' ' ' | sed -n "s/.*<ExtensionManifest[^>]*[[:space:]]$1=\"\([^\"]*\)\".*/\1/p"; }
got_id="$(attr ExtensionBundleId)"; got_ver="$(attr ExtensionBundleVersion)"
[ "$got_id" = "$bundle" ] || { echo "ZXP bundle id is '$got_id', expected '$bundle'" >&2; exit 1; }
[ "$got_ver" = "$version" ] || { echo "ZXP version is '$got_ver', expected '$version' (ExtensionBundleVersion)" >&2; exit 1; }

dest="$outdir/v$version"
rm -rf "$dest"; mkdir -p "$dest"
cp "$zxp" "$dest/VoltHUD-$version.zxp"
"$repo/mac/build-app.sh" "$version" >&2
( cd "$repo/mac/build" && /usr/bin/ditto -c -k --sequesterRsrc --keepParent "Volt HUD.app" "$dest/VoltHUD-App-$version.zip" )
( cd "$dest" && shasum -a 256 "VoltHUD-$version.zxp" "VoltHUD-App-$version.zip" > SHA256SUMS )
cat "$dest/SHA256SUMS"
echo "packaged $dest"
echo "Not published. After the owner agrees, the main session can run:"
echo "  gh release create v$version -R JJRicks/volt-hud \"$dest\"/* --title \"Volt HUD $version\""
