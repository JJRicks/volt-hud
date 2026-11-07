# Plan

## Architecture (recommended)

```
 .360 chapters ─┐                       ┌──────────── AE CEP panel (HTML/JS, Node 17) ────────────┐
 Volt files ────┼──► core (JS) ────────►│ pick files · sync strip + nudge · widgets/presets ·    │
 reframed MP4 ──┘   parse · sync ·      │ "Build comp" → ExtendScript builder → comp + RQ item   │
                    derive · timeline   └──────────────────────────┬──────────────────────────────┘
                         ▲                                         ▼
                 volthud CLI (Node 20)                    Dynamic Link ─────────► Premiere V2
                 for tests and batch                      (ProRes 4444: short previews only)
 Volt HUD.app (Swift): install/update the ZXP via UPIA, using `gh` for private releases
```

**Why this shape:**

- **AE has no public UXP**, so a CEP panel is the only real panel option. CEP gives us Node, so the GPMF libraries run in-panel and **no separate parser app is needed**.
- **One JS core**, shared by the panel and a CLI, means sync and parsing are tested in plain Node, away from AE.
- **The Mac app only installs and updates.** It stays small, needs no Node runtime, and holds no data logic.
- **ExtendScript is the complete AE DOM.** Baked keyframes avoid AE's slow data-footage path.
- **The normalized timeline file** (`*.volthud.json`) is the contract. It can be rebuilt, diffed and tested, and a later UXP port can reuse it.

*Rejected:*

- **Swift helper doing parsing and sync:** duplicates the JS libraries and makes the Mac app big.
- **MGJSON-only:** no Volt data or sync, and slow.
- **C++ AE plugin:** heavy for no gain.
- **Our own renderer straight to ProRes** (headless Chrome or Core Graphics): fast and robust, but it gives up AE's editing and customization, which the owner prefers. **Dropped by the owner (Nov 6):** no non-AE renderer fallback.

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
| **M0** | **AE spike:** a CEP panel loads in AE 26.5 (PlayerDebugMode); `require('gopro-telemetry')` works on Node 17. A JSX bakes a *synthetic* 60-min, 10 Hz, 12-channel timeline into 4 widgets. Measure build time, `.aep` size, AE scrubbing, and **Dynamic Link playback and scrubbing of the long comp in Premiere** (alpha over the reframed MP4). A short ProRes 4444 preview checks the alpha only. Compare with the `sourceData` expression approach | AE can carry hour-long data; Dynamic Link stays usable | No |
| M1 | **GPMF reader** on a real `.360` (+ chapters): moov reader → gopro-telemetry; list streams and rates; GPS9 vs GPS5; check against the ffmpeg extraction. Check the reframed MP4's t=0 (duration, retained GPMF, audio xcorr) | MAX/MAX2 assumptions | **Yes: sample `.360` + reframed MP4** |
| M2 | **Volt reader** (combined + sensors + motion), power sign check on a ride with braking, clock fit | Sign convention, clocks | Yes: matching Volt exports |
| M3 | **Sync v1:** GNSS fits + speed xcorr, CLI HTML report (overlaid curves, confidence) | Seconds-level sync | Yes |
| M4 | **Sync v2:** windowed IMU + drift fit; synthetic offset/drift tests; one real ride with stomp markers | Frame-level sync | Yes (one marked ride) |
| M5 | **Comp builder:** all widgets, presets, units, accent, safe areas, 16:9 and 9:16; "Saira HUD" tnum font | The look | No |
| M6 | **Panel UX:** file pickers, sync strip with nudge, build, add to render queue | End-to-end in AE | — |
| M7 | **Mac app:** installs the ZXP via UPIA (self-signed), update check via `gh`, ad-hoc signed | Install and update | — |
| M8 | *Volt PR (separate repo, normal Codex review)*: "Everything (JSON)" export + gyro + time zone; add the new reader | One-file input | — |
| M9 | *Optional:* Premiere UXP placer (insert the Dynamic Link comp on V2 at the clip start) | Fewer clicks | — |

