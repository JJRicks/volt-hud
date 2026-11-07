'use strict';
// Volt ride export reader: the one-file Everything export (-everything.json,
// format "volt-ride-everything", Volt 1.12.0+), or the older separate files:
// combined.json, analysis.json, sensors.csv, phone.csv, motion.csv, route.csv.
// Both give the same internal structures. All times stay on the phone's
// monotonic clock (ms); clock fits map them to UTC. See docs/volt-data-formats.md.

const fs = require('fs');
const path = require('path');
const { parseCsvObjects, num } = require('../util/csv');
const { theilSen } = require('../util/signal');

const EVERYTHING_FORMAT = 'volt-ride-everything';
const EVERYTHING_VERSION = 1;

const KINDS = [
  ['everything', /-everything\.json$/i],
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
    let matched = false;
    for (const [kind, re] of KINDS) {
      if (!re.test(f)) continue;
      matched = true;
      const id = path.basename(f).replace(re, '');
      if (rideId && id !== rideId) continue;
      ids.add(id);
      if (!found[kind]) found[kind] = f;
    }
    // A renamed Everything file is still recognised by its format field.
    if (!matched && /\.json$/i.test(f) && sniffFormat(f) === EVERYTHING_FORMAT) {
      const id = path.basename(f).replace(/\.json$/i, '');
      if (rideId && id !== rideId) continue;
      ids.add(id);
      if (!found.everything) found.everything = f;
    }
  }
  if (ids.size > 1 && !rideId) {
    const first = Array.from(ids).sort()[0];
    return findVoltFiles(inputs, first);
  }
  return found;
}

// The "format" field of a JSON file, from its first 4 KB (Volt writes it first), or null.
function sniffFormat(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    const m = /^\s*\{\s*"format"\s*:\s*"([^"\\]{0,64})"/.exec(b.toString('utf8', 0, n));
    return m ? m[1] : null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

const DIRECTIONS = ['POSITIVE_IS_DRAW', 'NEGATIVE_IS_DRAW', 'UNCONFIRMED'];

// Accumulates scooter readings and journal events the same way for the CSV
// journal and the Everything file.
function scooterAcc() {
  return { series: {}, events: [], directions: [], start: null, stop: null, frames: 0, lastUpd: {} };
}
// One committed reading. Repeated snapshots of the same report (same update time) count once.
function scooterReading(acc, key, numeric, updated, cmd, unit) {
  const v = num(numeric);
  const tu = num(updated);
  if (!Number.isFinite(v) || !Number.isFinite(tu) || tu < 0) return;
  if (acc.lastUpd[key] === tu) return;
  acc.lastUpd[key] = tu;
  const s = acc.series[key] || (acc.series[key] = { t: [], v: [], cmd: [], unit: unit || '' });
  s.t.push(tu); s.v.push(v); s.cmd.push(cmd == null ? '' : String(cmd));
}
// One journal row outside a frame: {event, wall_ms, monotonic_ms, key, text, current_direction, details}.
function scooterEvent(acc, r) {
  const ev = r.event;
  const mono = num(r.monotonic_ms), wall = num(r.wall_ms);
  if (ev === 'START') {
    acc.start = { mono, wall, profileId: r.key == null ? null : r.key, label: r.text == null ? '' : r.text, direction: r.current_direction || 'UNCONFIRMED' };
    acc.directions.push([mono, acc.start.direction]);
  } else if (ev === 'STOP') {
    acc.stop = { mono, wall, reason: r.details == null ? '' : r.details };
  } else if (ev === 'DIRECTION') {
    const d = DIRECTIONS.indexOf(r.current_direction) >= 0 ? r.current_direction : (DIRECTIONS.indexOf(r.text) >= 0 ? r.text : 'UNCONFIRMED');
    acc.directions.push([mono, d]);
  }
  if (ev !== 'START') acc.events.push({ type: ev, mono, wall, detail: r.details || r.text || '' });
}
function scooterDone(acc) {
  for (const k in acc.series) sortSeries(acc.series[k]);
  return { series: acc.series, events: acc.events, directions: acc.directions, start: acc.start, stop: acc.stop, frames: acc.frames };
}

