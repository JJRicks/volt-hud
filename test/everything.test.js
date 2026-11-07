'use strict';
// The one-file Everything export (Volt 1.12.0+) against the older separate files of the same
// ride. The fixture in test/fixtures/everything/ is synthetic: Volt's own exporter wrote both
// sets from one synthetic ride (tools/fixtures/HudFixture.java, built like Volt's
// RideExportEverythingTest). No owner data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../core/parse/volt');
const P = require('../core/pipeline');
const { syncRide } = require('../core/sync/sync');
const { buildTimeline } = require('../core/timeline');
const H = require('../core/hud/spec');

const DIR = path.join(__dirname, 'fixtures', 'everything');
const names = fs.readdirSync(DIR);
const EVERYTHING = path.join(DIR, names.find((n) => /-everything\.json$/.test(n)));
const RIDE = path.basename(EVERYTHING).replace(/-everything\.json$/, '');
const OLD = names.filter((n) => n.startsWith(RIDE + '-') && !/-everything\.json$/.test(n)).map((n) => path.join(DIR, n));

// Deep compare within float tolerance; returns the differing paths.
function diff(a, b, at, out, skip) {
  out = out || []; at = at || '';
  if (skip && skip(at)) return out;
  const isNum = (x) => typeof x === 'number' || x instanceof Float64Array;
  if (typeof a === 'number' && typeof b === 'number') {
    if (!(Number.isNaN(a) && Number.isNaN(b)) && !(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))) out.push(at + ': ' + a + ' vs ' + b);
    return out;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || isNum(a) !== isNum(b)) {
    if (a !== b) out.push(at + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    return out;
  }
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const k of keys) diff(a[k], b[k], at + '.' + k, out, skip);
  return out;
}

// What only one side has, by design: the file names, Everything's extra fields, Volt's scooter
// profile id (left out of Everything), and the route CSV's elevation_source column (not in the track JSON).
const EXPECTED = (p) => /^\.(files|format|appVersion|timeZone|withheldKeys)$/.test(p) || p === '.summary.scooterId' || p === '.start.profileId' || p === '.route.elevSrc';

// A GoPro made from the ride itself (GPS speed, GPS time, a vertical accelerometer), so sync runs end to end.
function goproFor(volt, videoAtStartS) {
  const sp = volt.scooter.series.speed_kmh;
  const m0 = volt.start.mono, dur = (volt.stop.mono - m0) / 1000 + videoAtStartS + 15;
  const at = (t, arr, vals) => { let i = 0; while (i < arr.length - 1 && arr[i + 1] <= t) i++; return vals[i]; };
  const n18 = Math.floor(dur * 18);
  const g = { t: new Float64Array(n18), lat: new Float64Array(n18), lon: new Float64Array(n18), alt: new Float64Array(n18), s2: new Float64Array(n18), s3: new Float64Array(n18), fix: new Float64Array(n18).fill(3), dop: new Float64Array(n18).fill(1.5), src: 'GPS5' };
  for (let i = 0; i < n18; i++) { const v = i / 18; g.t[i] = v; const m = m0 + (v - videoAtStartS) * 1000; g.s2[i] = m < m0 || m > volt.stop.mono ? 0 : at(m, sp.t, sp.v) / 3.6; g.s3[i] = g.s2[i]; }
  const gpsTime = { t: [], utc: [], fix: [], dop: [] };
  for (let v = 0; v < dur; v += 1.001) { gpsTime.t.push(v); gpsTime.utc.push(V.monoToUtc(volt.clock, m0 + (v - videoAtStartS) * 1000) + 1300); gpsTime.fix.push(3); gpsTime.dop.push(1.5); }
  const mt = volt.motion.t, mz = volt.motion.raw.map((r) => r[2]);
  const n200 = Math.floor(dur * 200);
  const accl = { t: new Float64Array(n200), x: new Float64Array(n200), y: new Float64Array(n200), z: new Float64Array(n200) };
  let j = 0;
  for (let i = 0; i < n200; i++) {
    const v = i / 200, m = m0 + (v - videoAtStartS) * 1000;
    while (j < mt.length - 1 && mt[j + 1] <= m) j++;
    accl.t[i] = v; accl.z[i] = m < mt[0] || m > mt[mt.length - 1] ? 9.81 : mz[j] / 0.8;
  }
  return { device: 'Synthetic', durationS: dur, fps: 29.97, chapters: [{ file: 'GS019999.360', offsetS: 0, durationS: dur, fps: 29.97, info: {}, streams: {}, gpsMeta: { fixHistogram: {} } }], gps: g, gpsTime, accl, grav: null, gyro: null };
}

test('fixture: an Everything file and the old files of the same synthetic ride', () => {
  assert.ok(OLD.length >= 6, 'old files: ' + OLD.map((f) => path.basename(f)));
  const doc = JSON.parse(fs.readFileSync(EVERYTHING, 'utf8'));
  assert.strictEqual(doc.format, 'volt-ride-everything');
  assert.strictEqual(doc.formatVersion, 1);
  assert.ok(!('gyro' in doc.phone.motion) && doc.phone.motion.columns.indexOf('gyro_x') < 0, 'the shipped export has no gyro');
});

