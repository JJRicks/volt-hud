# HUD design in the Volt style

Mockup: [`hud-mockup.svg`](hud-mockup.svg) (16:9, 1920×1080, default "Focus" preset).

## Tokens taken from Volt

Sources: `Ui.java` (dark theme, which is the HUD's default), `RidingScreen.java` and `RidingFrames.java` (riding mode), `site/src/styles.css` (homepage), `res/font/` and `licenses/Saira-OFL.txt`.

| Token | Value | Volt use |
|---|---|---|
| `bg` | `#111211` | page background (the HUD uses it only for a 55–70 % plate behind widgets) |
| `surface` | `#1F201E` | cards, empty power-bar track |
| `raised` | `#2A2B28` | empty battery segments (dark) |
| `outline` | `#3A3B37` | ticks, dividers |
| `text` | `#F4F5F0` | numbers |
| `muted` | `#9A9C95` | labels, units, unknown-direction power |
| `dim` | `#878982` | stale or missing data |
| `accent` | `#E32B2F` | Volt red: draw, the speed ring |
| `accentDeep` | `#B81B22` | bottom of the draw gradient |
| `ok` | `#5FCB7E` | regen, battery ≥ 30 % |
| `orange` | `#E8A23A` | battery 15–30 %, warnings |
| `danger` | `#FF6B6E` | battery < 15 % |
| `blue` | `#8FC2FF` | secondary series (phone GPS, altitude) |
| homepage `--red` / `--red-hi` | `#EA252B` / `#FF5A4D` | glow and highlight variants |
| homepage `--radius` | 26 px | large card radius |

- **Shapes:** radii are 10 dp on cards; 6 dp for battery segments with a 5 dp gap; the power bar is a full pill (radius = width/2). Ticks are 1.5 dp at 22–78 % of the bar width. The speed ring starts at 135° and sweeps 270° (`RidingFrames.RING_START_DEG`/`RING_SWEEP_DEG`).
- **Riding-mode behaviour to copy:**
  - The power bar has its zero line near the bottom (89 %). Draw fills **up** with a red gradient (`accentDeep` → lighter `accent`). Regen fills **down** in `ok` green, and only when the direction is known; unknown direction is drawn as a `muted` magnitude.
  - The power scale starts at 1,000 W draw and 500 W regen. It grows in 250 W steps to the ride's peak, capped at 6,000 W and 3,000 W. A white tick marks peak draw.
  - The battery is ten segments with bands at 30 % and 15 %.
- **Font:** **Saira** (Regular 400, Medium 500, SemiBold 600, Bold 700), under the SIL Open Font License 1.1. It is free to use in videos, and we may bundle it with the plugin; the OFL file must ship with it. **Saira's default digits are proportional** (checked locally: advances 389–682 units). It has a `tnum` feature. So that numbers do not jitter, the plan either:
  - makes a "Saira HUD" build with `tnum` frozen. The OFL allows changed copies; the Saira OFL text declares no Reserved Font Name, but this should be double-checked, and the build is renamed anyway to be safe; or
  - right-aligns each digit in a fixed slot.

## Widgets (8 + 2 optional)

All values come from the normalized timeline (see `plan.md`) at ≥ 10 Hz. "Smoothing" means what is applied before display; raw values stay in the timeline.

| # | Widget | Look | Source and derivation | Smoothing |
|---|---|---|---|---|
| 1 | **Speed** | Big Saira Bold number, unit below in `muted`; optional 270° ring in `accent`, max = ride max rounded up | GoPro GPS speed (10 Hz) by default; the scooter's `speed_kmh` (dash value, shifted by the measured lag) as an option. Scooter speed is ≤ 1 Hz and stair-steps | 0.5 s centred moving average for the number; the ring eases with a critically damped spring like `GaugeSmoother` |
| 2 | **Power bar** | Tall pill, zero line, red draw up, green regen down, peak tick, watt number beside it | V×A from the scooter journal (same report), sign mapped by the ride's `currentDirection` timeline (see `volt-data-formats.md`). About 1 Hz | Linear interpolation between reports, never past a 3 s gap (bar goes to outline, as in Volt) |
| 3 | **Battery** | 10 segments plus a `%` number; green, orange, red bands | `battery_percent`; optional voltage underneath | Hold (step), as reported |
| 4 | **Vertical rate** | Small vertical arrow gauge ±2 m/s plus a number in m/min or ft/min; optional grade % | Phone barometer: raw hPa → altitude → Savitzky–Golay derivative (window 7–9 s). Fallback: GoPro GPS altitude (10 Hz, noisier) with a 15 s window | Values under 0.1 m/s show as level, so the arrow does not flicker |
| 5 | **G-meter** | Circle with a dot trail (last 1.5 s), longitudinal on Y, lateral on X, rings at 0.25 g and 0.5 g | Longitudinal: d(GoPro GPS speed)/dt, fused with scooter speed. Lateral: v × yaw rate, where yaw rate = GoPro GYRO·ĝ (camera vertical from GRAV). Orientation-invariant, so camera mount and head turns matter little | SG derivative over 1 s for longitudinal; 0.3 s low-pass for yaw |
| 6 | **Jerk** | Thin horizontal bar centred at 0 (±3 m/s³), or a "smoothness" chip | d/dt of the smoothed longitudinal accel. Noise grows with each derivative, so: SG order 3, window ~1.5 s on speed, 2nd derivative taken directly from the SG fit | Clamp, then 0.3 s ease. Labelled "approx." in docs, not on screen |
| 7 | **Clock and date** | `14:32:07` in SemiBold, date `Thu 6 Nov` in `muted` | GoPro GNSS UTC (or the phone's GNSS-fitted clock) + time zone (explicit `--tz`/style, else the Everything export's `timeZone.recorded`, else this Mac's zone; a GPS lookup with `tz-lookup` stays an idea) | None; ticks once per second, aligned to true UTC seconds |
| 8 | **Ride stats strip** | `Trip 4.2 km · 12:31 ride time · max 31 km/h` | Integrated speed, the Volt summary | None |
| 9 | *opt.* **Coordinates** | `43.61502° N  116.20250° W` in Regular, `muted` | GoPro GPS9 or phone GPS | Off by default, for privacy |
| 10 | *opt.* **Mini-map** | Route polyline in `outline`, travelled part in `accent`, dot for "now"; no base tiles in v1 | Phone or GoPro GPS track | Polyline simplified (Douglas–Peucker, 2 m) |

If a source is missing, the widget shows the `dim` "—" style used in Volt, never a fake zero.

## Light customization (panel controls)

- **Widget toggles** for each of the 10.
- **Layout presets:**
  - *Focus*: speed centre-bottom, power bar left, battery under speed.
  - *Corner*: a compact cluster bottom-left.
  - *Strip*: a single bottom row.
  - *Vertical* 9:16: stacked at the bottom-centre.
- **Units:** km/h or mph; m/min or ft/min or grade %; g or m/s²; 24 h or 12 h clock.
- **Accent colour:** Volt red by default, with a free colour picker. Regen green and the battery bands stay fixed, because their meaning matters.
- **Plate opacity** behind widgets (0–70 %), and **scale** (75–150 %).
- **Safe-area margins:** default 5 % (title-safe) for 16:9 and 9:16. The comp size is chosen per export (1920×1080, 3840×2160, 1080×1920, 2160×3840) and all positions are relative to it.
- **Speed source** (GoPro GPS / scooter) and **scooter lag** (auto / off).
