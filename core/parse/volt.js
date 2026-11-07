'use strict';
// Volt ride export reader: combined.json, analysis.json, sensors.csv, phone.csv,
// motion.csv, route.csv. All times stay on the phone's monotonic clock (ms);
// clock fits map them to UTC. See docs/volt-data-formats.md.

const fs = require('fs');
const path = require('path');
const { parseCsvObjects, num } = require('../util/csv');
const { theilSen } = require('../util/signal');

const KINDS = [
  ['combined', /-combined\.json$/i],
  ['analysis', /-analysis\.json$/i],
  ['sensors', /-sensors\.csv$/i],
  ['phone', /-phone\.csv$/i],
  ['motion', /-motion\.csv$/i],
  ['route', /-route\.csv$/i],
];

// Accepts a directory or a list of files; returns {kind: path}. With several
// rides in one directory, the first ride id (sorted) wins unless rideId is given.
function findVoltFiles(inputs, rideId) {
  const list = [];
  for (const p of [].concat(inputs)) {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) list.push(path.join(p, f));
    else list.push(p);
  }
  const found = {};
  const ids = new Set();
  for (const f of list) {
    for (const [kind, re] of KINDS) {
      if (!re.test(f)) continue;
      const id = path.basename(f).replace(re, '');
      if (rideId && id !== rideId) continue;
      ids.add(id);
      if (!found[kind]) found[kind] = f;
    }
  }
  if (ids.size > 1 && !rideId) {
    const first = Array.from(ids).sort()[0];
    return findVoltFiles(inputs, first);
  }
  return found;
}

const DIRECTIONS = ['POSITIVE_IS_DRAW', 'NEGATIVE_IS_DRAW', 'UNCONFIRMED'];

// Scooter sensor journal (long form). Only committed frames count.
function parseSensors(text) {
  const { rows } = parseCsvObjects(text);
  const series = {}; // key -> {t:[], v:[], cmd:[], unit}
  const events = [];
  const directions = [];
  let start = null, stop = null;
  let pending = [];
  let inFrame = false;
  let frames = 0;
  const lastUpd = {};
  const commit = () => {
    for (const r of pending) {
      const key = r.key;
      const v = num(r.numeric);
      const tu = num(r.sensor_updated_monotonic_ms);
      if (!Number.isFinite(v) || !Number.isFinite(tu) || tu < 0) continue;
      if (lastUpd[key] === tu) continue; // repeated snapshot of the same report
      lastUpd[key] = tu;
      const s = series[key] || (series[key] = { t: [], v: [], cmd: [], unit: r.unit || '' });
      s.t.push(tu); s.v.push(v); s.cmd.push(r.source_command);
    }
    pending = [];
    frames++;
  };
  for (const r of rows) {
    const ev = r.event;
    if (ev === 'BEGIN') { inFrame = true; pending = []; continue; }
    if (ev === 'SENSOR') { if (inFrame) pending.push(r); continue; }
    if (ev === 'COMMIT') { if (inFrame) commit(); inFrame = false; continue; }
    const mono = num(r.monotonic_ms), wall = num(r.wall_ms);
    if (ev === 'START') {
      start = { mono, wall, profileId: r.key, label: r.text, direction: r.current_direction || 'UNCONFIRMED' };
      directions.push([mono, start.direction]);
    } else if (ev === 'STOP') {
      stop = { mono, wall, reason: r.details };
    } else if (ev === 'DIRECTION') {
      const d = DIRECTIONS.indexOf(r.current_direction) >= 0 ? r.current_direction : (DIRECTIONS.indexOf(r.text) >= 0 ? r.text : 'UNCONFIRMED');
      directions.push([mono, d]);
    }
    if (ev !== 'START') events.push({ type: ev, mono, wall, detail: r.details || r.text || '' });
  }
  for (const k in series) sortSeries(series[k]);
  return { series, events, directions, start, stop, frames };
}

function sortSeries(s) {
  const idx = s.t.map((_, i) => i).sort((a, b) => s.t[a] - s.t[b]);
  for (const f of ['t', 'v', 'cmd']) if (s[f]) s[f] = idx.map((i) => s[f][i]);
}

// Power the way the ride graphs do it: voltage_v x current_a from the same
// report (equal update time and source command). Sign follows the ride's
// current direction: +1 = draw, -1 = regen, 0 = unconfirmed (magnitude only).
function powerSeries(series, directions) {
  const V = series.voltage_v, A = series.current_a;
  const out = { t: [], rawW: [], w: [], dir: [], directionAt: [] };
  if (!V || !A) return out;
  const vByT = new Map();
  for (let i = 0; i < V.t.length; i++) vByT.set(V.t[i] + '|' + V.cmd[i], V.v[i]);
  for (let i = 0; i < A.t.length; i++) {
    const v = vByT.get(A.t[i] + '|' + A.cmd[i]);
    if (v === undefined) continue;
    const raw = v * A.v[i];
    const d = directionAt(directions, A.t[i]);
    let w, dir;
    if (d === 'POSITIVE_IS_DRAW') { w = raw; dir = raw >= 0 ? 1 : -1; }
    else if (d === 'NEGATIVE_IS_DRAW') { w = -raw; dir = raw <= 0 ? 1 : -1; }
    else { w = Math.abs(raw); dir = 0; }
    out.t.push(A.t[i]); out.rawW.push(raw); out.w.push(w); out.dir.push(dir); out.directionAt.push(d);
  }
  return out;
}

