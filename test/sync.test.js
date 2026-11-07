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

// ---- no GoPro GPS time: whole-ride search, honest confidence, manual anchor ----
function noGpsRide(opts) {
  const r = ride(Object.assign({ withGoproFix: false, speedShocks: true, driftPpm: 20 }, opts));
  r.gopro.gpsTime = { t: [], utc: [], fix: [], dop: [] };
  r.gopro.chapters[0].info.creationTime = new Date(Date.UTC(2016, 0, 1)); // unset camera clock
  return r;
}
const LONG = noGpsRide({ durationS: 400, rideS: 900, videoAtStartS: -200, seed: 21 });

test('maskedNcc matches nccScan and ignores NaN', () => {
  const { maskedNcc } = require('../core/util/fft');
  const a = new Float64Array(400), b = new Float64Array(250);
  let s = 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 400; i++) a[i] = Math.sin(i / 5) + rnd();
  for (let i = 0; i < 250; i++) b[i] = a[i + 61] + 0.3 * rnd();
  a[100] = NaN; b[7] = NaN;
  const r = maskedNcc(a, b, 30), ref = S.nccScan(a, b, -399, 249, 30);
  let maxDiff = 0, best = -1;
  for (let k = 0; k < r.vals.length; k++) {
    const x = ref.vals[ref.lags.indexOf(-(r.d0 + k))], y = r.vals[k];
    assert.strictEqual(Number.isFinite(x), Number.isFinite(y));
    if (Number.isFinite(x)) maxDiff = Math.max(maxDiff, Math.abs(x - y));
    if (Number.isFinite(y) && r.n[k] >= 150 && (best < 0 || y > r.vals[best])) best = k;
  }
  assert.ok(maxDiff < 1e-9, 'diff ' + maxDiff);
  assert.strictEqual(r.d0 + best, 61); // b[j] = a[j + 61]: b sits 61 samples into a
});

test('an unset camera clock (2016) is distrusted', () => {
  const c = Y.cameraClock(LONG.gopro, LONG.volt, LONG.volt.start.mono);
  assert.strictEqual(c.ok, false);
  assert.ok(/2016-01-01/.test(c.reason));
  const ok = Y.cameraClock({ chapters: [{ info: { creationTime: new Date(Date.UTC(2026, 10, 7, 3)) } }] }, LONG.volt, LONG.volt.start.mono);
  assert.strictEqual(ok.ok, true); // hours off (local time labelled UTC) is still plausible
});

test('GoPro clock fit: bunched fixes and jumping GPSU stamps assume rate 1', () => {
  // three fixes within 2 s (an owner clip) used to give a -10,989 ppm slope
  const t = [371.4, 372.4, 373.4], base = Date.UTC(2026, 10, 7, 22, 16, 32);
  const f = Y.fitGoProClock({ t, utc: [base + 371400, base + 372411, base + 373389], fix: [3, 3, 3], dop: [1, 1, 1] });
  assert.strictEqual(f.slope, 1);
  assert.ok(Math.abs(f.intercept - base) < 20, 'intercept off by ' + (f.intercept - base));
  // GPSU without a fix: a third of the stamps jump by seconds (an owner clip: 145 of 488)
  const g = { t: [], utc: [], fix: [], dop: [] };
  for (let i = 0; i < 480; i++) { g.t.push(i); g.utc.push(base + i * 1000 + (i % 3 === 0 ? 4000 + 900 * (i % 7) : 0)); g.fix.push(0); g.dop.push(99); }
  const h = Y.fitGoProClock(g);
  assert.ok(Math.abs(h.driftPpm) < 200, 'drift ' + h.driftPpm);
  assert.ok(Math.abs(h.intercept - base) < 50, 'intercept off by ' + (h.intercept - base));
  assert.ok(h.dropped >= 150, 'dropped ' + h.dropped);
});

