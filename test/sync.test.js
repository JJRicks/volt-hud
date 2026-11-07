'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRide } = require('../tools/fixtures/synth');
const { loadVolt } = require('../core/parse/volt');
const Y = require('../core/sync/sync');
const S = require('../core/util/signal');
const { audioLag } = require('../core/check-mp4');

function ride(opts) {
  const r = makeRide(opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volthud-ride-'));
  for (const f in r.files) fs.writeFileSync(path.join(dir, f), r.files[f]);
  r.volt = loadVolt(dir);
  return r;
}

const R = ride({ durationS: 700, rideS: 640, videoAtStartS: 25, driftPpm: 40, goproGpsLatencyMs: 1300 });

test('Volt clock fit from GNSS rows; wall clock offset', () => {
  const c = R.volt.clock;
  assert.strictEqual(c.source, 'gnss');
  assert.ok(Math.abs(c.slope - 1) < 1e-9);
  assert.ok(Math.abs(c.wallMinusGnssMs - 1264) < 2);
});

test('coarse map is off by the GoPro GPS latency; speed xcorr recovers it within 100 ms', () => {
  const s = Y.syncRide(R.gopro, R.volt, { imu: false });
  const truth = R.truth.videoAtStartS;
  assert.ok(Math.abs(s.coarse.rideStartVideoS - (truth - 1.3)) < 0.05, 'coarse ' + s.coarse.rideStartVideoS);
  assert.ok(s.method.indexOf('speed') > 0, s.method);
  assert.ok(Math.abs(s.rideStartVideoS - truth) < 0.1, 'speed-only ' + s.rideStartVideoS);
  assert.ok(s.speed.psr > 3 && s.speed.second && s.speed.second.peak < s.speed.peak);
  // drift comes from the GNSS fits
  assert.ok(Math.abs(s.d1_ppm - 40) < 5, 'drift ' + s.d1_ppm);
  // scooter lag (500 ms) is visible against phone GPS speed
  assert.ok(Math.abs(s.stats.scooterLag.lagMs - 500) < 150, 'lag ' + s.stats.scooterLag.lagMs);
});

test('IMU fine sync recovers the offset within 10 ms', () => {
  const s = Y.syncRide(R.gopro, R.volt, {});
  assert.ok(s.method.indexOf('imu') > 0, s.method);
  const err = Math.abs(s.rideStartVideoS - R.truth.videoAtStartS);
  assert.ok(err < 0.010, 'IMU error ' + (err * 1000).toFixed(1) + ' ms');
  // the end of the ride is right too (drift)
  const endMono = R.volt.stop.mono;
  const errEnd = Math.abs(Y.monoToVideo(Y.modelOf(s), endMono) - R.truth.videoOfMono(endMono));
  assert.ok(errEnd < 0.010, 'end error ' + (errEnd * 1000).toFixed(1) + ' ms');
  assert.strictEqual(s.confidence, 'high');
  assert.ok(s.imu.fit.residualMs < 20);
});

test('IMU windows fit a drift the coarse map does not know about (within 5 ppm)', () => {
  const truthModel = { monoRefMs: R.volt.start.mono, videoAtRefS: R.truth.videoAtStartS, slope: 1 + 40e-6 };
  // wrong by +0.4 s and by -40 ppm (i.e. no drift)
  const wrong = Y.makeModel(R.volt.start.mono, R.truth.videoAtStartS + 0.4, 1);
  const r = Y.imuSync(R.gopro, R.volt, wrong, { searchS: 1.5, fineS: 1, rate: 50 });
  assert.ok(r.ok && !r.fit.constant, JSON.stringify(r.fit));
  const fixed = Y.shiftModel(wrong, r.fit.deltaAtRefS, r.fit.driftPerS, r.fit.tRefS);
  assert.ok(Math.abs((fixed.slope - truthModel.slope) * 1e6) < 5, 'drift error ' + ((fixed.slope - truthModel.slope) * 1e6).toFixed(2) + ' ppm');
  const err = Math.abs(Y.monoToVideo(fixed, R.volt.start.mono) - R.truth.videoAtStartS);
  assert.ok(err < 0.010, 'offset error ' + err);
});

test('no GoPro GPS fix: falls back to GPSU time + IMU', () => {
  const r = ride({ durationS: 400, rideS: 360, videoAtStartS: 12, driftPpm: 0, goproGpsLatencyMs: 1800, withGoproFix: false, seed: 11 });
  const s = Y.syncRide(r.gopro, r.volt, {});
  assert.ok(s.notes.some((n) => /no GoPro GPS speed/.test(n)));
  assert.ok(Math.abs(s.rideStartVideoS - 12) < 0.010, 'error ' + (s.rideStartVideoS - 12));
  assert.ok(Math.abs(s.correctionFromCoarseMs - 1800) < 15);
});

test('nccScan / peakInfo: integer and fractional lag, second peak', () => {
  const n = 2000;
  const a = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i / 7) * Math.exp(-((i - 900) * (i - 900)) / 2e5) + 0.3 * Math.sin(i / 2.3);
  for (let i = 0; i < n; i++) { const x = i - 12.4; const j = Math.floor(x), f = x - j; b[i] = j >= 0 && j + 1 < n ? a[j] * (1 - f) + a[j + 1] * f : NaN; }
  const p = S.peakInfo(S.nccScan(a, b, -40, 40, 50), 3);
  assert.ok(Math.abs(p.lag - 12.4) < 0.1, 'lag ' + p.lag);
  assert.ok(p.second && p.second.peak < p.peak);
});

test('audioLag finds a known audio offset', () => {
  const n = 8000 * 4;
  const a = new Float64Array(n);
  let s = 1;
  for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; a[i] = (s / 2147483647 - 0.5) * (i % 4000 < 800 ? 1 : 0.1); }
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = i >= 267 ? a[i - 267] : 0; // b is 33.4 ms late
  const r = audioLag(a, b, 0.5);
  assert.ok(Math.abs(r.lagS - 267 / 8000) < 0.0005, 'lag ' + r.lagS);
});
