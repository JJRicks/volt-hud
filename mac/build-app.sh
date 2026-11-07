#!/bin/sh
# build-app.sh [version] : builds "build/Volt HUD.app" (universal, ad-hoc signed) and the volthud-installer CLI.
# No Developer ID: the app is signed with `codesign -s -`. See docs/mac-app.md for the first-launch step.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"; cd "$here"
version="${1:-0.0.0-dev}"
arch_flags="--arch arm64 --arch x86_64"
swift build -c release $arch_flags --product VoltHUD
swift build -c release $arch_flags --product volthud-installer
bin="$(swift build -c release $arch_flags --show-bin-path)"

app="build/Volt HUD.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/VoltHUD" "$app/Contents/MacOS/VoltHUD"
cp "$bin/volthud-installer" build/volthud-installer
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Volt HUD</string>
  <key>CFBundleDisplayName</key><string>Volt HUD</string>
  <key>CFBundleIdentifier</key><string>com.jjricks.volthud.mac</string>
  <key>CFBundleExecutable</key><string>VoltHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Private build for JJRicks</string>
</dict></plist>
PLIST
codesign --force --sign - --timestamp=none "$app"
codesign --force --sign - --timestamp=none build/volthud-installer
codesign --verify --strict "$app"
lipo -archs "$app/Contents/MacOS/VoltHUD"
echo "built $here/$app ($version)"
