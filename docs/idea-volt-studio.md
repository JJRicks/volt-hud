# Idea: Volt Studio (parked)

Owner, 2026-11-06 about 9:20 PM: a full **Volt Studio** desktop app for DIY action videos. It should run on **Mac, Windows and Linux** and work with **GoPro, DJI and Insta360** footage. The After Effects plugin would come inside it: Volt Studio installs and updates the panel itself.

This is a weeks-long project. Nothing is being built yet; the owner will come back to it.

## What already carries over

- **`core/` is plain JavaScript (Node 17+):** the Volt reader (Everything JSON and the older files), GoPro GPMF parsing, auto-sync, the timeline and the HUD spec. None of it is Mac-only, so a cross-platform app could use it unchanged.
- **The normalized timeline (`*.volthud.json`)** is already the hand-off between parsing and drawing. Any new renderer or camera reader plugs in at that point.
- **The Mac installer (`mac/`, Swift)** works only on Mac. Its job (find AE, run Adobe's UPIA installer, fetch releases with `gh`) would move into the studio app on every platform.

## Open questions for when it starts

- **App shell:** Electron or Tauri, or something else. Electron could run `core/` directly.
- **Camera telemetry still to research:**
  - DJI: newer action cams embed their own metadata track; older models write `.SRT` subtitle files.
  - Insta360: `.insv` files carry their own metadata.
  - Which of these hold GPS, and which only motion data.
- **Does the studio render the overlay itself, or stay a front end for AE / Premiere?** On Nov 6 the owner said no long ProRes renders and no renderer outside AE. A studio app might reopen that question.
- **Installing the AE plugin on Windows:** UPIA exists there too. Linux has no After Effects, so there the studio would need its own preview or render path.
- **Name, repo, and whether it replaces Volt HUD or wraps it.**