test('a set camera clock (local time labelled UTC) agrees; with the wrong ride it says so, low', () => {
  const r = noGpsRide({ durationS: 400, rideS: 600, videoAtStartS: -100, seed: 41 });
  const video0 = Date.UTC(2026, 10, 7, 0, 0, 0) - -100 * 1000; // synth utc0 is the ride start
  r.gopro.chapters[0].info.creationTime = new Date(video0 - 7 * 3600e3 + 40e3); // MST, 40 s off
  const s = Y.syncRide(r.gopro, r.volt, {});
  assert.ok(Math.abs(s.rideStartVideoS - -100) < 0.05, 'start ' + s.rideStartVideoS);
  assert.notStrictEqual(s.confidence, 'low', s.notes.join(' / '));
  assert.ok(s.notes.some((n) => /camera clock agrees/.test(n)), s.notes.join(' / '));
  // a similar ride recorded 20 minutes later: whatever it finds, the clock disagreement makes it low
  const other = noGpsRide({ durationS: 400, rideS: 600, videoAtStartS: -100, seed: 41, utc0: Date.UTC(2026, 10, 7, 0, 20, 0) });
  const w = Y.syncRide(r.gopro, other.volt, {});
  assert.strictEqual(w.confidence, 'low');
  assert.ok(w.notes.some((n) => /camera clock disagrees/.test(n)), w.notes.join(' / '));
});

test('no GPS, ride longer than the clip (starts before, ends after): found within 50 ms', () => {
  const s = Y.syncRide(LONG.gopro, LONG.volt, {});
  assert.strictEqual(s.mode, 'search', s.method);
  assert.ok(Math.abs(s.rideStartVideoS - -200) < 0.05, 'start ' + s.rideStartVideoS);
  assert.ok(s.confidence === 'high' || s.confidence === 'medium', s.confidence + ' ' + s.notes.join(' / '));
  assert.ok(s.agreed.indexOf('bumps') >= 0 && s.agreed.indexOf('vibration') >= 0, s.agreed.join(','));
  assert.ok(s.notes.some((n) => /2016-01-01/.test(n)), s.notes.join(' / '));
  assert.ok(/GoPro had no GPS/.test(s.summary), s.summary);
});

test('no GPS, no camera clock, ride starts before the clip', () => {
  const r = noGpsRide({ durationS: 400, rideS: 500, videoAtStartS: -120, seed: 22 });
  r.gopro.chapters[0].info.creationTime = null;
  const s = Y.syncRide(r.gopro, r.volt, {});
  assert.ok(Math.abs(s.rideStartVideoS - -120) < 0.05, 'start ' + s.rideStartVideoS);
  assert.notStrictEqual(s.confidence, 'low', s.notes.join(' / '));
  assert.ok(s.search.minOverlapS === 60);
});

test('mismatched ride and clip: low, with a note', () => {
  const a = noGpsRide({ durationS: 400, rideS: 600, videoAtStartS: -100, seed: 31 });
  const b = noGpsRide({ durationS: 400, rideS: 600, videoAtStartS: -100, seed: 32 });
  const s = Y.syncRide(a.gopro, b.volt, {});
  assert.strictEqual(s.confidence, 'low');
  assert.ok(s.notes.some((n) => /^Not sure/.test(n)), s.notes.join(' / '));
  assert.ok(/Best guess/.test(s.summary), s.summary);
});

test('anchor: "I start rolling at t" is fine-tuned within 5 s; a far-off mark stays as set, low', () => {
  const Q = require('../core/sync/search');
  const fm = Q.firstMotion(LONG.volt);
  assert.ok(fm && fm.source === 'scooter');
  const roll = LONG.truth.videoOfMono(fm.mono);
  for (const d of [2.5, -4]) {
    const s = Y.syncRide(LONG.gopro, LONG.volt, { anchorVideoS: roll + d });
    assert.strictEqual(s.mode, 'anchor');
    assert.ok(Math.abs(s.rideStartVideoS - -200) < 0.05, 'mark ' + d + ': start ' + s.rideStartVideoS);
    assert.notStrictEqual(s.confidence, 'low');
    assert.ok(/your start mark/.test(s.summary), s.summary);
  }
  const far = Y.syncRide(LONG.gopro, LONG.volt, { anchorVideoS: roll + 20 });
  assert.strictEqual(far.confidence, 'low');
  assert.strictEqual(far.method, 'anchor');
  // kept exactly where the owner put it: first motion at roll + 20
  assert.ok(Math.abs(Y.monoToVideo(Y.modelOf(far), fm.mono) - (roll + 20)) < 1e-6);
  assert.ok(far.notes.some((n) => /automatic search prefers/.test(n)), far.notes.join(' / '));
});

test('with GoPro GPS time the summary names it', () => {
  const s = Y.syncRide(R.gopro, R.volt, {});
  assert.strictEqual(s.mode, 'gnss');
  assert.ok(/GPS time/.test(s.summary) && s.agreed.indexOf('gnss') === 0, s.summary);
});
