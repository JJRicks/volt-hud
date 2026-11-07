'use strict';
// Node 17 smoke test for the core (CEP 12 ships Node 17.7): no node:test here.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../core');
const { makeRide, gpmfPayload, makeMp4 } = require('../tools/fixtures/synth');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volthud-smoke-'));
  const pay = [];
  for (let i = 0; i < 3; i++) pay.push(gpmfPayload({ accl: [[9.8, 0, 0], [9.8, 0, 0]], gps5: [[1, 2, 3, 4, 5]], gpsuMs: Date.UTC(2026, 10, 7) + i * 1001 }));
  const f = path.join(dir, 'GS010001.360');
  fs.writeFileSync(f, makeMp4(pay));
  const g = await core.gopro.loadGoPro([f]);
  assert.strictEqual(g.gpsTime.t.length, 3);

  const r = makeRide({ durationS: 200, rideS: 170, videoAtStartS: 10, seed: 5 });
  for (const k in r.files) fs.writeFileSync(path.join(dir, k), r.files[k]);
  const volt = core.volt.loadVolt(dir);
  const s = core.sync.syncRide(r.gopro, volt, {});
  assert.ok(Math.abs(s.rideStartVideoS - 10) < 0.05, 'sync ' + s.rideStartVideoS);
  const tl = core.timeline.buildTimeline(r.gopro, volt, s, {});
  assert.strictEqual(tl.samples, 2000);
  const html = core.report.buildReport(r.gopro, volt, s, tl);
  const ride = { videos: [f], gopro: r.gopro, volt };
  const strip = core.strip.syncStrip(r.gopro, volt, s);
  assert.ok(strip.imu && strip.speed);
  const spec = core.hud.buildHudSpec(core.pipeline.makeTimeline(ride, core.pipeline.applyNudge(s, 100), { tz: 'America/Boise' }), { preset: 'strip', units: 'imperial' });
  assert.ok(spec.widgets.length === 8 && spec.keyCount > 0);
  assert.ok(html.length > 1000);
  console.log('core smoke OK on Node ' + process.version + ': sync error ' + ((s.rideStartVideoS - 10) * 1000).toFixed(1) + ' ms, ' + s.method);
})().catch((e) => { console.error(e); process.exit(1); });