## Test plan

- **Core (node:test, CI on GitHub Actions macOS or Linux):**
  - Volt parsers against small synthetic fixtures built to match the golden headers.
  - The moov reader against a tiny synthetic MP4 with a gpmd track (made with ffmpeg from a GPMF `.bin`).
  - Sync against synthetic signals with a known offset, drift and noise. It must recover the offset within 10 ms and the drift within 5 ppm.
  - Derivations (vertical rate, g, jerk) against analytic curves.
- **Real-data checks (local only, never committed):** owner rides in `work/owner-data`-style private folders. The CLI report shows sync confidence and overlays.
- **AE builder:** drive AE with `osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile …'`, then render 3 frames with `aerender` to PNG and compare against reference PNGs (tolerance-based). A manual checklist covers the panel UI.
- **Comp length:** the AE comp's duration equals the `.360`'s (all chapters), checked by the builder. For a short ProRes 4444 preview, `ffprobe` checks `prores` profile 4444 with `yuva444p*` (alpha present).
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
| 8 | ~~ProRes 4444 render as the default?~~ Answered Nov 6: Dynamic Link is the main path; ProRes only for short previews | — |
| 9 | Updates via your logged-in **`gh`** CLI OK? Or would you rather paste a read-only token into the Keychain? | No (M7) |
| 10 | Approve the **Volt "Everything (JSON)"** export as a Volt PR and make it the default? Leave identifiers out? Record gyro at 50 Hz (larger motion files)? | No (M8) |
| 11 | Show GPS coordinates on screen (privacy)? Mini-map with or without map tiles? | No |

## Owner decisions (Nov 6)

Recorded 2026-11-06, about 6:50 PM. These override anything above that disagrees.

1. **Timeline length = the `.360`.** The overlay and `ride.volthud.json` are exactly as long as the `.360` (all chapters), with t=0 at its first frame. Where Volt data is missing (before or after the ride, or in gaps), channel samples are `null` and per-channel gap ranges are listed, so the HUD can show a grey "[no data]" state.
2. **Reframe workflow:** GoPro Player exports an equirectangular MP4, which goes into Premiere with GoPro's Reframe plugin. Assume that MP4 shares the `.360`'s t=0 and length; verify on the sample MP4 the owner is sending.
3. **No long ProRes renders and no non-AE renderer (plan B dropped).** The main path is **Dynamic Link** of the AE comp into Premiere. ProRes 4444 is only for short temporary previews. M0 measures Dynamic Link playback and scrubbing of a long comp.
4. **Defaults approved:** scooter (dash) speed, smoothed, with GPS fallback and a per-sample source flag; coordinates off; `gh` for updates. Phone motion recording is assumed on.
5. **Volt export:** a new "all in one" file becomes the DEFAULT export checkbox; the separate checkboxes stay. That is a separate Volt PR (M8).

Core decisions made while building M1–M4 (2026-11-06):

- The core is CommonJS and runs on Node 17.7 (CEP 12) and Node 20; it avoids Node 18+ APIs. Tests use `node:test` on Node 20.
- gopro-telemetry is the only runtime dependency (its npm `license` field says ISC; the LICENSE file is MIT). gpmf-extract and mp4box are not used: our own moov reader feeds gopro-telemetry.
- Chapters are parsed one by one and placed on the video timeline by our code (offset = sum of earlier video durations), rather than with gopro-telemetry's own merge.
- See `derivations.md` for smoothing and the sync fallbacks used when the GoPro has no GPS fix.

## Core status and real-sample findings (2026-11-06)

Built: `core/` (moov reader, GoPro loader, Volt reader, sync, derivations, timeline, HTML report, MP4 t=0 check) and `cli/volthud.js` (`probe`, `sync`, `check-mp4`). Tests run on Node 20 with synthetic fixtures; a Node 17.7 smoke job runs the core as CEP 12 would. Outputs from owner data go only to `work/owner-data/hud-samples/out/`.

**M1 (GPMF reader), sample `GS011302.360` (GoPro MAX):**

