# Plan

## Architecture (recommended)

```
 .360 chapters ─┐                       ┌──────────── AE CEP panel (HTML/JS, Node 17) ────────────┐
 Volt files ────┼──► core (JS) ────────►│ pick files · sync strip + nudge · widgets/presets ·    │
 reframed MP4 ──┘   parse · sync ·      │ "Build comp" → ExtendScript builder → comp + RQ item   │
                    derive · timeline   └──────────────────────────┬──────────────────────────────┘
                         ▲                                         ▼
                 volthud CLI (Node 20)                    ProRes 4444 (alpha) ──► Premiere V2
                 for tests and batch                      or Dynamic Link        (optional UXP placer)
 Volt HUD.app (Swift): install/update the ZXP via UPIA, using `gh` for private releases
```

**Why this shape:**

- **AE has no public UXP**, so a CEP panel is the only real panel option. CEP gives us Node, so the GPMF libraries run in-panel and **no separate parser app is needed**.
- **One JS core**, shared by the panel and a CLI, means sync and parsing are tested in plain Node, away from AE.
- **The Mac app only installs and updates.** It stays small, needs no Node runtime, and holds no data logic.
- **ExtendScript is the complete AE DOM.** Baked keyframes avoid AE's slow data-footage path.
- **The normalized timeline file** (`*.volthud.json`) is the contract. It can be rebuilt, diffed and tested, and a later UXP port or a non-AE renderer can reuse it.

*Rejected:*

- **Swift helper doing parsing and sync:** duplicates the JS libraries and makes the Mac app big.
- **MGJSON-only:** no Volt data or sync, and slow.
- **C++ AE plugin:** heavy for no gain.
- **Our own renderer straight to ProRes** (headless Chrome or Core Graphics): fast and robust, but it gives up AE's editing and customization, which the owner prefers. **Keep it as plan B** if M0 shows AE cannot handle hour-long rides.

## Normalized timeline (`ride.volthud.json`)

```jsonc
{ "format": "volthud-timeline", "version": 1,
  "video": {"files": ["GS010042.360","GS020042.360"], "fps": 29.97, "durationS": 2712.4, "startUtc": "..."},
  "sync":  { ...sync.json from sync-design.md... },
  "tz": "America/Boise",
  "rateHz": 10,                         // channels resampled onto video time t = i/rateHz
  "channels": { "speedKmh": [...], "speedSrc": "gopro-gps", "powerW": [...], "powerDir": [...],
                "batteryPct": [...], "vertMps": [...], "gradePct": [...], "gLon": [...], "gLat": [...],
                "jerk": [...], "lat": [...], "lon": [...], "utcMs": [...] },
  "gaps": [[t0,t1,"scooter"], ...],
  "stats": { "tripKm": 4.2, "maxKmh": 31.2, ... },
  "style": { "preset": "focus", "units": "metric", "accent": "#E32B2F", "widgets": {...}, "safe": 0.05,
             "comp": [1920,1080] } }
```

## Repo layout

```
core/      parse/volt.js  parse/gpmf-moov.js  parse/gopro.js (gopro-telemetry)  sync/  derive/  timeline.js
cli/       volthud.js           (volthud sync|timeline|report …)
ae/        CSXS/manifest.xml  index.html  panel.js  jsx/build-comp.jsx  jsx/widgets/*.jsx  fonts/ (Saira HUD + OFL)
premiere/  (later) UXP placer
mac/       VoltHUD.xcodeproj  (SwiftUI installer/updater)
tools/     make-zxp.sh  fixtures/ (synthetic generators; no private ride data)
docs/
```

## Milestones (build order, riskiest first)

