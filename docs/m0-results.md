# M0 results: After Effects spike

Run on 2026-11-06 with After Effects 26.5 (26.5x89, Apple Silicon) and synthetic data only.
There was no owner data and no long renders. Code is in `ae/spike/` and `ae/cep-spike/`. The
Dynamic Link step is manual, for the owner: see [m0-dynamic-link-check.md](m0-dynamic-link-check.md).

## Verdict

- **AE carries an hour of baked data easily.** The 60-minute comp holds 12 channels × 36,000
  keys (432k keyframes). It builds in 18 s, saves as a 22.8 MB `.aep`, opens in 0.5 s, and
  renders about 20–25 ms per frame. Start, middle and end of the hour cost the same.
- **Baked keyframes win** over `sourceData` expressions:
  - **Correct in aerender.** `sourceData` comps render correctly only in the GUI. In `aerender`
    their expressions fail silently: widgets show defaults (0, red), and no error is logged.
  - **Faster.** Baked keyframes open about 8–30× faster (0.09–0.52 s vs 2.8–4.0 s; the JSON is parsed on
    every open) and render about 1.5× faster (25 vs 38 ms per frame in the GUI). Each expression
    reads 5× faster (8 vs 37 ms for four text layers).
  - **What `sourceData` has going for it:** a tiny `.aep` (279 KB plus the 2.9 MB JSON beside it)
    and a 3 s build. Neither matters at these sizes.
- **Dynamic Link: confirmed by the owner (2026-11-06).** The owner linked `hud-baked-60.aep` into
  Premiere by hand ([m0-dynamic-link-check.md](m0-dynamic-link-check.md)): "definitely working",
  "stable dynamic link though, looks great". The spike's widgets were deliberately rough; the
  real look is M5's.
- **CEP + Node works without PlayerDebugMode.** A self-signed ZXP installed with UPIA loads in
  AE 26.5. It reports **Node v17.7.2** (CEP 12.0.0, Chromium 99, arm64). `require('gopro-telemetry')`
  loads from the bundled `node_modules` in 37 ms, and also by bare name. A smoke call runs it: it
  rejects empty input with "Invalid GPMF data", so the module really executes.

## Measurements

The synthetic timeline is from `ae/spike/gen-synth.js`: 10 Hz, 12 channels. It has `null` gaps:
scooter channels at 0–20 s, 30:00–30:30 and the last 25 s; GPS for 15 s at 33%. The comp holds 4
widgets: a speed number and arc, a power bar (green for regen), a battery, and a clock. They use
16 expressions in total. The comp is 1920×1080, 29.97 fps and exactly 60:00 long.

| | Baked keyframes, 60 min | `sourceData`, 60 min | Baked, 10 min |
|---|---|---|---|
| Read and eval the JSON in JSX | 3.5 s | 3.5 s | 0.12 s |
| Build (comp + keys + expressions) | **18.0 s** (432,031 keys) | 3.0 s | 1.0 s (72,031 keys) |
| Whole build script (build, save, reopen, probe) | 22 s | 10 s | 1.4 s |
| `.aep` size | **22.8 MB** | 0.28 MB (+2.9 MB JSON) | 4.05 MB |
| Project open, cold (first in a fresh AE session) | **0.52 s** | 4.0 s | — |
| Project open, warm | 0.09–0.13 s | 2.8–3.6 s | 0.08 s |
| Expression probe (4 text layers at one time) | 8 ms | 37 ms | 8 ms |
| `aerender`, 1 frame each at 0:59 / 29:48 / 59:16 | 5.1 / 5.1 / 5.1 s wall; render "0 s" | 8.1 / 8.1 / 8.1 s wall; **wrong output** | — |
| `aerender`, 150 frames (ProRes 4444) at start / mid / end | 8.1 / 8.1 / 8.1 s wall, 3 s render → **about 20 ms per frame** | not run (broken in aerender) | — |
| GUI render queue, 150 frames at 29:40 | 3.8 s → **25 ms per frame** | 5.7 s → 38 ms per frame (correct) | — |

**Notes:**

- **Wall time vs render time.** `aerender` wall time is mostly the cost of launching the render
  engine and opening the project: about 5 s with baked keys, 8 s with `sourceData`. Its log reports
  only whole seconds, so the per-frame figures come from the 150-frame spans.
- **The `[no data]` state checks out.** Probes return `[no data]` at 0:01, 0:10, 30:05 and 59:55.
  At 0:25, 15:00, 45:00 and 59:30 they return live values, for example
  `11 | 763 W | 43% | 17:49:12`. There were no expression errors.
- **Reference frames.** The PNG references from `aerender` are in `ae/spike/ref/`. They are
  converted from TIFF, as explained under "Gotchas".

### Short alpha preview (ProRes 4444)