- The moov reader's gpmd bytes are identical (SHA-256) to `ffmpeg -map 0:3 -c copy -f data`. That is 234 samples, 2.83 MB, read through the sample tables in under 1 s.
- Streams and rates: ACCL 202 Hz, GYRO 809 Hz, MAGN 25 Hz, GPS5 18 Hz, CORI/GRAV/IORI 29.97 Hz, plus SHUT, WBAL, WRGB, ISOE, UNIF, DISP, WNDM, MWET and AALP. There is **no GPS9 on the original MAX**; GPS5 + GPSU.
- **The camera never got a GPS fix:** GPSF = 0 and GPSP = 9999 in all 234 payloads, and GPS5 speed is 0 throughout. GPSU still advances (receiver time): 00:36:23.910 to 00:40:17.935 UTC.
- The GPSU-vs-cts fit has a residual RMS of 60 ms (median 16 ms) and a slope of −92 ppm. The first payload is about 0.9 s off.
- So **GoPro speed cross-correlation was impossible on this sample**. Sync used GPSU → coarse, then IMU.

**M2 (Volt reader):**

- The phone GNSS clock fit has RMS 2 ms and slope 1.0000000. The phone wall clock runs 1264 ms ahead of GNSS.
- Power sign: under `POSITIVE_IS_DRAW`, V×A was negative in 74 % of hard-braking samples (gLon < −0.1 g) and positive in 98 % of accelerating ones. The graph convention holds.
- Drawn/regenerated energy from the timeline (25.1 / 2.8 Wh) matches the app's summary (25.5 / 2.7 Wh).

**M3/M4 (sync):**

- **Coarse** (GPSU vs phone GNSS): ride START at video t = 9.460 s.
- **IMU** (|accel| windows): START at 11.277 s, a correction of **+1.817 s**. That is consistent with the owner's "about 11 s".
- Global IMU peak: NCC 0.21, PSR 7.0. Second-best peak at −7.1 s (NCC 0.07, ratio 0.34). Confidence **medium**, score 0.32.
- Four of 11 windows were kept: +1.80, +1.80, +1.87 and +1.86 s, plus one early window at +2.57 s that was rejected. **Residual 28 ms.**
- Drift was not fitted: the window span is 73 s, under the 300 s minimum. The coarse slope (+92 ppm, from GPSU) is used.
- The three earliest windows (24–54 s) agree on +2.57 s. This 0.77 s disagreement is **unexplained**; candidates are phone sensor batching at ride start, or the rider handling the phone.
- The large coarse error suggests GPSU without a fix lags video by about 1.8 s. Treat GPSU-only coarse maps as ±3 s and search the IMU over ±10 s.
- The scooter-vs-phone GPS speed lag is about 140 ms, but the PSR is low (2.0), so this is not reliable.
- **Gyro |ω| did not correlate** (helmet/camera vs pocket), so it is not used.

**Reframed MP4 t=0 (`volthud check-mp4`):**

- The GoPro Player equirect export has **no gpmd track** (GPMF not retained).
- Audio: the AAC is **bit-identical**. NCC 1.000 at 0 ms lag in both the first 10 s and the 10 s ending 2 s before the end, so the MP4 shares the `.360`'s t=0 with no drift.
- Video: the MP4 has 7010 frames (233.900 s). The `.360` has 7011 frames on lens track 0 and **7010 on lens track 1**, so the stitched export ends with the shorter lens track. The missing frame is at the end, not the start (inferred from audio and frame counts; not compared frame by frame).
- A cheap per-frame mean-luma comparison (`--video`) was too flat to match between fisheye and equirect.
- Conclusion: the timeline's t=0 (the `.360`'s first frame) is the MP4's t=0.

**Still open:**

- One ride with stomp markers to measure the IMU's absolute accuracy and drift over a long ride.
- A ride with a GoPro GPS fix, to exercise speed xcorr on real data.
- Multi-chapter real files (tested only synthetically).
- GPS9 on a MAX2 (decoder written; untested on real data).
