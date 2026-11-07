# volt-hud (private)

A Volt-style data HUD overlay for ride videos. It reads:

- Volt ride recordings (scooter + phone sensors),
- GoPro `.360` GPMF telemetry,

auto-syncs them, and renders an alpha-channel overlay in After Effects for use in Premiere on top of the reframed GoPro MP4.

Status: **v0.1.2 alpha** (v0.1.1 is the published private release; 0.1.2 is packaged, not yet published). Since 0.1.1 it reads Volt 1.12.0's one-file **Everything (JSON)** ride export (`ride-<id>-everything.json`, what ride auto-save keeps), alongside the older separate files. 0.1.2: the HUD clock uses the ride's recorded time zone (see "Clock time zone" below). Private GitHub releases carry the After Effects panel `VoltHUD-X.Y.Z.zxp` + `Volt HUD.app` installer. The shared JS core (M1–M4), the `volthud` CLI (`npm test`; `node cli/volthud.js sync <360...> --volt <everything.json|dir> --out <dir>`), the comp builder (M5), the panel (M6) and the Mac installer (M7) work. Start with [`docs/plan.md`](docs/plan.md); details in
[`research.md`](docs/research.md), [`volt-data-formats.md`](docs/volt-data-formats.md),
[`sync-design.md`](docs/sync-design.md) and [`hud-design.md`](docs/hud-design.md).

Third-party code (gopro-telemetry, gpmf-extract: MIT) is installed through npm at build time, never vendored here.

## Using the panel

1. Install `VoltHUD-X.Y.Z.zxp` (the Mac app does this, or UPIA), then in After Effects open
   **Window > Extensions > Volt HUD**.
2. If the panel says Saira HUD is not installed, press **Install Saira HUD** (copies four font
   files to `~/Library/Fonts`) and restart After Effects. Or double-click the files in
   `ae/ext/fonts/` and install them with Font Book.
3. Pick the `.360` (any chapter), the Volt export (the Everything JSON on its own, or a folder or
   any one of the older files) and, if you like, the reframed MP4. Press **Load and sync**.
   Under **3 · Look**, a line says which zone the clock uses, e.g. `Clock: Europe/Lisbon (from the ride)`.
4. Check the sync strip; nudge by frames if the bumps don't line up. Choose the look, press
   **Build comp**, then Dynamic Link the "Volt HUD …" comp into Premiere above the MP4 at its start.


## Clock time zone

The HUD clock's zone, first match wins: an explicit zone (`volthud sync --tz Area/City`, or a
style's `tz`); then the ride's recorded zone (`timeZone.recorded` in an Everything export from a
ride Volt recorded with one); then this Mac's zone. Older multi-file exports, and rides recorded
before Volt kept the zone, have none, so they use this Mac's zone as before. The timeline stores
the zone with `tzSource` (`explicit` or `ride`), the HUD spec's `clock` says what it used, and the
panel and the CLI print it.
