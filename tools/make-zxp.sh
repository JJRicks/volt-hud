#!/bin/sh
# make-zxp.sh <ZXPSignCmd> <workdir> [version]
# Stages the After Effects panel (ae/ext + ae/jsx + core/ + the two runtime node modules, no symlinks),
# sets ExtensionBundleVersion, self-signs and writes <workdir>/VoltHUD-<version>.zxp
# (the name tools/package-release.sh and the Mac app expect). Version defaults to package.json's.
# The self-signed certificate is generated once per workdir and never committed.
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <ZXPSignCmd> <workdir> [version]" >&2; exit 2; }
Z="$1"; W="$2"
repo="$(cd "$(dirname "$0")/.." && pwd)"
ver="${3:-$(node -p "require('$repo/package.json').version")}"
case "$ver" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must be X.Y.Z: $ver" >&2; exit 2 ;; esac
case "$ver" in *[!0-9.]*) echo "version must be X.Y.Z: $ver" >&2; exit 2 ;; esac
mkdir -p "$W"; S="$W/stage"; out="$W/VoltHUD-$ver.zxp"
rm -rf "$S" "$out"
cp -R "$repo/ae/ext" "$S"
mkdir -p "$S/jsx" "$S/node_modules"
cp "$repo/ae/jsx/build-comp.jsx" "$S/jsx/"
cp -R "$repo/core" "$S/core"
for m in gopro-telemetry binary-parser; do cp -RL "$repo/node_modules/$m" "$S/node_modules/$m"; done
sed -i '' -e "s/ExtensionBundleVersion=\"[^\"]*\"/ExtensionBundleVersion=\"$ver\"/" -e "s/<Extension Id=\"com.jjricks.volthud.panel\" Version=\"[^\"]*\"/<Extension Id=\"com.jjricks.volthud.panel\" Version=\"$ver\"/" "$S/CSXS/manifest.xml"
printf '{"version":"%s"}\n' "$ver" > "$S/version.json"
find "$S" -name .DS_Store -delete
[ -z "$(find "$S" -type l)" ] || { echo "symlinks present" >&2; exit 1; }
grep -q 'ExtensionBundleId="com.jjricks.volthud"' "$S/CSXS/manifest.xml" || { echo "bundle id changed" >&2; exit 1; }
[ -f "$W/selfsigned.p12" ] || "$Z" -selfSignedCert US ID "Volt HUD" "Volt HUD" volthud-selfsigned "$W/selfsigned.p12"
"$Z" -sign "$S" "$out" "$W/selfsigned.p12" volthud-selfsigned
"$Z" -verify "$out"
ls -la "$out"
