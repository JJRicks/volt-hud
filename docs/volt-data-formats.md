# Volt ride data formats (as of Volt 1.12.0 draft, 2026-11-06)

Read from the Volt source at `work/l10n-wt/wt-rel-refresh` (commit `9ea185f6`). File and class names below are in `src/com/jjricks/volt/`. Everything here is **verified from source** unless marked otherwise. Sample files: `tests/l10n/golden/ride-journal.csv` and `tests/l10n/golden/phone-track.csv`.

## Clocks (the important part)

Volt stamps everything with two phone clocks:

- **`wall_ms`**: `System.currentTimeMillis()`, Unix ms UTC. It can jump if the phone's clock is corrected.
- **`monotonic_ms`**: `SystemClock.elapsedRealtime()`, ms since phone boot. It never jumps and is **shared by the scooter journal, the phone journal and the motion file**. That makes it the master timeline for one ride.
- **Phone GPS rows** are special: their `wall_ms` is `Location.getTime()`, which is the **GNSS fix time** (satellite UTC). Their `monotonic_ms` is `getElapsedRealtimeNanos()/1e6`, the fix's own timestamp, not when Volt received it.
- **Motion and pressure rows** use `SensorEvent.timestamp/1e6`, the sensor's own time on the elapsedRealtime base.
- **No time zone is recorded anywhere.** Date and time display needs a zone: from the proposed export, or looked up from GPS coordinates.

So each phone GPS fix gives a (GNSS UTC, monotonic) pair. A linear fit over a ride maps monotonic time to true UTC to well under 100 ms. This is the key to syncing with the GoPro, which also records GNSS UTC.

## 1. Scooter sensor journal: `Sensor CSV` (`-sensors.csv`)

The raw `files/rides/<uuid>.csv`, copied as it is (`RideStore`). It is long-form: one row per key per frame.

Header: `schema_version,event,recorded_utc,wall_ms,monotonic_ms,frame,key,numeric,text,unit,source_command,sensor_updated_monotonic_ms,sensor_age_ms,current_direction,details`

| event | meaning |
|---|---|
| `START` | `key` holds the scooter profile id, `text` the label, and `current_direction` the starting direction |
| `BEGIN` / `SENSOR`… / `COMMIT` | One frame. Only frames with a `COMMIT` count. Each `SENSOR` row is one metric |
| `GAP`, `HEARTBEAT` | Bluetooth loss and the time passing during it |
| `DIRECTION` | The rider changed the current direction (`UNCONFIRMED`, `POSITIVE_IS_DRAW` or `NEGATIVE_IS_DRAW`) |
| `NOTE`, `RENAME`, `RECOVER`, `STOP` | Housekeeping. `STOP.details` holds the auto-stop reason |

- **Rate:** one frame per service tick, every **1 s** while recording (`ScooterService` tick, `postDelayed(…, 1000)`). Each frame is a snapshot of every known metric (~94 keys in the fixture, capped at 160), stale or not.
- **When a value was measured:** use `sensor_updated_monotonic_ms`, not the frame time. A value repeats across frames until the scooter sends a new one.
- **HUD keys and units:** `speed_kmh` (km/h; tenths only from the 0x92 report, whole numbers from 0x91), `voltage_v` (V), `current_a` (A, signed), `power_w` (W, signed), `battery_percent` (%), `odometer_km`, `trip_km`, `temperature_c`, `driving_mode`, `current_sign_state` (raw 0x79 byte), `remaining_range_km`.
- It also holds identifiers such as `scooter_serial`. Secret-looking keys are already dropped (`isSecret`).

### Power sign: what the recording graphs use

The ride graphs (`RideChartData.build`, key index 0) plot `RideStore.Point.powerW`. That value is **`voltage_v × current_a`**, taken only when both come from the same report: equal `sensor_updated_monotonic_ms` and `source_command` (`RideStore.Accumulator.accept`). `current_a` is already signed by Telemetry from the scooter's 0x79 sign state (`Telemetry.refreshSignedReadings`). The graph does not flip it.

The ride's `currentDirection` decides what the sign means. Draw and regen totals follow it: with `POSITIVE_IS_DRAW`, positive is draw and negative is regen. `NEGATIVE_IS_DRAW` is the reverse. `UNCONFIRMED` means only the magnitude can be trusted.

