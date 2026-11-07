# Derived channels and smoothing

How `core/derive/derive.js` and `core/timeline.js` turn raw samples into the HUD channels in `ride.volthud.json`. The timeline grid is video time `t = i / rateHz` (default 10 Hz) over the **whole `.360`** (all chapters). Each grid time maps to Volt monotonic time through the sync model. A sample with no data is `null`, and `gaps[channel]` lists the null ranges in seconds, so the HUD can draw its grey "[no data]" state.

"Local linear (±h)" means a least-squares line through the source samples within ±h of the grid time. Its value is the smoothed signal and its slope is the derivative. This is a first-order Savitzky–Golay filter that also works on irregular samples.

| Channel | Source and method | Valid when |
|---|---|---|
| `speedKmh`, `speedSrc` | 1. **Scooter dash** `speed_kmh` at `sensor_updated_monotonic_ms`, local linear ±1.5 s. 2. **GoPro GPS** 2D speed (fix ≥ 2), local linear ±0.5 s. 3. **Phone GPS** speed (speed accuracy ≤ 1.5 m/s), linear interpolation. `speedSrc` names the source per sample | Scooter: newest update ≤ 2.5 s old. Phone GPS: neighbouring fixes ≤ 2.5 s apart. Volt sources only inside START–STOP; GoPro GPS across the whole clip |
| `powerW`, `powerDir` | `voltage_v × current_a` from the same report (equal update time and source command), as the Volt ride graphs do. Signed by the ride's current direction, with `DIRECTION` events applied: + draw, − regen. Under `UNCONFIRMED` the value is the magnitude and `powerDir` is 0 (draw it grey). Linear interpolation between reports | Reports ≤ 2.5 s apart |
| `batteryPct` | `battery_percent`, step-hold | ≤ 60 s since the last update |
| `altM`, `vertMps` | Candidates: raw phone pressure → ISA altitude, local linear ±8 s; the route's barometric relative altitude, ±8 s; phone GPS altitude (vertical accuracy ≤ 20 m), ±5 s. Barometric spikes more than 2 m off the line through both neighbours are dropped. **The candidate with the least rough 1 Hz vertical rate wins** (standard deviation of successive differences, listed in `stats.altitudeRoughness`) | Inside the source's time span |
| `gradePct` | `100 × vertMps / speed`, moving average over 1 s | Speed > 4 m/s (14 km/h) |
| `gLon` | d(speed)/dt, local linear ±1 s on the fused speed, in g. + = accelerating | Speed valid |
| `gLat` | `speed × yaw rate / g`. Yaw rate is about the world "up" axis, from successive phone rotation-vector quaternions (`q_rel = q[k+1]·q[k]⁻¹`, ω = axis·angle/Δt), then local linear ±0.5 s. + = to the left (counter-clockwise turn). This does not depend on how the phone sits in the pocket | Speed and phone motion valid |
| `gTotal` | `hypot(gLon, gLat)` | Speed valid |
| `jerk` | Magnitude of d/dt of the (gLon, gLat) vector in m/s², local linear ±0.5 s, giving m/s³ | Speed valid |
| `utcMs` | Volt mono → UTC through the phone's GNSS clock fit | Always (an extrapolation outside the ride) |
| `lat`, `lon` | Route points, interpolated. **Only with `--coords`** (off by default) | Inside the ride |

**Real-sample note (2026-11-06):** in the pocket at speed, the raw barometer was very noisy (±10–20 m between 1 Hz samples, likely wind pressure). The phone GPS altitude was the smoothest source, so the roughness rule picked it.

## Sync signals

- **Clock fits:** Theil–Sen. Phone: GPS rows' (fix monotonic, fix UTC) pairs. GoPro: (gpmd sample cts, GPSU) per payload, or GPS9 per sample. Only fix ≥ 2 and DOP < 5 are used when at least 3 exist; otherwise all GPSU values are used, flagged `withFix: false`.
- **Speed cross-correlation:** both curves are resampled to 10 Hz with linear interpolation (no bridging over gaps > 2.5 s), high-passed by subtracting a centred moving average over ±3 s, then put through a NaN-aware normalised cross-correlation over ±10 s (±15 min without GNSS). The peak is refined with a parabola. PSR is the peak minus the sidelobe mean, divided by the sidelobe standard deviation, with sidelobes beyond ±1 s. The second-best peak is the highest local maximum outside that ±1 s.
- **IMU feature:** |accel| (orientation-invariant). Dense GoPro ACCL is box-averaged into 50 Hz bins; the phone (≈17–20 Hz) is linearly interpolated (no bridging over gaps > 0.25 s). Both are high-passed (a centred ±1 s moving average removed) and low-passed (a ±0.08 s moving average, 9 samples). A second feature is the shock envelope: the rectified feature, smoothed over ±0.25 s, minus a ±2 s moving average. The correlation is 0.6 × NCC(feature) + 0.4 × NCC(envelope).
- **IMU windows:** a global scan first (±1.5 s after a speed fit, ±10 s after a GNSS-only coarse map). Then windows of overlap/6, clamped to 20–120 s, with 50 % overlap, each searched ±1 s around the global peak. Window weight = max(0, NCC) × clamp((PSR − 2)/6) × clamp(phone accel RMS / 0.3 m/s²). Windows with weight ≥ 0.05 that are not at the search edge are kept, and those more than 3 robust σ (at least 40 ms) from the median are dropped. A weighted line gives offset and drift **only if the kept windows span ≥ 300 s and the drift is under 300 ppm**; otherwise a weighted constant is used and the unconstrained slope is reported. The residual is the weighted RMS of the kept windows about the fit.
- **Confidence:** `high` = IMU fit with ≥ 5 windows and residual < 40 ms; `medium` = an IMU fit with fewer windows, or a speed peak with PSR > 3; `low` = clock only. The score (0–1) is a documented heuristic in `core/sync/sync.js` (`syncRide`).
