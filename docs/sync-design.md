# Auto-sync design: GoPro `.360` ↔ Volt ride

Goal: find the function `t_video = f(t_volt_mono)` that tells us, for every frame of the `.360` (and of the reframed MP4 that keeps its t=0), which moment of the Volt ride it shows. The target is ±1 frame (33 ms at 30 fps), with an honest confidence score and a manual nudge when the sync fails.

## Inputs, put on common clocks

| Signal | Source | Clock | Rate |
|---|---|---|---|
| GoPro video time | MP4 sample `cts` of the gpmd track | camera crystal, t=0 = first frame | — |
| GoPro GNSS UTC | GPS9 fields 6–7 (MAX2), or GPSU (MAX, 1 Hz) | satellite UTC | 10 Hz / 1 Hz |
| GoPro GPS speed | GPS9/GPS5 2D speed | cts | 10 Hz (MAX: 18 Hz GPS5) |
| GoPro IMU | ACCL (m/s²), GYRO (rad/s), GRAV, CORI | cts | ~200 Hz; GRAV/CORI at the frame rate |
| Phone GNSS UTC | GPS rows `wall_ms` (= `Location.getTime()`) | satellite UTC | 1 Hz |
| Phone GPS speed | GPS rows | mono | 1 Hz |
| Scooter speed | `speed_kmh` at `sensor_updated_monotonic_ms` | mono, plus unknown BLE/display lag | ≤ 1 Hz |
| Phone IMU | motion CSV (accel; quaternion → angular rate) | mono | 20 Hz (50 Hz plus gyro if the Volt proposal lands) |

All Volt data shares the phone's `monotonic` clock, so Volt needs no internal sync. The only exception is the scooter-speed lag, which is estimated against phone GPS speed (step 2b).

## Step 0: clock fits (no correlation needed)

- **Phone:** linear fit `utc = a_p·mono + b_p` over all GPS fixes, with Theil–Sen for robustness to the odd bad fix. The residual RMS is usually 10–50 ms (*unverified on real data*).
- **GoPro:** linear fit `utc = a_g·cts + b_g` over GPS samples with fix ≥ 2D and DOP < 5. gopro-telemetry exposes per-sample `cts` and `date`.
- The slopes capture **crystal drift** directly: typically 10–50 ppm, which is 36–180 ms per hour and matters at 30 fps.

If both fits exist, the **coarse map** is `cts = (a_p·mono + b_p − b_g)/a_g`. Expected error is about 0.1–0.5 s. The main uncertainty is GoPro's GPS-to-video latency, which earlier cameras show as a fixed lag of a few hundred ms (*unverified for MAX/MAX2*).

Fallbacks for coarse alignment:

- **GoPro has no GPS lock:** use the MP4 `creation_time`. The camera clock is set from the phone app, but it is local time labelled UTC, so gpmf-extract subtracts the Mac's zone offset, which is wrong when travelling. Use a search window of ±15 min.
- **Phone has no GPS:** use the scooter journal's `wall_ms` at START with the same ±15 min window.
- **Neither:** search the whole overlap.

## Step 1: speed cross-correlation (seconds-level)

Resample both speed curves to 10 Hz on the coarse timeline. Use GoPro GPS speed against phone GPS speed (preferred, both are GNSS Doppler) and against scooter speed. Remove samples with bad accuracy, clamp to 0–25 m/s, and normalise each window (z-score), so the cameras' different smoothing does not dominate.

```
search = coarse_from_gnss ? ±10 s : (camera_clock ? ±15 min : full overlap)
lag* = argmax_lag  NCC(speed_gopro(t), speed_phone(t + lag))   // FFT xcorr
refine with parabolic interpolation around the peak
confidence_speed = peak height, plus peak-to-sidelobe ratio (PSR)
```

Speed works because rides have stops and starts. A steady 25 km/h cruise has a flat correlation, so PSR flags it. Expect ±0.2–0.5 s.

**2b. Scooter lag:** run the same correlation between phone GPS speed and scooter speed, both on the Volt clock. That gives the scooter's reporting lag (expected 0.3–1.5 s, *unverified*). The HUD shifts scooter speed and power earlier by this lag, or keeps it if the owner prefers "what the dash showed".

## Step 2: IMU fine alignment (frame-level)

Use only orientation-invariant features. The phone sits in a pocket and the camera is on a helmet or the bar, so their axes never line up:

1. **|ω|**, the angular-rate magnitude. GoPro uses GYRO directly. The phone derives it from successive quaternions: `ω ≈ 2·log(q_{k}⁻¹ q_{k+1})/Δt`.
2. **Yaw rate about gravity**, `ω·ĝ`. Gravity comes from GoPro GRAV or a low-passed ACCL, and from the phone's raw minus linear accel. This is the turning of the scooter, which rider, phone and helmet all share. It is usually the strongest common signal; head turns add noise.
3. **Shock envelope**, `| |a| − g |`, high-passed above 0.5 Hz, rectified and low-passed at 3 Hz. Potholes and kerbs hit everything on the scooter, slightly damped through the body.

```
for each feature f in {yaw_rate, |ω|, shock}:
    resample GoPro and phone to 50 Hz on the step-1 timeline (phone upsampled from 20 Hz)
    band-pass 0.2–5 Hz, z-score per 30 s window
windows = 120 s long, step 60 s, across the overlap
for each window w:
    for each f: c_f(lag) = NCC over lag ∈ [−1.0 s, +1.0 s] around the step-1 lag
    c(lag) = Σ_f weight_f · c_f(lag)          // weights: yaw 0.5, |ω| 0.3, shock 0.2
    lag_w  = parabolic-peak(argmax c)
    conf_w = PSR(c) · min(1, energy(window)/E_min)   // quiet windows (stopped) get low weight
drop windows with conf_w < threshold
fit  lag(t) = d0 + d1·t   with weighted Theil–Sen or RANSAC over (t_w, lag_w, conf_w)
     // d1 is the residual drift after step 0; should be ~0 when both GNSS fits exist
residual = weighted RMS of (lag_w − fit(t_w))
```

Expected accuracy, *unverified until real files exist*: about 20–40 ms with the phone at 20 Hz and good turning content; 10–20 ms with a 50 Hz phone gyro. On a helmet with lots of head movement, the yaw feature degrades and shock carries more of the weight.

## Step 3: result and confidence

```
sync.json = {
  model: "linear", d0_ms, d1_ppm,                // t_video = map(t_volt)
  method: "gnss+speed+imu" | "gnss+speed" | "clock+speed" | "manual",
  confidence: "high" | "medium" | "low",
  stats: { gnss_rms_ms, speed_psr, imu_windows_used, imu_residual_ms, scooter_lag_ms },
  nudge_ms: 0                                    // user adjustment, added last
}
high   = IMU fit with ≥ 5 windows and residual < 40 ms
medium = speed peak PSR > 3 (± ~0.3 s)
low    = clock only
```

**Manual nudge:** the AE panel shows a strip of GoPro speed against Volt speed and IMU features, plus a ±frame nudge and a ±10 s slider. It also offers "mark a moment": the user scrubs to a clear bump or start in the video and taps the same spike on the Volt graph. The nudge is stored in the sync file, so rebuilding the comp keeps it.

## No GPS on the GoPro (implemented Nov 7, `core/sync/search.js`)

Sometimes the GoPro never gets GPS time (no GPSU/GPS9 UTC at all). The camera clock is then the only clock, and an unset one says 2016-01-01.

1. **Distrust a bad camera clock:** a creation time before 2020, or more than 2 days from the ride's UTC span, is ignored with a note. A plausible clock is only a cross-check (it is often hours off), never a search limit.
2. **Search every placement** where ride and clip overlap by at least `min(60 s, half the shorter of the two)`. Rides can start before the clip and end after it. Each signal is a masked normalised cross-correlation over every lag, computed by FFT (`core/util/fft.js`), so a 1-hour ride takes about 0.5 s:
   - **stops and starts:** GoPro vibration (4 s rolling RMS of high-passed |accel|, log) against scooter speed (phone GPS speed as a fallback), 2 Hz;
   - **speeding up and braking:** GoPro gravity-removed horizontal acceleration (GRAV, with its axis order and signs matched to ACCL automatically) against |d speed/dt|, 5 Hz;
   - **bumps:** the existing shock feature plus envelope, 25 Hz.
   The curves are z-scored over the plausible range and summed. Speed-based curves get ±2 s of tolerance (BLE lag), bumps ±0.1 s. The best placement is refined by the windowed IMU sync within ±2 s.
