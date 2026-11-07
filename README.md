# volt-hud (private)

A Volt-style data HUD overlay for ride videos. It reads:

- Volt ride recordings (scooter + phone sensors),
- GoPro `.360` GPMF telemetry,

auto-syncs them, and renders an alpha-channel overlay in After Effects for use in Premiere on top of the reframed GoPro MP4.

Status: **v0.1.0 alpha, about to be published** as a private GitHub release (After Effects panel `VoltHUD-0.1.0.zxp` + `Volt HUD.app` installer). The shared JS core (M1–M4), the `volthud` CLI (`npm test`; `node cli/volthud.js sync <360...> --volt <dir> --out <dir>`), the comp builder (M5), the panel (M6) and the Mac installer (M7) work. Start with [`docs/plan.md`](docs/plan.md); details in
[`research.md`](docs/research.md), [`volt-data-formats.md`](docs/volt-data-formats.md),
[`sync-design.md`](docs/sync-design.md) and [`hud-design.md`](docs/hud-design.md).

Third-party code (gopro-telemetry, gpmf-extract: MIT) is installed through npm at build time, never vendored here.

## Using the panel

1. Install `VoltHUD-X.Y.Z.zxp` (the Mac app does this, or UPIA), then in After Effects open
   **Window > Extensions > Volt HUD**.
2. If the panel says Saira HUD is not installed, press **Install Saira HUD** (copies four font
   files to `~/Library/Fonts`) and restart After Effects. Or double-click the files in
   `ae/ext/fonts/` and install them with Font Book.
3. Pick the `.360` (any chapter), the Volt export (folder or any of its files) and, if you like,
   the reframed MP4. Press **Load and sync**.
4. Check the sync strip; nudge by frames if the bumps don't line up. Choose the look, press
   **Build comp**, then Dynamic Link the "Volt HUD …" comp into Premiere above the MP4 at its start.