**HUD rule:** compute power the way the graph does (V×A, same report). Map it through the ride's direction at that moment, using `DIRECTION` events for changes mid-ride. Under `UNCONFIRMED`, draw a neutral grey magnitude, as the app does. The journal's own `power_w` key should hold the same number, but the graph recomputes it, so we do too. The live riding-mode bug lives in `RidingValues`/`RidingScreen` and does not touch the recordings. *Unverified:* that one real ride with known braking shows negative V×A under `POSITIVE_IS_DRAW`. Check this on the owner's first sample.

## 2. Analysis JSON (`-analysis.json`)

`RideStore.Summary.toJson()`: one flat object of totals with **no time series**. Fields include `id`, `scooterId`, `label`, `currentDirection`, `directionConfirmed`, `startWallMs`, `endWallMs`, `elapsedMs`, `startMonotonicMs` (as a field, not in JSON), start and end battery, voltages, temperatures, odometer, distances, average, moving and max speed, peak absolute power, `drawWh`, `regeneratedWh`, `netConsumptionWh`, efficiency, `stopReason`, `shownEndWallMs` and `shownElapsedMs`. Units are in the field names. `null` means "not enough evidence".

## 3. Phone journal: `Phone raw CSV` (`-phone.csv`)

`files/phone-rides/<uuid>-phone.csv` (`PhoneRideStore`, written by `PhoneRideRecorder`). Header: `event,wall_ms,monotonic_ms,a,b,c,d,e,f,g,h,i,j`

| event | a… | rate |
|---|---|---|
| `START` | (placement, now blank) | once |
| `GPS` | lat, lon, accuracy_m, speed_mps, speed_accuracy_mps, altitude_m (WGS84 ellipsoid per Android), vertical_accuracy_m | 1 Hz (`requestLocationUpdates(GPS_PROVIDER, 1000, 0)`) |
| `PRESSURE` | hPa | about 1 Hz (thinned to ≥ 900 ms) |
| `TELEMETRY` | scooter speed_kmh, power_w (V×A, same report, same sign as above), battery %, then the three values' update times (mono) | 1 Hz (each service tick) |
| `MOTION` | count of motion rows in the last second, peak linear accel | 1 Hz summary |
| `GAP`, `STOP` | — | — |

Phone GPS and motion each have their own switch (`phone_gps`, `phone_motion`). Either may be missing.

## 4. Motion CSV (`-motion.csv`)

Header: `monotonic_ms,raw_x_mps2,raw_y_mps2,raw_z_mps2,linear_x_mps2,linear_y_mps2,linear_z_mps2,earth_east_mps2,earth_north_mps2,earth_up_mps2,rotation_x,rotation_y,rotation_z,rotation_w,accuracy`

- **About 20 Hz** (sensors registered at 50 000 µs; rows closer than 45 ms apart are dropped).
- `raw_*` is the accelerometer including gravity, phone axes. `linear_*` is Android's linear acceleration with gravity removed. `earth_*` is linear accel rotated into East-North-Up by the rotation vector. `rotation_*` is the rotation-vector quaternion.
- **There is no gyroscope stream.** We can derive angular rate from successive quaternions (20 Hz, fused, smoothed).
- Monotonic time only. Map it with the clock fit above.

## 5. Route CSV, GPX, Track JSON

`PhoneRideStore.Track` is built from the phone journal. It has **one point per accepted GPS fix**. Fixes with accuracy over 35 m are rejected, and speed is dropped when its accuracy is over 1.5 m/s. Each point joins:

`monoMs, wallMs, segment, latitude, longitude, accuracyM, speedMps, altitudeM, verticalAccuracyM, relativeAltitudeM` (from the barometer when fresh, with a 3 s EMA and spike rejection; otherwise GPS), `gradePercent`, `gpsAccelerationMps2` (speed change over ≥ 2 s), `scooterAccelerationMps2`, `powerW`, `batteryPercent`, `scooterSpeedKmh` (each only when fresh within 2.5 s).

- **Route CSV** holds all of these, plus `elapsed_ms` and `elevation_source`.
- **GPX** holds only lat, lon and time.
- **Track JSON** holds the same points, plus `distanceMeters`, `ascentMeters`, `descentMeters`, rejected counts and `motionSampleCount`. It has no motion samples.

## 6. "Scooter and phone JSON" (`-combined.json`): does it suffice?

`{"scooter": Summary.toJson(), "phone": Track.toJson()}`. **No, not on its own.** What it has: 1 Hz GPS fixes with GNSS UTC and monotonic time, GPS speed and altitude, baro-relative altitude, and scooter speed, power and battery joined per fix. That is enough for a basic speed, power and battery HUD and for coarse speed sync.

