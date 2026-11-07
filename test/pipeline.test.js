'use strict';
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../core/pipeline');
const { syncRide } = require('../core/sync/sync');
const { makeRide } = require('../tools/fixtures/synth');

test('findChapters collects sibling chapters of the same recording in order', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ch-'));
  for (const n of ['GS020042.360', 'GS010042.360', 'GS010043.360', 'GS030042.360', 'GS020042.MP4']) fs.writeFileSync(path.join(d, n), '');
  assert.deepStrictEqual(P.findChapters(path.join(d, 'GS020042.360')).map((f) => path.basename(f)), ['GS010042.360', 'GS020042.360', 'GS030042.360']);
  assert.deepStrictEqual(P.expandVideos([path.join(d, 'GS010043.360')]).map((f) => path.basename(f)), ['GS010043.360']);
});

test('nudge = pure shift; strip and timeline follow; spec builds', () => {
  const r = makeRide({ durationS: 240, rideS: 200, videoAtStartS: 12, seed: 3 });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pl-'));
  for (const k in r.files) fs.writeFileSync(path.join(d, k), r.files[k]);
  const ride = { videos: ['GS019999.360'], gopro: r.gopro, volt: require('../core/parse/volt').loadVolt(d) };
  const { sync, strip } = P.runSync(ride);
  assert.ok(strip.speed && strip.speed.volt.t.length > 50 && strip.speed.gopro);
  assert.ok(strip.imu && strip.imu.t.length === strip.imu.a.length && strip.imu.t1 - strip.imu.t0 <= 20.01);
  const n = P.applyNudge(sync, 250);
  const ref = syncRide(r.gopro, ride.volt, { nudgeMs: 250 });
  assert.ok(Math.abs(n.rideStartVideoS - ref.rideStartVideoS) < 1e-9);
  assert.ok(Math.abs(n.videoAtRefS - ref.videoAtRefS) < 1e-9);
  const back = P.applyNudge(n, 0);
  assert.ok(Math.abs(back.rideStartVideoS - sync.rideStartVideoS) < 1e-9);
  const tl = P.makeTimeline(ride, n, { tz: 'UTC' });
  assert.strictEqual(tl.sync.nudge_ms, 250);
  assert.strictEqual(tl.samples, 2400);
  const sp = P.buildHudSpec(tl, { preset: 'corner' });
  assert.strictEqual(sp.comp.frames, Math.round(240 * 29.97));
});

test('a picked Volt file brings the other exports of the same ride', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-vf-'));
  for (const n of ['ride-aaa-combined.json', 'ride-aaa-sensors.csv', 'ride-aaa-motion.csv', 'ride-bbb-sensors.csv', 'notes.txt']) fs.writeFileSync(path.join(d, n), '');
  const r = P.expandVolt([path.join(d, 'ride-aaa-combined.json')]);
  assert.strictEqual(r.rideId, 'ride-aaa');
  assert.deepStrictEqual(r.inputs.map((f) => path.basename(f)), ['ride-aaa-combined.json', 'ride-aaa-motion.csv', 'ride-aaa-sensors.csv']);
  assert.deepStrictEqual(P.expandVolt([d]).inputs, [d]);
  assert.deepStrictEqual(P.expandVolt([path.join(d, 'notes.txt')]).inputs, []);
});
