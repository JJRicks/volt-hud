'use strict';
// The steps the After Effects panel runs, kept here so they are tested in Node:
// files -> load -> sync -> strip -> (nudge) -> timeline -> HUD spec.

const fs = require('fs');
const path = require('path');
const { loadGoPro, chapterKey, sortChapters } = require('./parse/gopro');
const { loadVolt } = require('./parse/volt');
const { syncRide } = require('./sync/sync');
const { syncStrip } = require('./sync/strip');
const { buildTimeline } = require('./timeline');
const { buildHudSpec } = require('./hud/spec');

// All chapters of the recording a picked file belongs to (GS01xxxx.360, GS02xxxx.360, ...).
function findChapters(file) {
  const dir = path.dirname(file), ext = path.extname(file).toLowerCase();
  const k = chapterKey(file);
  if (!k.chapter) return [file];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return [file]; }
  const same = names.filter((n) => path.extname(n).toLowerCase() === ext && chapterKey(n).file === k.file && chapterKey(n).chapter > 0).map((n) => path.join(dir, n));
  return sortChapters(same.length ? same : [file]).paths;
}
// Expand picked videos: each picked chapter brings its siblings; duplicates removed.
function expandVideos(files) {
  const all = [];
  for (const f of files) for (const c of findChapters(f)) if (all.indexOf(c) < 0) all.push(c);
  return sortChapters(all).paths;
}

// Volt files: a folder, the combined/"everything" JSON, or the separate CSVs.
function describeVolt(volt) {
  const f = volt.files || {};
  const have = Object.keys(f);
  return { files: f, scooter: !!volt.scooter, phoneGps: !!(volt.phone && volt.phone.gps && volt.phone.gps.t.length), motion: !!(volt.motion && volt.motion.t.length), route: !!volt.route, kinds: have };
}

async function loadRide(videoFiles, voltInputs) {
  const videos = expandVideos(videoFiles);
  const gopro = await loadGoPro(videos);
  const volt = loadVolt(voltInputs);
  return { videos, gopro, volt, voltInfo: describeVolt(volt) };
}

function runSync(ride, opts) {
  const sync = syncRide(ride.gopro, ride.volt, { nudgeMs: (opts && opts.nudgeMs) || 0, imu: !(opts && opts.noImu) });
  return { sync, strip: syncStrip(ride.gopro, ride.volt, sync) };
}

// Change the manual nudge without re-running the search: the nudge is a pure shift on video time.
function applyNudge(sync, nudgeMs) {
  const d = (nudgeMs - (sync.nudge_ms || 0)) / 1000;
  const s = Object.assign({}, sync);
  s.videoAtRefS = sync.videoAtRefS + d;
  s.rideStartVideoS = sync.rideStartVideoS + d;
  s.d0_ms = Math.round(s.rideStartVideoS * 1000 * 10) / 10;
  s.nudge_ms = nudgeMs;
  return s;
}

function makeTimeline(ride, sync, opts) {
  opts = opts || {};
  return buildTimeline(ride.gopro, ride.volt, sync, { rateHz: opts.rateHz || 10, coords: !!opts.coords, tz: opts.tz || null, style: opts.style });
}

function rideBase(ride) {
  return ride.volt.summary && ride.volt.summary.id ? 'ride-' + String(ride.volt.summary.id).slice(0, 8) : path.basename(ride.videos[0]).replace(/\.[^.]+$/, '');
}

// Private outputs (ride data): dirs 700, files 600.
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = { findChapters, expandVideos, loadRide, runSync, applyNudge, makeTimeline, rideBase, writePrivate, buildHudSpec, describeVolt };