What it lacks:

| Missing | Why the HUD needs it |
|---|---|
| Motion samples (20 Hz accel and quaternion) | Fine IMU sync, phone-side g and jerk |
| Scooter time series on its own clock | Power and speed exactly when measured. Today they are resampled onto GPS fixes and dropped when no fix exists (tunnels, no GPS permission, GPS off) |
| Raw pressure | A better vertical-rate filter than the stored relative altitude |
| `DIRECTION` events, `current_sign_state` | A correct regen sign when the direction changed mid-ride |
| `voltage_v`, `current_a`, `temperature_c`, `odometer_km`, `trip_km`, `driving_mode` series | Optional widgets |
| Time zone | Local clock on the HUD |
| App version, scooter model, export schema id | Robust parsing |
| GAP events | Honest "no data" spans |

Today the HUD needs **combined JSON + Sensor CSV + Motion CSV** (or Sensor CSV + Phone raw + Motion raw). The parser will accept those.

## 7. Proposed Volt change: one "Everything (JSON)" export

*Proposal only; no Volt code changed.* It would be a new `RideExportFiles.Format.EVERYTHING_JSON` (`-ride.json`), the new `DEFAULT`, and the auto-export's JSON choice. One UTF-8 JSON file. Repeated samples use **columnar arrays**, which keep a 60-minute ride to roughly 10–15 MB.

```jsonc
{
  "format": "volt-ride", "formatVersion": 1,
  "app": {"version": "1.13.0", "build": 49},
  "ride": {"id": "...", "label": "...", "scooterModel": "UT5 MAX", "scooterId": "<profile uuid>"},
  "clock": {
    "timeZone": "America/Boise", "utcOffsetMinutesAtStart": -360,
    "anchors": [[wallMs, monotonicMs], ...],        // START, each GAP end, STOP
    "gnssFit": {"slope": 1.0000021, "offsetMs": ..., "rmsMs": 12}  // optional, from GPS fixes
  },
  "power": {"formula": "voltage_v*current_a, same report",
            "direction": [[monotonicMs, "POSITIVE_IS_DRAW"], ...]},
  "scooter": {
    "summary": { ...Summary.toJson()... },
    "series": {                                       // one entry per numeric key, deduped
      "speed_kmh": {"unit": "km/h", "t": [mono...], "v": [...], "cmd": [...]},
      "voltage_v": {...}, "current_a": {...}, "power_w": {...}, "battery_percent": {...},
      "odometer_km": {...}, "trip_km": {...}, "temperature_c": {...}, "driving_mode": {...},
      "current_sign_state": {...}, "remaining_range_km": {...}
    },                                                // t = sensor_updated_monotonic_ms; a row only when it changes
    "text": {"<key>": {"t": [...], "v": [...]}},      // optional non-numeric keys, same dedupe
    "events": [{"t": mono, "type": "GAP"|"DIRECTION"|"NOTE"|"STOP", "detail": "..."}]
  },
  "phone": {
    "track": { ...Track.toJson() as today... },
    "gps": {"t": [mono], "utc": [ms], "lat": [], "lon": [], "acc": [], "speed": [], "speedAcc": [],
            "alt": [], "vAcc": [], "bearing": [], "bearingAcc": []},   // all fixes, including rejected, flagged
    "pressure": {"t": [mono], "hPa": []},
    "motion": {"t": [mono], "raw": [[x,y,z]...], "linear": [...], "enu": [...], "quat": [[x,y,z,w]...],
               "gyro": [[x,y,z]...]},                 // gyro is new, see below
    "telemetry": {"t": [mono], "speedKmh": [], "powerW": [], "batteryPercent": []},
    "events": [{"t": mono, "type": "GAP"|"STOP"}]
  },
  "privacy": {"omitted": ["scooter_serial", "..."]}
}
```

Also proposed, each a small Volt change:

1. **Record the gyroscope** (`TYPE_GYROSCOPE`) into the motion file, and allow **50 Hz** motion (`SENSOR_DELAY_GAME`). Gyro is the best signal for fine sync; 20 Hz caps sync resolution near 50 ms. Cost: about 2.5× the motion file size.
2. **Record bearing and bearing accuracy** on GPS rows. These give heading for the mini-map and lateral g.
3. **Store the time zone** at START.
4. Leave identifiers out by default (`scooter_serial`, Bluetooth addresses), with an "include identifiers" switch for bug reports.
5. Keep the existing seven formats for compatibility. "Everything" is a superset, not a replacement.
