'use strict';
// Build the normalized ride.volthud.json timeline: exactly as long as the .360
// (all chapters), t = i/rateHz from its first frame. Missing data = null, and
// every channel lists its null ranges in `gaps` (owner decision, Nov 6).

const S = require('./util/signal');
const D = require('./derive/derive');
const { modelOf, videoToMono } = require('./sync/sync');
const { monoToUtc } = require('./parse/volt');

function nullRuns(arr, rate) {
  const runs = [];
  let s = -1;
  for (let i = 0; i <= arr.length; i++) {
    const isNull = i < arr.length && (arr[i] === null || (typeof arr[i] === 'number' && !Number.isFinite(arr[i])));
    if (isNull && s < 0) s = i;
    if (!isNull && s >= 0) { runs.push([round3(s / rate), round3(i / rate)]); s = -1; }
  }
  return runs;
}
function round3(x) { return Math.round(x * 1000) / 1000; }

function buildTimeline(gopro, volt, sync, opts) {
  opts = opts || {};
  const rate = opts.rateHz || 10;
  const dur = gopro.durationS;
  const n = Math.max(1, Math.round(dur * rate));
  const model = modelOf(sync);
  const videoGrid = new Float64Array(n);
  const monoGrid = new Float64Array(n);
  for (let i = 0; i < n; i++) { videoGrid[i] = i / rate; monoGrid[i] = videoToMono(model, i / rate); }

  // Volt coverage: ride START..STOP (from the journal), else data extent.
  const startMono = volt.start && Number.isFinite(volt.start.mono) ? volt.start.mono : null;
  const stopMono = volt.stop && Number.isFinite(volt.stop.mono) ? volt.stop.mono : null;
  const inRide = (m) => (startMono == null || m >= startMono) && (stopMono == null || m <= stopMono);

  const sp = D.fusedSpeed(volt, monoGrid, gopro.gps, videoGrid);
  // the GoPro covers the whole clip; Volt only the ride
  for (let i = 0; i < n; i++) if (sp.src[i] && sp.src[i] !== 'gopro-gps' && !inRide(monoGrid[i])) { sp.mps[i] = NaN; sp.src[i] = null; }
  const pb = D.powerBattery(volt, monoGrid);
  const vt = D.vertical(volt, monoGrid, { altitudeSource: opts.altitudeSource });
  const gf = D.gForces(sp.mps, monoGrid, rate, volt.motion);
  const grade = new Float64Array(n);
  // grade only above 4 m/s (14 km/h): below that, baro noise / speed explodes
  const gradeSm = S.movingAverage(Array.from(vt.vert, (v, i) => (sp.mps[i] > 4 ? (100 * v) / sp.mps[i] : NaN)), Math.round(rate));
  for (let i = 0; i < n; i++) grade[i] = sp.mps[i] > 4 ? gradeSm[i] : NaN;

  const mask = (a) => { const o = Float64Array.from(a); for (let i = 0; i < n; i++) if (!inRide(monoGrid[i])) o[i] = NaN; return o; };
  const channels = {
    speedKmh: S.round(Array.from(sp.mps, (x) => x * 3.6), 2),
    speedSrc: sp.src,
    powerW: S.round(mask(pb.w), 1),
    powerDir: pb.dir.map((d, i) => (inRide(monoGrid[i]) ? d : null)),
    batteryPct: S.round(mask(pb.bat), 1),
    altM: S.round(mask(vt.alt), 2),
    vertMps: S.round(mask(vt.vert), 3),
    gradePct: S.round(mask(grade), 1),
    gLon: S.round(mask(gf.lon), 3),
    gLat: S.round(mask(gf.lat), 3),
    gTotal: S.round(mask(gf.tot), 3),
    jerk: S.round(mask(gf.jerk), 2),
    utcMs: Array.from(monoGrid, (m) => (volt.clock ? Math.round(monoToUtc(volt.clock, m)) : null)),
  };
  if (opts.coords) {
    const r = volt.route;
    channels.lat = r ? S.round(mask(S.interpAt(r.t, r.lat, monoGrid, 2500)), 6) : [];
    channels.lon = r ? S.round(mask(S.interpAt(r.t, r.lon, monoGrid, 2500)), 6) : [];
  }
  const units = {
    speedKmh: 'km/h', speedSrc: 'scooter|gopro-gps|phone-gps|null', powerW: 'W (+ draw, - regen; magnitude when powerDir=0)', powerDir: '1 draw, -1 regen, 0 unconfirmed',
    batteryPct: '%', altM: 'm (relative, ' + (vt.source || 'none') + ')', vertMps: 'm/s', gradePct: '%', gLon: 'g (+ accelerating)', gLat: 'g (+ to the left)', gTotal: 'g',
    jerk: 'm/s^3', utcMs: 'Unix ms UTC', lat: 'deg', lon: 'deg',
  };
  const gaps = {};
  for (const k in channels) if (k !== 'utcMs') gaps[k] = nullRuns(channels[k], rate);
  const rideRange = [startMono, stopMono].map((m) => (m == null ? null : round3(sync.videoAtRefS + (sync.slope * (m - sync.monoRefMs)) / 1000)));

  // Stats from the timeline itself
  let km = 0, maxKmh = 0, moving = 0, movSum = 0, whDraw = 0, whRegen = 0, maxW = 0, minW = 0, asc = 0, desc = 0;
  for (let i = 0; i < n; i++) {
    const v = channels.speedKmh[i];
    if (v != null && inRide(monoGrid[i])) { km += v / 3.6 / rate / 1000; if (v > maxKmh) maxKmh = v; if (v > 3) { moving++; movSum += v; } }
    const w = channels.powerW[i];
    if (w != null && channels.powerDir[i] !== 0) { if (w > 0) whDraw += w / rate / 3600; else whRegen -= w / rate / 3600; if (w > maxW) maxW = w; if (w < minW) minW = w; }
    if (i > 0 && channels.altM[i] != null && channels.altM[i - 1] != null) { const d = channels.altM[i] - channels.altM[i - 1]; if (d > 0) asc += d; else desc -= d; }
  }
  const bats = channels.batteryPct.filter((x) => x != null);
  const srcCount = {};
  sp.src.forEach((s) => { srcCount[s || 'none'] = (srcCount[s || 'none'] || 0) + 1; });

  return {
    format: 'volthud-timeline',
    version: 1,
    video: { files: gopro.chapters.map((c) => c.file), chapters: gopro.chapters.map((c) => ({ file: c.file, startS: c.offsetS, durationS: c.durationS })), fps: gopro.fps, durationS: dur, device: gopro.device, startUtc: volt.clock && sync ? new Date(Math.round(monoToUtc(volt.clock, videoToMono(model, 0)))).toISOString() : null },
    sync: syncForTimeline(sync),
    // The clock zone: explicit (--tz) first, then the ride's recorded zone (Everything export).
    // null = none known here; the HUD spec then uses this Mac's zone.
    tz: opts.tz || volt.timeZone || null,
    tzSource: opts.tz ? 'explicit' : volt.timeZone ? 'ride' : null,
    rateHz: rate,
    samples: n,
    nullMeans: 'no data at this sample: draw the grey "[no data]" state',
    ride: { videoStartS: rideRange[0], videoEndS: rideRange[1], direction: volt.start ? volt.start.direction : null, files: volt.files },
    units,
    channels,
    gaps,
    stats: {
      tripKm: round3(km), maxKmh: Math.round(maxKmh * 10) / 10, avgMovingKmh: moving ? Math.round((movSum / moving) * 10) / 10 : null,
      maxPowerW: Math.round(maxW), minPowerW: Math.round(minW), drawWh: Math.round(whDraw * 10) / 10, regenWh: Math.round(whRegen * 10) / 10,
      batteryStartPct: bats.length ? bats[0] : null, batteryEndPct: bats.length ? bats[bats.length - 1] : null,
      ascentM: Math.round(asc * 10) / 10, descentM: Math.round(desc * 10) / 10, altitudeSource: vt.source, altitudeRoughness: vt.roughness, speedSourceSamples: srcCount,
    },
    style: opts.style || { preset: 'focus', units: 'metric', accent: '#E32B2F', coords: !!opts.coords, safe: 0.05, comp: [1920, 1080] },
  };
}

function syncForTimeline(s) {
  const o = {};
  for (const k of ['model', 'monoRefMs', 'videoAtRefS', 'slope', 'd0_ms', 'd1_ppm', 'method', 'confidence', 'score', 'decidedBy', 'nudge_ms', 'rideStartVideoS', 'correctionFromCoarseMs', 'notes', 'peak']) o[k] = s[k];
  o.coarse = s.coarse;
  o.stats = Object.assign({}, s.stats, {
    speed_psr: s.speed ? s.speed.psr : null,
    imu_windows_used: s.imu && s.imu.fit ? s.imu.fit.windowsUsed : 0,
    imu_residual_ms: s.imu && s.imu.fit ? s.imu.fit.residualMs : null,
    scooter_lag_ms: s.stats.scooterLag ? s.stats.scooterLag.lagMs : null,
  });
  return o;
}

module.exports = { buildTimeline, nullRuns };