// Scooter sensor journal (long form). Only committed frames count.
function parseSensors(text) {
  const { rows } = parseCsvObjects(text);
  const acc = scooterAcc();
  let pending = [];
  let inFrame = false;
  const commit = () => {
    for (const r of pending) scooterReading(acc, r.key, r.numeric, r.sensor_updated_monotonic_ms, r.source_command, r.unit);
    pending = [];
    acc.frames++;
  };
  for (const r of rows) {
    const ev = r.event;
    if (ev === 'BEGIN') { inFrame = true; pending = []; continue; }
    if (ev === 'SENSOR') { if (inFrame) pending.push(r); continue; }
    if (ev === 'COMMIT') { if (inFrame) commit(); inFrame = false; continue; }
    scooterEvent(acc, r);
  }
  return scooterDone(acc);
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

function phoneAcc() {
  return {
    gps: { t: [], utc: [], lat: [], lon: [], acc: [], speed: [], speedAcc: [], alt: [], vAcc: [] },
    pressure: { t: [], hPa: [] },
    telemetry: { t: [], speedKmh: [], powerW: [], batteryPct: [] },
    wallPairs: { mono: [], wall: [] },
    events: [],
  };
}
// One phone journal row: its event, wall_ms and monotonic_ms columns (GPS: fix UTC and fix
// monotonic time) and the columns after them (a..j) in file order.
function phoneRow(p, event, wallV, monoV, a) {
  const mono = num(monoV), wall = num(wallV);
  const x = (i) => num(a[i]);
  switch (event) {
    case 'GPS':
      p.gps.t.push(mono); p.gps.utc.push(wall); p.gps.lat.push(x(0)); p.gps.lon.push(x(1));
      p.gps.acc.push(x(2)); p.gps.speed.push(x(3)); p.gps.speedAcc.push(x(4));
      p.gps.alt.push(x(5)); p.gps.vAcc.push(x(6));
      break;
    case 'PRESSURE': p.pressure.t.push(mono); p.pressure.hPa.push(x(0)); p.wallPairs.mono.push(mono); p.wallPairs.wall.push(wall); break;
    case 'TELEMETRY':
      p.telemetry.t.push(mono); p.telemetry.speedKmh.push(x(0)); p.telemetry.powerW.push(x(1)); p.telemetry.batteryPct.push(x(2));
      p.wallPairs.mono.push(mono); p.wallPairs.wall.push(wall);
      break;
    default:
      p.events.push({ type: event, mono, wall });
      if (Number.isFinite(mono) && Number.isFinite(wall)) { p.wallPairs.mono.push(mono); p.wallPairs.wall.push(wall); }
  }
}

function parsePhone(text) {
  const { rows } = parseCsvObjects(text);
  const p = phoneAcc();
  for (const r of rows) phoneRow(p, r.event, r.wall_ms, r.monotonic_ms, [r.a, r.b, r.c, r.d, r.e, r.f, r.g, r.h, r.i, r.j]);
  return p;
}

// Motion rows (arrays of 15 values in the motion file's column order) -> sorted series.
function motionFromRows(rows) {
  const t = [], raw = [], lin = [], enu = [], quat = [];
  for (const a of rows) {
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

function parseMotion(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) if (lines[i]) rows.push(lines[i].split(','));
  return motionFromRows(rows);
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

// ---------- Everything (JSON), Volt 1.12.0+ ----------
// docs/volt-data-formats.md section 7. A table is {columns: [...], rows: [[...], ...]}.

function table(t, what) {
  if (t == null) return null;
  if (typeof t !== 'object' || !Array.isArray(t.columns) || !Array.isArray(t.rows)) throw new Error('Everything file: ' + what + ' is not a table');
  const col = {};
  t.columns.forEach((c, i) => { col[c] = i; });
  return { col, rows: t.rows };
}
function need(tab, name, what) {
  if (!(name in tab.col)) throw new Error('Everything file: ' + what + ' has no "' + name + '" column');
  return tab.col[name];
}

// Checks format and formatVersion first, as the format asks; throws a message for the rider.
function checkEverything(doc, label) {
  const name = label || 'This file';
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.format !== EVERYTHING_FORMAT) {
    throw new Error(name + ' is not a Volt "Everything (JSON)" ride export (its format is ' + JSON.stringify(doc && typeof doc === 'object' ? doc.format : undefined) + ', expected "' + EVERYTHING_FORMAT + '").');
  }
  if (doc.formatVersion !== EVERYTHING_VERSION) {
    throw new Error(name + ' is a Volt "Everything" export of format version ' + JSON.stringify(doc.formatVersion) + '. This Volt HUD reads version ' + EVERYTHING_VERSION +
      ' only: update Volt HUD, or export the ride from Volt as separate files (Sensor CSV, Phone raw CSV, Motion raw CSV).');
  }
}

function everythingScooter(sc) {
  const acc = scooterAcc();
  const frames = table(sc.frames, 'scooter.frames');
  acc.frames = frames ? frames.rows.length : 0;
  const rd = sc.readings;
  if (rd && rd.keys) {
    const r = table({ columns: rd.columns, rows: [] }, 'scooter.readings');
    const cU = need(r, 'sensor_updated_monotonic_ms', 'scooter.readings'), cN = need(r, 'numeric', 'scooter.readings');
    const cC = need(r, 'source_command', 'scooter.readings'), cUnit = need(r, 'unit', 'scooter.readings');
    // Each row is one run of frames that repeated the reading; a run has one update time,
    // so taking each row once is what the CSV journal's per-frame dedupe gives.
    for (const key of Object.keys(rd.keys)) for (const row of rd.keys[key]) scooterReading(acc, key, row[cN], row[cU], row[cC], row[cUnit]);
  }
  const ev = table(sc.events, 'scooter.events');
  if (ev) {
    const c = {};
    for (const k of ['event', 'wall_ms', 'monotonic_ms', 'key', 'text', 'current_direction', 'details']) c[k] = need(ev, k, 'scooter.events');
    for (const row of ev.rows) {
      const r = {};
      for (const k in c) r[k] = row[c[k]];
      scooterEvent(acc, r);
    }
  }
  return scooterDone(acc);
}

function everythingPhone(journal) {
  const p = phoneAcc();
  const all = [];
  const evs = (journal && journal.events) || {};
  for (const event of Object.keys(evs)) {
    const tab = table(evs[event], 'phone.journal.events.' + event);
    need(tab, 'line', 'phone.journal.events.' + event);
    // Columns after "line" are the phone journal's own, in file order (GPS: fix UTC, fix monotonic, a..g).
    for (const row of tab.rows) all.push({ event, row });
  }
  // Back into file order: rows of all events interleave by line number.
  all.sort((x, y) => x.row[0] - y.row[0]);
  for (const { event, row } of all) phoneRow(p, event, row[1], row[2], row.slice(3));
  return p;
}

function readEverything(doc, fileName) {
  checkEverything(doc, fileName);
  const out = { files: { everything: fileName }, format: { name: doc.format, version: doc.formatVersion } };
  out.appVersion = doc.app && doc.app.version != null ? doc.app.version : null;
  out.timeZone = doc.timeZone && typeof doc.timeZone.recorded === 'string' ? doc.timeZone.recorded : null;
  out.withheldKeys = (doc.privacy && doc.privacy.withheldKeys) || [];
  const sc = doc.scooter;
  out.summary = (sc && sc.summary) || null;
  if (sc && sc.frames && sc.readings) {
    const sens = everythingScooter(sc);
    out.scooter = { series: sens.series, events: sens.events, directions: sens.directions, frames: sens.frames };
    out.start = sens.start; out.stop = sens.stop;
    out.power = powerSeries(sens.series, sens.directions);
  }
  const ph = doc.phone;
  if (ph && ph.journal) out.phone = everythingPhone(ph.journal);
  if (ph && ph.motion) out.motion = motionFromRows(table(ph.motion, 'phone.motion').rows);
  out.route = ph && ph.track ? routeFromCombined({ phone: ph.track }) : null;
  return finish(out);
}

function loadEverything(file) {
  const name = path.basename(file);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(name + ' could not be read as JSON: ' + e.message); }
  return readEverything(doc, name);
}

// ---------- loading ----------

// Accepts a directory or a list of files. An Everything file is the whole ride and is
// used on its own; otherwise the separate exports are combined.
function loadVolt(inputs, opts) {
  const files = findVoltFiles(inputs, opts && opts.rideId);
  if (files.everything) return loadEverything(files.everything);
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
  return finish(out);
}

// Shared tail: a start from the analysis when there is no journal, and the clock fit.
function finish(out) {
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
  loadVolt, loadEverything, readEverything, checkEverything, sniffFormat, findVoltFiles, parseSensors, parsePhone, parseMotion, parseRoute, routeFromCombined,
  powerSeries, directionAt, fitClock, monoToUtc, utcToMono, EVERYTHING_FORMAT, EVERYTHING_VERSION,
};