test('Everything reads into the same internal structures as the old files', () => {
  const a = V.loadVolt(OLD), b = V.loadVolt(EVERYTHING);
  assert.deepStrictEqual(b.files, { everything: path.basename(EVERYTHING) });
  assert.deepStrictEqual(b.format, { name: 'volt-ride-everything', version: 1 });
  assert.strictEqual(b.timeZone, 'Europe/Lisbon');
  assert.deepStrictEqual(b.withheldKeys, ['scooter_serial']);
  assert.strictEqual(b.summary.scooterId, null);
  // non-trivial content on both sides
  assert.ok(b.scooter.series.speed_kmh.t.length > 50 && b.power.t.length > 50 && b.phone.gps.t.length > 50 && b.motion.t.length > 1000 && b.route.t.length > 50);
  assert.deepStrictEqual(b.scooter.events.map((e) => e.type), ['GAP', 'HEARTBEAT', 'DIRECTION', 'NOTE', 'STOP']);
  assert.deepStrictEqual(b.scooter.directions.map((d) => d[1]), ['POSITIVE_IS_DRAW', 'NEGATIVE_IS_DRAW']);
  assert.ok(b.power.dir.indexOf(-1) >= 0 && b.power.dir.indexOf(1) >= 0, 'draw and regen both present');
  assert.strictEqual(b.clock.source, 'gnss');
  assert.deepStrictEqual(diff(a, b, '', [], EXPECTED), []);
  assert.strictEqual(a.route.elevSrc.filter(Boolean).length, a.route.t.length, 'the route CSV names elevation sources; Everything leaves them empty');
});

test('the same ride syncs and builds the same timeline from either input', () => {
  const a = V.loadVolt(OLD), b = V.loadVolt(EVERYTHING);
  const gopro = goproFor(a, 7.5);
  const sa = syncRide(gopro, a, { nudgeMs: 0, imu: true }), sb = syncRide(gopro, b, { nudgeMs: 0, imu: true });
  assert.deepStrictEqual(diff(sa, sb), []);
  assert.ok(Math.abs(sa.rideStartVideoS - 7.5) < 1.5, 'sync finds the ride: ' + sa.rideStartVideoS);
  for (const opts of [{ rateHz: 10, coords: true, tz: 'UTC' }, { rateHz: 30 }]) {
    const ta = buildTimeline(gopro, a, sa, opts), tb = buildTimeline(gopro, b, sb, opts);
    // Only the clock zone may differ: the Everything file records one, the old files do not.
    assert.deepStrictEqual(diff(ta, tb, '', [], (p) => p === '.ride.files' || p === '.tz' || p === '.tzSource'), []);
    if (opts.tz) assert.ok(ta.tz === 'UTC' && tb.tz === 'UTC' && tb.tzSource === 'explicit');
    else assert.ok(ta.tz === null && ta.tzSource === null && tb.tz === 'Europe/Lisbon' && tb.tzSource === 'ride');
    assert.ok(ta.channels.speedKmh.filter((x) => x != null).length > 100 && ta.channels.powerW.filter((x) => x != null).length > 100);
  }
});

function tmpCopy(mutate, name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ev-'));
  const doc = JSON.parse(fs.readFileSync(EVERYTHING, 'utf8'));
  if (mutate) mutate(doc);
  const f = path.join(d, name || path.basename(EVERYTHING));
  fs.writeFileSync(f, JSON.stringify(doc));
  return { d, f };
}

test('an unknown formatVersion is refused with a clear message', () => {
  const { f } = tmpCopy((doc) => { doc.formatVersion = 2; });
  assert.throws(() => V.loadVolt(f), /format version 2\. This Volt HUD reads version 1 only/);
  assert.throws(() => V.readEverything({ format: 'volt-ride', formatVersion: 1 }, 'x.json'), /x\.json is not a Volt "Everything \(JSON\)" ride export/);
  assert.throws(() => V.readEverything({ format: 'volt-ride-everything', formatVersion: '1' }, 'x.json'), /format version "1"/);
});

