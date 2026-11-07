# volt-hud (private)

A Volt-style data HUD overlay for ride videos. It reads:

- Volt ride recordings (scooter + phone sensors),
- GoPro `.360` GPMF telemetry,

auto-syncs them, and renders an alpha-channel overlay in After Effects for use in Premiere on top of the reframed GoPro MP4.

Status: research and planning. Start with [`docs/plan.md`](docs/plan.md); details in
[`research.md`](docs/research.md), [`volt-data-formats.md`](docs/volt-data-formats.md),
[`sync-design.md`](docs/sync-design.md) and [`hud-design.md`](docs/hud-design.md).

Third-party code (gopro-telemetry, gpmf-extract: MIT) is installed through npm at build time, never vendored here.