function directionAt(directions, mono) {
  let d = directions.length ? directions[0][1] : 'UNCONFIRMED';
  for (const [t, v] of directions) if (t <= mono) d = v;
  return d;
}

function parsePhone(text) {
  const { rows } = parseCsvObjects(text);
  const gps = { t: [], utc: [], lat: [], lon: [], acc: [], speed: [], speedAcc: [], alt: [], vAcc: [] };
  const pressure = { t: [], hPa: [] };
  const telemetry = { t: [], speedKmh: [], powerW: [], batteryPct: [] };
  const wallPairs = { mono: [], wall: [] };
  const events = [];
  for (const r of rows) {
    const mono = num(r.monotonic_ms), wall = num(r.wall_ms);
    switch (r.event) {
      case 'GPS':
        gps.t.push(mono); gps.utc.push(wall); gps.lat.push(num(r.a)); gps.lon.push(num(r.b));
        gps.acc.push(num(r.c)); gps.speed.push(num(r.d)); gps.speedAcc.push(num(r.e));
        gps.alt.push(num(r.f)); gps.vAcc.push(num(r.g));
        break;
      case 'PRESSURE': pressure.t.push(mono); pressure.hPa.push(num(r.a)); wallPairs.mono.push(mono); wallPairs.wall.push(wall); break;
      case 'TELEMETRY':
        telemetry.t.push(mono); telemetry.speedKmh.push(num(r.a)); telemetry.powerW.push(num(r.b)); telemetry.batteryPct.push(num(r.c));
        wallPairs.mono.push(mono); wallPairs.wall.push(wall);
        break;
      default:
        events.push({ type: r.event, mono, wall });
        if (Number.isFinite(mono) && Number.isFinite(wall)) { wallPairs.mono.push(mono); wallPairs.wall.push(wall); }
    }
  }
  return { gps, pressure, telemetry, wallPairs, events };
}

function parseMotion(text) {
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  const t = [], raw = [], lin = [], enu = [], quat = [];
  for (let i = 1; i < n; i++) {
    const L = lines[i];
    if (!L) continue;
    const a = L.split(',');
    const m = num(a[0]);
    if (!Number.isFinite(m)) continue;
    t.push(m);
    raw.push([num(a[1]), num(a[2]), num(a[3])]);
    lin.push([num(a[4]), num(a[5]), num(a[6])]);
    enu.push([num(a[7]), num(a[8]), num(a[9])]);
    quat.push([num(a[10]), num(a[11]), num(a[12]), num(a[13])]);
  }
  // Sensor timestamps are not guaranteed monotonic across sensors; sort.
  const idx = t.map((_, i) => i).sort((x, y) => t[x] - t[y]);
  return { t: idx.map((i) => t[i]), raw: idx.map((i) => raw[i]), linear: idx.map((i) => lin[i]), enu: idx.map((i) => enu[i]), quat: idx.map((i) => quat[i]) };
}

function parseRoute(text) {
  const { rows } = parseCsvObjects(text);
  const r = { t: [], utc: [], segment: [], lat: [], lon: [], acc: [], speed: [], alt: [], vAcc: [], relAlt: [], elevSrc: [], grade: [], powerW: [], batteryPct: [], scooterKmh: [] };
  for (const o of rows) {
    r.t.push(num(o.monotonic_ms)); r.utc.push(num(o.wall_ms)); r.segment.push(num(o.segment));
    r.lat.push(num(o.latitude)); r.lon.push(num(o.longitude)); r.acc.push(num(o.accuracy_m));
    r.speed.push(num(o.speed_mps)); r.alt.push(num(o.altitude_m)); r.vAcc.push(num(o.vertical_accuracy_m));
    r.relAlt.push(num(o.relative_altitude_m)); r.elevSrc.push(o.elevation_source || ''); r.grade.push(num(o.grade_percent));
    r.powerW.push(num(o.power_w)); r.batteryPct.push(num(o.battery_percent)); r.scooterKmh.push(num(o.scooter_speed_kmh));
  }
  return r;
}