test('detected by its format field: a renamed file, a folder, and a picked file', () => {
  const { d, f } = tmpCopy(null, 'my ride.json');
  const v = V.loadVolt(f);
  assert.deepStrictEqual(v.files, { everything: 'my ride.json' });
  assert.ok(v.scooter && v.phone && v.motion);
  assert.deepStrictEqual(V.loadVolt(d).files, { everything: 'my ride.json' });
  assert.strictEqual(V.sniffFormat(path.join(DIR, RIDE + '-combined.json')), null);
  // A folder with both: Everything wins (it is a superset).
  assert.deepStrictEqual(Object.keys(V.loadVolt(DIR).files), ['everything']);
  // Panel: a picked Everything file is the whole input; a picked old file still brings its siblings.
  assert.deepStrictEqual(P.expandVolt([f]).inputs, [f]);
  assert.deepStrictEqual(P.expandVolt([EVERYTHING, path.join(DIR, RIDE + '-sensors.csv')]).inputs, [EVERYTHING]);
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-old-'));
  for (const o of OLD) fs.copyFileSync(o, path.join(old, path.basename(o)));
  const picked = P.expandVolt([path.join(old, RIDE + '-combined.json')]);
  assert.strictEqual(picked.inputs.length, OLD.length);
  const info = P.describeVolt(V.loadVolt(P.expandVolt([f]).inputs));
  assert.deepStrictEqual(info.kinds, ['everything']);
  assert.deepStrictEqual(info.missing, []);
});

test('partial rides: scooter only, phone only, no motion', () => {
  const scooterOnly = V.loadVolt(tmpCopy((doc) => { doc.phone = null; }).f);
  assert.ok(scooterOnly.scooter && !scooterOnly.phone && !scooterOnly.motion && scooterOnly.route === null);
  assert.strictEqual(scooterOnly.clock.source, 'wall');
  const phoneOnly = V.loadVolt(tmpCopy((doc) => { doc.scooter = null; }).f);
  assert.ok(!phoneOnly.scooter && phoneOnly.phone.gps.t.length > 50 && phoneOnly.summary === null && phoneOnly.clock.source === 'gnss');
  const noMotion = V.loadVolt(tmpCopy((doc) => { doc.phone.motion = null; }).f);
  assert.ok(!noMotion.motion && noMotion.phone);
  assert.deepStrictEqual(P.describeVolt(noMotion).missing, ['motion samples (fine sync)']);
  // Unknown keys are ignored, as the format asks.
  const extra = V.loadVolt(tmpCopy((doc) => { doc.later = { x: 1 }; doc.phone.gyro = { columns: [], rows: [] }; }).f);
  assert.deepStrictEqual(diff(V.loadVolt(EVERYTHING), extra), []);
});

test('clock zone: the ride\'s recorded zone, an explicit override, the Mac for old exports', () => {
  const a = V.loadVolt(OLD), b = V.loadVolt(EVERYTHING);
  const gopro = goproFor(a, 7.5);
  const sync = syncRide(gopro, b, { nudgeMs: 0, imu: false });
  const mac = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t0 = b.clock.utc0;

  // Everything with a recorded zone: the HUD clock uses it.
  const tlRide = buildTimeline(gopro, b, sync, {});
  const sRide = H.buildHudSpec(tlRide, {});
  assert.strictEqual(sRide.clock.tz, 'Europe/Lisbon');
  assert.strictEqual(sRide.clock.tzSource, 'ride');
  assert.strictEqual(sRide.clock.tzOffsetMin, H.tzOffsetMin('Europe/Lisbon', t0));
  assert.strictEqual(P.clockZone({ volt: b }, {}).label, 'Clock: Europe/Lisbon (from the ride)');

  // An explicit zone wins: --tz on the timeline, or the style's zone at build time.
  const tlCli = buildTimeline(gopro, b, sync, { tz: 'Asia/Kolkata' });
  assert.deepStrictEqual([tlCli.tz, tlCli.tzSource], ['Asia/Kolkata', 'explicit']);
  const sCli = H.buildHudSpec(tlCli, {});
  assert.deepStrictEqual([sCli.clock.tz, sCli.clock.tzSource, sCli.clock.tzOffsetMin], ['Asia/Kolkata', 'explicit', 330]);
  const sStyle = H.buildHudSpec(tlRide, { tz: 'America/New_York' });
  assert.deepStrictEqual([sStyle.clock.tz, sStyle.clock.tzSource], ['America/New_York', 'explicit']);
  assert.strictEqual(P.clockZone({ volt: b }, { tz: 'Asia/Kolkata' }).label, 'Clock: Asia/Kolkata (set by you)');

  // An old export has no zone: this Mac's zone, as before.
  const tlOld = buildTimeline(gopro, a, sync, {});
  assert.deepStrictEqual([tlOld.tz, tlOld.tzSource], [null, null]);
  const sOld = H.buildHudSpec(tlOld, {});
  assert.deepStrictEqual([sOld.clock.tz, sOld.clock.tzSource], [mac, 'mac']);
  assert.strictEqual(P.clockZone({ volt: a }, {}).label, 'Clock: ' + mac + " (this Mac's zone; the export has no time zone)");

  // An unusable zone id is skipped; a timeline from before 0.1.2 (tz from --tz, no tzSource) still counts as explicit.
  assert.deepStrictEqual(H.resolveClockZone([null], 'Not/AZone'), { tz: mac, source: 'mac' });
  assert.deepStrictEqual(H.clockZoneOf({ tz: 'UTC' }), { tz: 'UTC', source: 'explicit' });
});
