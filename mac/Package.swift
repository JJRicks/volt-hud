// swift-tools-version:5.10
// Volt HUD.app: installs, updates and removes the Volt HUD After Effects panel (a CEP ZXP)
// through Adobe's UPIA, with updates from GitHub Releases via the owner's `gh` login.
import PackageDescription

let package = Package(
    name: "VoltHUDMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "VoltHUD", targets: ["VoltHUD"]),
        .executable(name: "volthud-installer", targets: ["volthud-installer"]),
    ],
    targets: [
        .target(name: "VoltHUDKit"),
        .executableTarget(name: "VoltHUD", dependencies: ["VoltHUDKit"]),
        .executableTarget(name: "volthud-installer", dependencies: ["VoltHUDKit"]),
        .testTarget(name: "VoltHUDKitTests", dependencies: ["VoltHUDKit"], resources: [.copy("Fixtures")]),
    ]
)
