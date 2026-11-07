# Research findings (2026-11-06)

Tags: **[verified]** means checked on this Mac or in source code. **[source]** means a dated primary or near-primary source. **[secondary]** means a forum or third-party post. **[unverified]** means a reasoned guess to test.

## 1. Extending After Effects 2026 and Premiere Pro 2026

### What is installed **[verified]**

- After Effects **26.5.0** ships **CEP 12.0.1** (`CEPHtmlEngine.app`) and an internal `Contents/UXP/plugins` folder that holds only Adobe's own plugins (`com.adobe.ccx.start`, `com.adobe.frameio.uxp`).
- Premiere Pro **26.5.2** has public UXP (a `UXP/` folder; UXP Plugins preferences panel) and still has CEP.
- The `com.adobe.CSXS.12` preferences domain exists, which confirms CEP 12.
- `aerender` is present, so we can render from the command line.

### Status of each technology

| Tech | After Effects 2026 | Premiere 2026 | Notes |
|---|---|---|---|
| **ExtendScript** (JSX) | Fully supported. The full DOM covers comps, shape and text layers, keyframes (`setValuesAtTimes`), expressions and the render queue | Supported (legacy QE DOM) | AE's only complete scripting API today |
| **CEP 12** (HTML panel + optional Node) | Works and is the way to build a panel in AE. **[verified]** CEP 12 lists AE 25.0 and PPro 25.0; AE 26.5 still bundles CEP 12 | Works, but is being replaced by UXP | CEP 12 bundles **Node 17.7.1**. Turn Node on with `--enable-nodejs` (plus `--mixed-context`). [CEP 12 Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md) |
| **UXP** | **Not public for third parties.** Bolt UXP says AE support is waiting for "Adobe [to make] the relevant UXP APIs public" ([Adobe dev blog, 2026](https://blog.developer.adobe.com/en/publish/2026/08/building-plugins-faster-with-bolt-uxp-and-bolt-express)). A forum post dated 2026-09-25 says AE and Illustrator "will follow" ([CC dev forum](https://forums.creativeclouddeveloper.com/t/cep-to-uxp-what-developers-need-to-know/12189)) **[secondary]** | **GA since Premiere 25.6** ([Adobe dev blog, Dec 2025](https://blog.developer.adobe.com/en/publish/2025/12/uxp-arrives-in-premiere-a-new-era-for-plugin-development)) **[source]** | UXP has no Node `require`. It has its own fs and network APIs |
| **C++ AE SDK** | Effects and AEGPs; complete but heavy (Xcode, per-version builds) | — | Overkill here; we draw with native shape and text layers |

**CEP sunset [secondary]:** the same 2026-09-25 forum post says each app gets "a guaranteed minimum of two years from its UXP public beta" before CEP is removed. It also says CEP stops shipping everywhere after **December 2029**. AE has no public UXP beta yet, so a CEP panel for AE is safe until at least late 2028. Keep the core logic host-neutral so a later UXP port only swaps the UI shell.

### Data-driven animation in AE

- AE imports **JSON, CSV, TSV and `.mgjson`** as footage. Expressions read them with `footage("x.json").sourceData` and `footage("x.csv").dataValue([col,row])`. MGJSON streams can be pick-whipped like properties.
- **Performance is the weak spot [secondary]:** AE engineers acknowledged slow load, save and render when data footage sits in comps, and suggested a single "data comp" as the workaround ([AE bug report](https://community.adobe.com/bug-reports-528/performance-for-automation-1216914); [CSV slowness report, AE 25.0.1/24.6.3](https://community.adobe.com/bug-reports-528/slow-csv-performance-and-essential-graphics-text-style-handling-1216241)). Expressions that index a big array on every frame for every layer get slow fast.
- **Conclusion [unverified, milestone M0]:** bake the data into **keyframes** with ExtendScript instead. Put Slider Control keyframes on one "VOLT DATA" null with `setValuesAtTimes`, one batch call per channel at 10 Hz. A 60-minute ride is 36k keys per channel × ~12 channels. Widget layers use tiny expressions that read those sliders, for example the text `Math.round(thisComp.layer("VOLT DATA").effect("speed")(1))`, so they never parse a file. M0 measures build time, project size, scrubbing and render time, and compares this with `sourceData`. Fallback for very long rides: one comp per chapter or per 15 minutes.
- **gopro-telemetry's `mgjson` preset** (`code/presets/toMgjson.js`) **[verified in source]** forces `dateStream`, groups samples to the video **frame rate**, and splits arrays over 3 axes into extra streams. It is fine for a quick look at raw GoPro streams, but it **does not fit our needs**: no Volt data, no sync, no derived channels. It also ties us to MGJSON's own performance. We use gopro-telemetry's JSON output instead.

### Rendering with alpha

- AE's built-in output module template **"High Quality with Alpha" is QuickTime ProRes 4444** ([AE beta forum, Adobe staff](https://community.adobe.com/questions-534/changes-to-output-module-templates-and-defaults-313955)) **[source]**.
- Script: `var rq = app.project.renderQueue.items.add(comp); rq.outputModule(1).applyTemplate("High Quality with Alpha"); rq.outputModule(1).file = new File(path);`. Look the exact name up in `outputModule(1).templates` rather than hard-coding it, because names are localized. `app.project.renderQueue.render()` blocks AE; queueing in Media Encoder (`queueInAME`) does not.
- **[unverified]** that the 26.5 template is still ProRes 4444 with "RGB + Alpha, Straight". M0 checks this.

### Premiere side

- **UXP (GA):** `project.importFiles([...])` returns only a boolean, so find the new item by diffing the bin ([forum, 2025–26](https://forums.creativeclouddeveloper.com/t/de-facto-way-to-get-projectitem-of-newly-imported-media-in-premiere-pro-uxp/11791)) **[secondary]**. `SequenceEditor.createInsertProjectItemAction(item, time, vTrack, aTrack, limitShift)` (and the overwrite variant) must run inside `project.executeTransaction` ([forum](https://forums.creativeclouddeveloper.com/t/how-to-add-clips-to-a-sequence-using-premiere-pro-uxp-api/8977)) **[secondary]**. So "import the ProRes and place it on V2 at the reframed clip's start" is doable from a small UXP panel.
- **Dynamic Link:** an AE comp dropped into Premiere keeps alpha and stays live, but playback re-renders through AE. With thousands of keyframes over an hour, expect sluggish scrubbing **[unverified]**. **Owner decision (Nov 6): Dynamic Link is the main path**; ProRes 4444 is only for short temporary previews. M0 measures Dynamic Link scrubbing on a long comp.
- **MOGRTs:** data-driven MOGRTs take a spreadsheet for charts. They have no time-series support, so they are **not useful** for a per-frame HUD.

### Recommendation

A **CEP panel in After Effects** whose Node side runs a host-neutral JS core (parse, sync, derive). It calls **ExtendScript** to build the comp from a normalized timeline file, which goes into Premiere by Dynamic Link (a short ProRes 4444 render only for previews). The same core runs as a **Node CLI** for tests and batch use. A tiny **Swift Mac app** installs and updates the panel. Later, an optional **Premiere UXP panel** places the comp. Full reasoning is in `plan.md`.

## 2. Node inside the extension

- **CEP: yes [source]**, Node 17.7.1 with `--enable-nodejs`. gopro-telemetry and gpmf-extract are plain CommonJS (mp4box is their only dependency), so they should run there. **[unverified on 17.7.1]** gopro-telemetry 1.2.11's engines and syntax; M0 loads it in the panel. The panel's CEF process is separate from AE's main thread, so parsing does not freeze AE. ExtendScript calls do block AE, so keep each one short.
- **UXP: no.** It has no `require` of Node modules and no Node `fs`; bundled pure-JS code plus UXP's fs could work, but this is moot for AE today.
- **Licenses [verified]:** gopro-telemetry 1.2.11 (commit `1b7160e`, 2025-10-16) and gpmf-extract 0.3.3 (commit `e2de570`, 2026-03-24) are both **MIT**, © Juan Irache. mp4box.js is BSD-3-Clause **[unverified version]**. Install them through npm in the build; never vendor them into this repo.

## 3. GPMF in `.360` files

- **Track [source]:** GPMF lives in a timed-metadata track with handler "GoPro MET" and sample type `gpmd`. Timing comes from that track's `stts`/`stsz`/`stco` ([gpmf-parser README](https://github.com/gopro/gpmf-parser)). In MAX `.360` files ffprobe usually shows it as **stream 0:3**, or 0:2 in TimeWarp ([Trek View](https://www.trekview.org/blog/using-ffmpeg-process-gopro-max-360/)) **[secondary]**. Never hard-code the index.
- **gpmf-extract with big files [verified in source]:** in Node it accepts a **whole-file `Buffer`** and then copies it byte by byte into a new ArrayBuffer (`toArrayBuffer`), which takes 2× the file size in RAM. A 4–30 GB `.360` is impossible that way. It also accepts a function `(mp4boxFile) => …` so the caller can feed chunks, but mp4box still needs the gpmd sample bytes.
- **Our plan:** a ~150-line **moov reader** in Node. It reads the box tree with `fs.read` at offsets, finds the `gpmd` trak (`mdhd` timescale, `stts`, `stsz`, `stsc`, `stco`/`co64`), then reads only those samples. That is about 1 MB per minute of video, in constant memory. It outputs the same `{rawData, timing}` that gopro-telemetry expects. **[unverified until the first sample]**
- **ffmpeg fallback** (for debugging, or if the reader chokes on a file):

  ```sh
  ffprobe -v error -show_entries stream=index,codec_tag_string -of csv=p=0 GS010042.360 | grep gpmd   # -> e.g. "3,gpmd"
  ffmpeg  -v error -i GS010042.360 -map 0:3 -c copy -f rawvideo gpmd.bin
  ffprobe -v error -select_streams 3 -show_entries packet=pts_time,duration_time,size -of csv=p=0 GS010042.360 > gpmd-timing.csv
  ```

- **Streams and rates [source, gpmf-parser README]:**
  - **MAX** = HERO7 set + CORI/IORI/GRAV (frame rate) + MAGN (24 Hz). ACCL and GYRO at ~200 Hz (m/s², rad/s). GPS5 at 18 Hz with GPSU (UTC, 1 Hz).
  - **MAX2** = "all HERO13 metadata" + MNOR/OCNF/MAGN. HERO13 has **GPS9 at 10 Hz**: lat, lon, alt, 2D speed, 3D speed, days since 2000, seconds since midnight (ms), DOP, fix. GPS5 is "deprecated". MAX2 has GPS ([GoPro launch coverage, 2025-09](https://old.imaging-resource.com/news/2025/09/23/gopro-max-2-launched-price-8k-360-video-features-and-where-to-buy)). **[unverified]** that GPS9 is present in MAX2 `.360`.
  - Sample rates are not stored; work them out from TSMP and MP4 timing. STMP (µs) is listed only for Fusion.
  - gopro-telemetry picks GPS9 over GPS5 with `stream: ['GPS']`.
- **Clocks:**
  - Video and IMU share the MP4 `cts` timeline (camera crystal). `GPSU`/GPS9 give satellite UTC.
  - The MP4 `creation_time` is camera-local time labelled UTC, which gpmf-extract "corrects" with the Mac's zone offset. That is wrong when travelling, so use GPS time when available.
  - gopro-telemetry's own to-do list says streams "look out of sync some times" **[verified in README]**, so our fine IMU sync checks that the GoPro's GPS and IMU agree in time.
- **Reframed MP4:** the GoPro Player (Mac) batch exporter has a "**Retain GPMF data**" option ([Trek View](https://www.trekview.org/trek-pack/v2/processing)) **[secondary, older]**. Player trims only the ends ([Reddit, Jan 2026](https://reddit.sentinel-team.org/posts/1qd9n80/snapshots/2026-01-16T05%3A00%3A37.433406Z)) **[secondary]**. **[unverified]** that an untrimmed export keeps t=0. The sync design checks it three ways: GPMF in the MP4, duration, then audio cross-correlation.
- **Chapters:** `GS01xxxx.360`, `GS02xxxx.360` share the file number. gopro-telemetry merges an array of `{rawData, timing}`. The last 1–2 s of each chapter often has no GPMF **[source: gopro-telemetry README]**.

## 4. Volt data

See `volt-data-formats.md`.

- **Verdict:** the combined JSON is **not enough on its own**. It lacks motion samples, scooter series on their own clock, raw pressure, direction events and the time zone. Today we need combined + Sensor CSV + Motion CSV.
- **Proposal:** a single columnar "Everything (JSON)" export, plus gyro recording.

## 5. Sync

See `sync-design.md`. The key finding: **both sides record GNSS UTC.** Volt's GPS rows store `Location.getTime()` against `elapsedRealtime`, and the GoPro stores GPS9 or GPSU against `cts`. So coarse sync and drift come from clock fits, not guesswork. Speed and IMU correlation then refine the result to about one frame.

## 6. HUD

See `hud-design.md`.

- **Tokens [verified]** come from `Ui.java` (dark) and the riding-mode drawing code.
- **Font:** Saira, OFL 1.1 [verified license file]. Its default digits are proportional, and it has `tnum` [verified by parsing the font].

## 7. Mac installer and updater

- **Signing identity [verified]:** `security find-identity -v -p codesigning` → **0 valid identities**. There is **no Developer ID**, so there is no notarization. Options:
  - **(a) build locally:** Xcode signs to run locally, with no Gatekeeper prompt for apps you build yourself.
  - **(b) ad-hoc sign** (`codesign -s -`) the app shipped in Releases and remove quarantine on first run. Files fetched by `gh`/`curl` are not quarantined; browser downloads are.
  - **(c)** buy the $99/yr Apple Developer membership for Developer ID and notarization. Not needed for one user.
- **UPIA [verified on this Mac]:** `/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent` supports `--install <file.zxp>`, `--remove <name>`, `--list all` and `--version`.
- **ZXP signing [source/secondary]:**
  - `ZXPSignCmd -selfSignedCert US ID "JJRicks" "Volt HUD" <pw> cert.p12`, then `ZXPSignCmd -sign src/ out.zxp cert.p12 <pw> -tsa http://timestamp.apple.com/ts01`. Apple's TSA was the reliable one in 2025 ([Adobe community](https://community.adobe.com/bug-reports-728/zxpsigncmd-sign-process-is-broken-segmentation-fault-1331508/index3.html)).
  - **[unverified]** that UPIA accepts a self-signed ZXP. Tools such as Anastasiy's ZXP Installer have historically accepted them.
  - **Simpler fallback:** copy the unpacked extension into `~/Library/Application Support/Adobe/CEP/extensions/` and set `defaults write com.adobe.CSXS.12 PlayerDebugMode 1`. This lets *any* unsigned CEP extension load, which is a small security trade-off; use it for development only.
- **Updates from a private repo:**
  - Embedding a GitHub token in the app is unsafe (anyone with the app has the token).
  - **Recommended:** the app shells out to the owner's already-authenticated **`gh`** CLI (`gh release view/download -R JJRicks/volt-hud`). Our code never handles a token.
  - **Fallback:** the owner pastes a fine-grained PAT (read-only *Contents* on this one repo, with an expiry) and the app stores it in the **Keychain**.
  - Verify downloads with the SHA-256 listed in the release notes.
- **Sparkle vs a simple check:** Sparkle 2 needs an appcast, EdDSA keys and a hosted feed, and it fits signed and notarized apps best. For one user, a **"Check for updates" button plus a launch-time check** through `gh` is smaller and enough.