- **Settings:** a 10-second render-queue item (frames at 0:30–0:40) with the built-in template
  "High Quality with Alpha", rendered by `aerender -rqindex 4`.
- **Time and size:** 12 s wall (6 s render) for a 36.8 MB file.
- **ffprobe:** `codec_name=prores`, `profile=4444`, tag `ap4h`, **`pix_fmt=yuva444p12le`**,
  1920×1080, 30000/1001, 300 frames, duration 10.01 s.
- **Alpha is real.** On a mid frame, the alpha plane spans 256–3773 (12-bit, limited range) with
  an average of 320, so it is mostly transparent with opaque widgets.
- **Correction to research.md:** the template's alpha is **Premultiplied**, not Straight. Premiere
  handles premultiplied ProRes 4444 correctly.

## CEP spike

- **What it is:** `ae/cep-spike/ext/` is an invisible extension (`<UI><Type>Custom`,
  `AutoVisible=false`). It starts on `applicationActivate` and runs with
  `--enable-nodejs --mixed-context`. Its Node side writes `<os.tmpdir()>/volt-hud-cep-spike.json`
  and does nothing else.
- **Packaging.** `ae/cep-spike/make-zxp.sh` copies `gopro-telemetry` and `binary-parser` into
  the package with no symlinks (Adobe's 2024 known issue). It signs with a throwaway
  `ZXPSignCmd -selfSignedCert` certificate, then runs `-verify`. ZXPSignCmd 4.1.3 for macOS
  (x86_64, run under Rosetta) came from Adobe-CEP/CEP-Resources into the session scratchpad.
  Its SHA-256 is `bc773fae…fb095`.
- **Installing with UPIA.** `--install` needs the Creative Cloud desktop app running:
  - The first try failed with status −642 after a 5-minute wait, because CC was not running.
  - With CC started, the second try returned −626, because CC was updating its own Plugins
    component at that moment.
  - The third try succeeded. UPIA installs to `/Library/Application Support/Adobe/CEP/extensions/<ExtensionBundleName>/`.
- **No preferences changed.** `com.adobe.CSXS.12 PlayerDebugMode` was never set (still absent), and
  no Adobe preference was changed.
- **Removed afterwards** with `UnifiedPluginInstallerAgent --remove "Volt HUD CEP spike"` ("Removal
  Successful"). It ran on every AE activation and wrote a temp file, so keeping it was not harmless.
- **Side effect:** launching CC let it auto-update `CC_LIBRARIES_PANEL_EXTENSION` from 4_15_60 to 4_16_29. That update is
  CC's own; it is not from us. CC was quit afterwards.
- **For M7:** the Mac app should start CC (or check that it is running) before calling UPIA. It
  should retry on −626.

## Gotchas found (feed into M5–M7)

- **No results from `DoScriptFile`/`DoScript`.** Through `osascript` they always return `"0"` in
  AE 26.5, and they return straight away: the script runs asynchronously. "Allow Scripts to Write
  Files" is off and must stay off, so `File.write` cannot be used either.
  - The spike's workaround: write results into a folder item's **comment**, save a small result
    project as **`.aepx`** (XML), and read it back with `ae/spike/read-result.py`.
  - The real panel won't need this: CEP's `evalScript` returns values directly.
- **The output-module `Format` is read-only** through `setSettings`, and AE ships no PNG template.
  Adding a template would change preferences, so frames are rendered with "TIFF Sequence with
  Alpha" (AE reports this as Photoshop Sequence) and converted to PNG with ffmpeg.
- **`aerender` paths:** `aerender` needs an absolute `-project` path. It also leaves a
  `"<project>.aep Logs"` folder next to the project.
- **Shape stacking order:** the first group in a shape layer's contents draws **on top**. Add the
  value group before the track group.
- **Stale references:** adding properties to a shape group invalidates earlier references. Fetch
  them again by name or index after adding.
- **Disabled data layer:** a "VOLT DATA" null with its eye off (`enabled = false`) still feeds
  expressions.
- **Slider range:** Slider Control values are limited to ±1,000,000, so the clock is baked as
  seconds of the day, not epoch milliseconds.

## How to rerun

```sh
cd ae/spike
node gen-synth.js 60 out/synth-60.json            # synthetic timeline
./run-ae.sh baked out/synth-60.json out/hud-baked-60.aep        # AE must be running; prints JSON
./run-ae.sh sourceData out/synth-60.json out/hud-sd-60.aep
./render-frames.sh out/hud-baked-60.aep          # 3 single frames via aerender -> PNG
"/Applications/Adobe After Effects 2026/aerender" -project "$PWD/out/hud-baked-60.aep" -rqindex 4   # 10 s ProRes preview
ffprobe -v error -show_entries stream=codec_name,profile,pix_fmt out/hud-baked-60-preview10s.mov
```

The `out/` folder is gitignored, including the `.aep` files: 22.8 MB baked and 0.28 MB `sourceData`.
