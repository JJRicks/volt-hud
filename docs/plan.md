# Plan

> **Parked idea (owner, 2026-11-06):** a cross-platform *Volt Studio* desktop app for DIY action videos (GoPro, DJI, Insta360) that contains the AE plugin. See [idea-volt-studio.md](idea-volt-studio.md).

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
mac/       Package.swift (SwiftPM: VoltHUDKit, VoltHUD app, volthud-installer CLI)  build-app.sh
tools/     make-zxp.sh  fixtures/ (synthetic generators; no private ride data)
docs/
```

## Milestones (build order, riskiest first)

| # | Milestone | Proves | Needs owner data? |
|---|---|---|---|
| **M0** | **AE spike:** a CEP panel loads in AE 26.5 (PlayerDebugMode); `require('gopro-telemetry')` works on Node 17. A JSX bakes a *synthetic* 60-min, 10 Hz, 12-channel timeline into 4 widgets. Measure build time, `.aep` size, AE scrubbing, and **Dynamic Link playback and scrubbing of the long comp in Premiere** (alpha over the reframed MP4). A short ProRes 4444 preview checks the alpha only. Compare with the `sourceData` expression approach | AE can carry hour-long data; Dynamic Link stays usable. **Done (Nov 6):** baked keys win ([m0-results.md](m0-results.md)); owner confirmed Dynamic Link of the 60-min comp is stable | No |
| M1 | **GPMF reader** on a real `.360` (+ chapters): moov reader → gopro-telemetry; list streams and rates; GPS9 vs GPS5; check against the ffmpeg extraction. Check the reframed MP4's t=0 (duration, retained GPMF, audio xcorr) | MAX/MAX2 assumptions | **Yes: sample `.360` + reframed MP4** |
| M2 | **Volt reader** (combined + sensors + motion), power sign check on a ride with braking, clock fit | Sign convention, clocks | Yes: matching Volt exports |
| M3 | **Sync v1:** GNSS fits + speed xcorr, CLI HTML report (overlaid curves, confidence) | Seconds-level sync | Yes |
| M4 | **Sync v2:** windowed IMU + drift fit; synthetic offset/drift tests; one real ride with stomp markers | Frame-level sync | Yes (one marked ride) |
| M5 | **Comp builder:** all widgets, presets, units, accent, safe areas, 16:9 and 9:16; "Saira HUD" tnum font. **Built (Nov 6):** `core/hud/` + `ae/jsx/build-comp.jsx`, see below | The look | No |
| M6 | **Panel UX:** file pickers, sync strip with nudge, build, add to render queue. **Built (Nov 6):** `ae/ext/`, `core/pipeline.js`; installed as Window > Extensions > Volt HUD | End-to-end in AE | — |
| M7 | **Mac app:** installs the ZXP via UPIA (self-signed), update check via `gh`, ad-hoc signed. **Built (Nov 6):** `mac/`, see [mac-app.md](mac-app.md). Real UPIA install → update → remove passed with a throwaway bundle id; no GitHub release published yet | Install and update | — |
| M8 | *Volt PR (separate repo, normal Codex review)*: "Everything (JSON)" export + gyro + time zone; add the new reader. **Done in v0.1.1 (Nov 6):** Volt 1.12.0 shipped `volt-ride-everything` v1 (time zone yes, gyro no); `core/parse/volt.js` reads it into the same structures, equivalence-tested ([volt-data-formats.md](volt-data-formats.md) section 7) | One-file input | — |
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
- Scooter speed vs phone GPS speed: the scooter value leads by about 260 ms (PSR 3.2). That is weak evidence; the expected direction was a lag.
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

## M5/M6 status (2026-11-06)

**Comp builder (M5).** `core/hud/spec.js` turns a timeline into a HUD spec (layout per preset and
aspect, units, accent ramp, decimated keys); `ae/jsx/build-comp.jsx` builds it in the current
project: a hidden `VOLT DATA` null holds baked slider keys (plus `_ok` hold keys for the grey
`[no data]` state) and every widget in [hud-design.md](hud-design.md) reads them with small
expressions. Presets: Focus, Corner, Strip (16:9) and Vertical, Corner, Strip (9:16); HD or 4K;
metric/imperial; any accent; plate opacity, scale and safe area; coordinates and the route map
only with the explicit GPS opt-in. The comp is exactly as long as the `.360` timeline.

- Font: **Saira HUD** (`ae/ext/fonts/`, built by `tools/make-font.py`): Saira with tabular digits
  as the default figures, renamed so AE never mixes it with a stock Saira. OFL 1.1 (no Reserved
  Font Name), licence beside the files. AE needs it installed: the panel's "Install Saira HUD"
  button copies it to `~/Library/Fonts`, then restart AE.
- Synthetic 60-min (10 Hz) build: spec 0.8 s, **build 1.3 s**, 45,909 keys, 57 expressions,
  3.1 MB `.aep` (the M0 spike: 18 s, 432k keys, 22.8 MB). aerender frames checked by eye
  (`docs/hud-frame-*.png`, synthetic with fictional coordinates). No expression errors at the
  start, middle and end.
- Real sample (`GS011302`, 3:53): spec 33 ms, **build 0.5–0.6 s**, 4,362 keys, 7011 frames
  (matches the `.360`), checked over the equirect MP4 (outputs only in `owner-data/hud-samples/out/`).
- Test harness: `ae/test/run-build.sh <spec> <out.aep>` and `ae/test/render-frames.sh`.

**Panel (M6).** `ae/ext/` (CEP 12, Node 17.7) over `core/pipeline.js`: pick the `.360` (sibling
chapters are added), the Volt export (the Everything JSON on its own; or a folder, or any one older
file: the rest of that ride's exports in the same folder come along, since the combined JSON alone
lacks the sensor and motion series),
and optionally the reframed MP4 (duration plus an audio t=0 check with ffmpeg when present).
Load and sync runs in the panel (1.4–1.9 s on the sample); the sync strip shows Volt vs GoPro
speed over the whole video and 20 s of IMU bumps around the strongest window, with a match score
and ±1 f / ±10 f / ±1 s nudges or a value in ms. Build writes the timeline and spec privately
(`~/Documents/Volt HUD/<ride>/`, files 600) and calls `VoltHUD.build`. "Add preview to render
queue" adds at most 30 s with "High Quality with Alpha" (verified: ProRes 4444, `yuva444p12le`).

- Package: `tools/make-zxp.sh <ZXPSignCmd> <workdir> [X.Y.Z]` writes `VoltHUD-X.Y.Z.zxp`
  (bundle `com.jjricks.volthud`, self-signed, no PlayerDebugMode). 0.1.0 is installed with UPIA
  in AE 26.5.
- Checked end to end in AE on the real sample by driving the panel through its automation event
  (`com.jjricks.volthud.run`, used only by tests): load, sync (11.277 s, medium), a +2-frame nudge,
  16:9 Focus and 9:16 Corner imperial builds, preview item, a 12 s preview render.
- Not exercised by hand: the native file dialogs and button clicks (the automation path calls the
  same functions), multi-chapter real files, a ride without motion data in the panel.
- 0.1.1 (Everything input): checked on the real sample with the CLI and with the panel's own
  pipeline calls in Node (load, sync 11.277 s medium, +2-frame nudge, Focus 16:9 and Corner 9:16
  imperial specs), identical to the older files. Not yet run inside After Effects: AE was open in
  the owner's session, so the panel was not reinstalled for the automation-event check.
- 0.1.2: the clock uses the ride's recorded zone (explicit `--tz`/style first, the Mac last); a
  "Clock: …" line in the panel's Look section and in the CLI output.
- 0.1.2 checked in AE 26.5 on the real sample (installed with `volthud-installer install`, driven by
  the automation event, new unsaved project, AE quit after): header 0.1.2; Everything-only pick,
  old folder pick and an Everything copy with a recorded zone all load, sync 11.277 s medium, and
  build (16:9 Focus, 9:16 Corner imperial) with no expression errors; clock line "this Mac's zone"
  for the sample (recorded before Volt kept zones) and "from the ride" for the zoned copy.
- 0.1.3: the speed number shows one decimal by default (owner, Nov 7). Style `speedDecimals` (1, or 0
  for whole numbers; the panel's Look › Speed). The text size is set once per ride from its top speed
  (`speedValueSize`: 125 pt for `88.8`, 100 pt once a ride passes 99.5; whole numbers keep 150 pt).
- 0.1.3 checked in AE 26.5 on the real sample (installed with `volthud-installer install`, driven by
  the automation event, new unsaved project, AE quit after): header 0.1.3; 16:9 Focus builds with
  one-decimal readings at 125 pt (widest sampled reading 264 px against the 280 px budget, a dash
  before the ride starts) and 9:16 Corner imperial with whole numbers at 150 pt; no expression errors.
- 0.1.4 (owner approved Nov 7): sync without GoPro GPS, merged from `claude/sync-no-gps`. Also from the owner's two fresh rides: a robust GoPro clock fit, overlap-weighted search, and a set camera clock narrows the search and flags the wrong ride (docs/sync-design.md, "Camera clock and GPS clock fixes").
- Sync without GoPro GPS (owner, Nov 7; branch `claude/sync-no-gps`): distrust an unset camera clock, search the whole ride (stops and starts, speeding up and braking, bumps; FFT, overlap at least min(60 s, half the shorter)), honest low when unsure, and a manual anchor (`--anchor-video-s`, panel "I start rolling at the playhead"). Real sample without GPS time: 11.290 s, medium (truth 11.277 s). See docs/sync-design.md, "No GPS on the GoPro".
- 0.1.4 checked in AE 26.5 (installed with `volthud-installer install`, driven by the automation event, new unsaved
  project per job, AE quit after): header 0.1.4; the sample 11.277 s medium; the owner's two fresh rides 54.018 s high
  (2 chapters) and 14.522 s medium; all built with no errors. `VoltHUD.playhead` read 11.3 s on a reframed-MP4 layer
  starting at 2 s (13.3 s comp time), 11.33 s at 50 % stretch, the comp time with `hud: true` in the Volt HUD comp, and
  the comp time flagged as a guess in a comp without the video. A start mark at 11.3 s (the Volt START time, not the
  rolling time) gave low with the note that the search prefers a start 19 s later; marked at 30 s, where the rider
  starts rolling, the CLI gives 11.290 s, medium, with the search and bumps agreeing. Not run: a real click on the button
  (the click only reads the playhead and re-syncs, the two halves checked above).
- 0.1.5 (owner approved Nov 8): stronger text contrast over bright video (near-text labels, lifted "[no data]" grey, a tight dark halo plus a soft shadow on every text layer); a second sync anchor, "Data starts here (I tap Record)" (`--anchor-start-video-s`): put the playhead on the moment you tap Record in Volt and Volt START goes there, fine-tuned within 2 s, with the same low-confidence rules as the rolling mark; a stopped scooter reads exactly 0 (a hysteresis mask on the displayed speed: under 0.4 km/h for 0.5 s stops it, back at 0.6 km/h; 1.2 / 1.8 km/h for GPS sources; zero runs always keyed so AE interpolates exact 0). The dash speed, the timeline and trip distance are unchanged.
- 0.1.5 checked in AE 26.5 (installed with `volthud-installer install`, driven by the automation event, new unsaved project per job, AE quit after): header 0.1.5; sample auto sync 11.277 s medium; Record mark at 11.3 s gives 11.290 s medium; rolling mark at 30 s gives 11.290 s medium; a Record mark 14 s off (CLI) stays where set, low, with the note that the search prefers 11.2 s; second ride GS011305 14.522 s medium. Speed text read in AE through the expressions: stopped times read 0.0 on the sample and on GS011305 (including 12.5 to 14 s and 162 to 185 s, which read 0.1 to 0.2 before); real slow rolling at 14.8 s read 0.5 mph; moving times read their speed. `VoltHUD.playhead` read the layer time with either button word, and the no-comp error names the button. Before/after frames over the sample's brightest frames are in owner-data/hud-samples/out/v015-ae/contrast/. Not run: a real click on the buttons (the click only reads the playhead and re-syncs, the two halves checked above).
- 0.1.6 (owner approved Nov 9): Assemble project in the Mac app builds new After Effects and Premiere projects from a folder: MP4s on V1, HUD comps on V2 by Dynamic Link, GoPro Reframe at the matching size. Coordinates and map default on in the look and the panel. Checked on the 07Nov2026 folder at 1080p 16:9 and 4K 9:16 (`volthud-installer assemble`, same `Assemble.run` as Go). Not run before release, by the owner's choice: a real click on Go, 1080p 9:16 and 4K 16:9 in Adobe. The CLI still needs `--coords`.
- 0.1.7 (owner approved Nov 9): recordings from a camera with no GPS lock load instead of crashing the reader, a folder whose recordings can't be read no longer reports a missing MP4, and Assemble sets Reframe's Pan 90, Tilt -10 and Zoom 60 for the owner's fixed mount.
- 0.1.8 (owner approved Nov 9): Assemble exports any missing MP4s with GoPro Player first (Faster preset, Direction Lock off, Horizon Level on, saved next to the .360s), then builds one Premiere project from every ride in the folder, in order.
- 0.1.9 (owner approved Nov 9): when Assemble finishes from the Go button, Premiere comes to the front and a "Processing complete" notification appears; a failed run notifies "Processing failed" and leaves Premiere alone.