3. **Confidence:** `ratio` = the next-best placement (a local maximum at least 3 s away) over the best. **medium** needs ratio ≤ 0.75, the bump peak within 0.15 s of the result, IMU windows that agree (at least 3 windows, residual under 60 ms) and at least two agreeing signals. **high** also needs the usual IMU criteria (at least 5 windows, under 40 ms). Anything else is **low**, with a note that says why.
4. **Manual anchor** (`anchorVideoS`, CLI `--anchor-video-s`, panel "I start rolling at the playhead"): the Volt data's first sustained motion (speed at least 3 km/h for 3 s) is placed at that video time and refined within ±5 s. If the bumps do not confirm it, the mark is kept exactly as set, at low, and the note says where the automatic search would put the ride.
5. **Summary:** each result has `mode`, `agreed` (the signals that agree) and `summary`, a sentence for the owner, e.g. "Synced from stops and starts, speeding up and braking and bumps (GoPro had no GPS)."

The speeding-up/braking vote stays because it measurably helped on the owner's sample. On the full clip and four trimmed versions, it lifted two results from low to medium and fixed one wrong placement. Synthetic rides have no GRAV, so it does not run there. All negative controls (time-reversed Volt or GoPro data, unrelated synthetic rides) came back low.

Real sample (GS011302, GPS time removed, truth 11.277 s): found at 11.290 s, medium (stops and starts, speeding up and braking, bumps; ratio 0.59). With the clip trimmed to 60–200 s, the ride is longer than the clip: found at −48.71 s (truth −48.723 s), medium.

## Chapters and the reframed MP4

- **Chapters** `GS01xxxx.360`, `GS02xxxx.360`, … share the 4-digit file number after the chapter prefix. Concatenate them in chapter order into one virtual timeline: chapter k starts at the sum of the earlier video durations. gopro-telemetry accepts an array of `{rawData, timing}` for this. The last ~1–2 s of a chapter often lacks GPMF, so leave that gap open; do not interpolate across it.
- **Reframed MP4:** a full-length export from GoPro Player or Premiere's GoPro 360 workflow should start at the `.360`'s frame 0 (*unverified; the first sample test*). Three checks, in order:
  1. If the MP4 kept GPMF ("Retain GPMF data" in GoPro Player), run step 0 on the MP4 itself.
  2. Otherwise compare durations. Equal means same t=0.
  3. Otherwise cross-correlate the audio of the MP4 and the `.360` (`ffmpeg -ac 1 -ar 8000`, FFT xcorr). This finds any trim offset to well under one frame.

## Libraries

- **JS (recommended, runs in the CEP panel's Node and in a CLI):** [`fft.js`](https://github.com/indutny/fft.js) (MIT) for xcorr; Theil–Sen and parabolic peak in about 40 lines of our own code; [`ml-savitzky-golay`](https://github.com/mljs/savitzky-golay) (MIT) for smoothing and derivatives; plain `Float64Array` for everything else. One hour at 50 Hz is 180k samples per feature, which is trivial.
- **Swift alternative:** Accelerate `vDSP.correlate` / `vDSP_conv`, plus `vDSP.FFT` for long lags. This only makes sense if parsing moves into the Mac app, which the plan does not recommend.

## Pseudocode, end to end

```
gopro  = loadGpmf(chapters)            // cts-aligned streams
volt   = loadVolt(files)               // mono-aligned streams
fitP   = theilSen(volt.gps.mono, volt.gps.utc)
fitG   = theilSen(gopro.gps.cts, gopro.gps.utc, filter=fix>=2 && dop<5)
coarse = (fitP && fitG) ? gnssMap(fitP, fitG) : clockMap(gopro.creationTime, volt.start.wall)
win    = (fitP && fitG) ? 10s : 15min
lag1   = xcorrPeak(gopro.speed10Hz, volt.phoneSpeed10Hz ?? volt.scooterSpeed10Hz, coarse, win)
volt.scooterLag = xcorrPeak(volt.phoneSpeed10Hz, volt.scooterSpeed10Hz, identity, 3s)
fine   = windowedImu(gopro.imu, volt.motion, coarse ∘ lag1, ±1s)
model  = fine.ok ? robustLinear(fine) : constant(lag1)
write sync.json { model, confidence, stats, nudge_ms: previous?.nudge_ms ?? 0 }
```

## Testing the sync

- **Synthetic:** take a real Volt ride, build a fake GoPro stream from its own speed and IMU with a known offset, a 40 ppm drift and noise, and check the recovered lag.
- **Real:** one ride with a deliberate sync event at the start and the end (three hard stomps on the deck while filming the phone screen showing a Volt clock) gives ground truth for offset and drift.