| # | Milestone | Proves | Needs owner data? |
|---|---|---|---|
| **M0** | **AE spike:** a CEP panel loads in AE 26.5 (PlayerDebugMode); `require('gopro-telemetry')` works on Node 17. A JSX bakes a *synthetic* 60-min, 10 Hz, 12-channel timeline into 4 widgets. Measure build time, `.aep` size, scrubbing and a ProRes 4444 render (check the alpha in Premiere). Compare with the `sourceData` expression approach | AE can carry hour-long data; the render path works | No |
| M1 | **GPMF reader** on a real `.360` (+ chapters): moov reader → gopro-telemetry; list streams and rates; GPS9 vs GPS5; check against the ffmpeg extraction. Check the reframed MP4's t=0 (duration, retained GPMF, audio xcorr) | MAX/MAX2 assumptions | **Yes: sample `.360` + reframed MP4** |
| M2 | **Volt reader** (combined + sensors + motion), power sign check on a ride with braking, clock fit | Sign convention, clocks | Yes: matching Volt exports |
| M3 | **Sync v1:** GNSS fits + speed xcorr, CLI HTML report (overlaid curves, confidence) | Seconds-level sync | Yes |
| M4 | **Sync v2:** windowed IMU + drift fit; synthetic offset/drift tests; one real ride with stomp markers | Frame-level sync | Yes (one marked ride) |
| M5 | **Comp builder:** all widgets, presets, units, accent, safe areas, 16:9 and 9:16; "Saira HUD" tnum font | The look | No |
| M6 | **Panel UX:** file pickers, sync strip with nudge, build, add to render queue | End-to-end in AE | — |
| M7 | **Mac app:** installs the ZXP via UPIA (self-signed), update check via `gh`, ad-hoc signed | Install and update | — |
| M8 | *Volt PR (separate repo, normal Codex review)*: "Everything (JSON)" export + gyro + time zone; add the new reader | One-file input | — |
| M9 | *Optional:* Premiere UXP placer (import the ProRes, insert on V2 at the clip start) | Fewer clicks | — |

## Test plan

- **Core (node:test, CI on GitHub Actions macOS or Linux):**
  - Volt parsers against small synthetic fixtures built to match the golden headers.
  - The moov reader against a tiny synthetic MP4 with a gpmd track (made with ffmpeg from a GPMF `.bin`).
  - Sync against synthetic signals with a known offset, drift and noise. It must recover the offset within 10 ms and the drift within 5 ppm.
  - Derivations (vertical rate, g, jerk) against analytic curves.
- **Real-data checks (local only, never committed):** owner rides in `work/owner-data`-style private folders. The CLI report shows sync confidence and overlays.
- **AE builder:** drive AE with `osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile …'`, then render 3 frames with `aerender` to PNG and compare against reference PNGs (tolerance-based). A manual checklist covers the panel UI.
- **Render:** `ffprobe` checks that the output is `prores` profile 4444 with `yuva444p*` (alpha present) and that its duration equals the `.360`'s.
- **Premiere:** a manual check that the overlay lines up with the reframed MP4 at start, middle and end (drift).

## Open questions for the owner

| # | Question | Blocks |
|---|---|---|
| 1 | Send **one sample ride**: the `.360` (all chapters), the reframed MP4 exactly as you export it, and that ride's Volt exports (combined JSON, Sensor CSV, Motion CSV). | **Blocks M1–M4** |
| 2 | **MAX (original) or MAX2?** (Streams differ; the sample answers it too.) | **Blocks M1** (answered by #1) |
| 3 | **How do you reframe?** GoPro Player export (full length or trimmed? "Retain GPMF" on?) or Premiere's GoPro 360 workflow? | **Blocks M1's t=0 mapping** |
| 4 | OK to build the AE side as a **CEP panel** (AE has no UXP yet; CEP is safe to ~2028+), porting later? | **Blocks M0** (architecture) |
| 5 | Is **"Phone motion" recording** usually on during rides? Without it there is no IMU fine sync; it falls back to speed (about ±0.3 s). | No |
| 6 | Camera mount: helmet, chest or handlebar? | No (tunes sync weights) |
| 7 | Speed widget source: **GoPro GPS** (smooth, 10 Hz, default) or the **scooter dash** number? | No |
| 8 | ProRes 4444 render as the default (Dynamic Link as an option)? | No |
| 9 | Updates via your logged-in **`gh`** CLI OK? Or would you rather paste a read-only token into the Keychain? | No (M7) |
| 10 | Approve the **Volt "Everything (JSON)"** export as a Volt PR and make it the default? Leave identifiers out? Record gyro at 50 Hz (larger motion files)? | No (M8) |
| 11 | Show GPS coordinates on screen (privacy)? Mini-map with or without map tiles? | No |