// Track points of combined.json -> same shape as the route CSV.
function routeFromCombined(c) {
  const pts = (c && c.phone && c.phone.points) || [];
  const r = { t: [], utc: [], segment: [], lat: [], lon: [], acc: [], speed: [], alt: [], vAcc: [], relAlt: [], elevSrc: [], grade: [], powerW: [], batteryPct: [], scooterKmh: [] };
  const n = (v) => (v == null ? NaN : Number(v));
  for (const p of pts) {
    r.t.push(n(p.monoMs)); r.utc.push(n(p.wallMs)); r.segment.push(n(p.segment)); r.lat.push(n(p.latitude)); r.lon.push(n(p.longitude));
    r.acc.push(n(p.accuracyM)); r.speed.push(n(p.speedMps)); r.alt.push(n(p.altitudeM)); r.vAcc.push(n(p.verticalAccuracyM));
    r.relAlt.push(n(p.relativeAltitudeM)); r.elevSrc.push(''); r.grade.push(n(p.gradePercent)); r.powerW.push(n(p.powerW));
    r.batteryPct.push(n(p.batteryPercent)); r.scooterKmh.push(n(p.scooterSpeedKmh));
  }
  return r;
}

// Clock fit: utc_ms = slope*(mono - mono0) + utc0. GNSS fix rows give
// (fix UTC, fix mono) pairs; the journal rows give the phone wall clock.
function fitClock(gpsMono, gpsUtc, wallMono, wallMs) {
  const pick = (m, u) => {
    const x = [], y = [];
    for (let i = 0; i < m.length; i++) if (Number.isFinite(m[i]) && Number.isFinite(u[i]) && u[i] > 1e12) { x.push(m[i]); y.push(u[i]); }
    return [x, y];
  };
  const [gx, gy] = pick(gpsMono || [], gpsUtc || []);
  const [wx, wy] = pick(wallMono || [], wallMs || []);
  const g = gx.length >= 3 ? theilSen(gx, gy) : null;
  const w = wx.length >= 2 ? theilSen(wx, wy) : null;
  const best = g || w;
  if (!best) return null;
  const res = {
    source: g ? 'gnss' : 'wall',
    slope: best.slope,
    mono0: best.x0,
    utc0: best.y0,
    driftPpm: (best.slope - 1) * 1e6,
    rmsMs: best.rms,
    n: best.n,
  };
  if (g && w) {
    // phone wall clock minus GNSS UTC at the fit origin
    res.wallMinusGnssMs = w.slope * (g.x0 - w.x0) + w.y0 - g.y0;
  }
  return res;
}

function monoToUtc(fit, mono) { return fit.utc0 + fit.slope * (mono - fit.mono0); }
function utcToMono(fit, utc) { return fit.mono0 + (utc - fit.utc0) / fit.slope; }

function loadVolt(inputs, opts) {
  const files = findVoltFiles(inputs, opts && opts.rideId);
  const read = (k) => (files[k] ? fs.readFileSync(files[k], 'utf8') : null);
  const out = { files: Object.keys(files).reduce((o, k) => { o[k] = path.basename(files[k]); return o; }, {}) };
  const combinedText = read('combined');
  const combined = combinedText ? JSON.parse(combinedText) : null;
  const analysisText = read('analysis');
  out.summary = analysisText ? JSON.parse(analysisText) : (combined && combined.scooter) || null;
  const s = read('sensors');
  if (s) {
    const sens = parseSensors(s);
    out.scooter = { series: sens.series, events: sens.events, directions: sens.directions, frames: sens.frames };
    out.start = sens.start; out.stop = sens.stop;
    out.power = powerSeries(sens.series, sens.directions);
  }
  const p = read('phone');
  if (p) out.phone = parsePhone(p);
  const m = read('motion');
  if (m) out.motion = parseMotion(m);
  const r = read('route');
  out.route = r ? parseRoute(r) : combined ? routeFromCombined(combined) : null;
  if (!out.start && out.summary) {
    const dir = out.summary.currentDirection || 'UNCONFIRMED';
    out.start = { mono: NaN, wall: out.summary.startWallMs, direction: dir };
  }

  // Clock: GNSS pairs from phone GPS rows (or route points), wall pairs from journals.
  const gpsM = out.phone ? out.phone.gps.t : out.route ? out.route.t : [];
  const gpsU = out.phone ? out.phone.gps.utc : out.route ? out.route.utc : [];
  const wm = [], ww = [];
  if (out.phone) { wm.push.apply(wm, out.phone.wallPairs.mono); ww.push.apply(ww, out.phone.wallPairs.wall); }
  if (out.start && Number.isFinite(out.start.mono)) { wm.push(out.start.mono); ww.push(out.start.wall); }
  if (out.stop) { wm.push(out.stop.mono); ww.push(out.stop.wall); }
  out.clock = fitClock(gpsM, gpsU, wm, ww);
  return out;
}

module.exports = {
  loadVolt, findVoltFiles, parseSensors, parsePhone, parseMotion, parseRoute, routeFromCombined,
  powerSeries, directionAt, fitClock, monoToUtc, utcToMono,
};
