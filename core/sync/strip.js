'use strict';
// Data for the panel's sync strip: GoPro vs Volt curves on video time, small enough to redraw
// on every nudge. The panel shifts the Volt curve by (nudge - strip.nudgeMs) without recomputing.

const S = require('../util/signal');
const Y = require('./sync');

function r(x, d) { const p = Math.pow(10, d); return Number.isFinite(x) ? Math.round(x * p) / p : null; }
function zs(a) {
  const f = Array.from(a).filter(Number.isFinite);
  const m = S.mean(f), s = S.std(f) || 1;
  return Array.from(a, (v) => (Number.isFinite(v) ? r((v - m) / s, 3) : null));
}
// keep at most maxN points (every k-th)
function thin(t, v, maxN) {
  const k = Math.max(1, Math.ceil(t.length / maxN));
  const ot = [], ov = [];
  for (let i = 0; i < t.length; i += k) { ot.push(r(t[i], 3)); ov.push(v[i]); }
  return { t: ot, v: ov };
}

function imuPair(gopro, volt, model, t0, t1, rate) {
  const g = Y.grid(t0, t1, rate);
  const ga = gopro.accl, pm = volt.motion;
  const gm = new Float64Array(ga.t.length);
  for (let i = 0; i < gm.length; i++) gm[i] = Math.hypot(ga.x[i], ga.y[i], ga.z[i]);
  const pmag = pm.raw.map((q) => Math.hypot(q[0], q[1], q[2]));
  const env = (x) => S.movingAverage(Array.from(x, Math.abs), Math.max(1, Math.round(rate * 0.12)));
  const a = env(Y.accelFeature(ga.t, gm, null, g, rate));
  const b = env(Y.accelFeature(pm.t, pmag, model, g, rate));
  return { t: Array.from(g, (x) => r(x, 3)), a: zs(a), b: zs(b) };
}

function syncStrip(gopro, volt, sync, opts) {
  opts = opts || {};
  const model = Y.modelOf(sync);
  const dur = gopro.durationS;
  const out = { durationS: dur, rideStartVideoS: sync.rideStartVideoS, nudgeMs: sync.nudge_ms || 0, fps: gopro.fps, speed: null, imu: null };

  // Overview: speeds (km/h) on video time
  const gs = Y.goproSpeed(gopro);
  const vs = Y.voltSpeeds(volt);
  const vref = vs.scooter || vs.phone;
  if (vref) {
    const ov = { t: vref.t.map((m) => Y.monoToVideo(model, m)), v: vref.v.map((x) => r(x * 3.6, 2)) };
    out.speed = { volt: thin(ov.t, ov.v, 3000), voltLabel: vs.scooter ? 'Scooter speed' : 'Phone GPS speed', gopro: gs ? thin(gs.t, gs.v.map((x) => r(x * 3.6, 2)), 3000) : null };
  }

  // Detail: 20 s of IMU shock envelopes around the strongest kept window (else ride start + 30 s)
  const haveImu = gopro.accl && gopro.accl.t.length > 100 && volt.motion && volt.motion.t.length > 100;
  if (haveImu) {
    let centre = sync.rideStartVideoS + 30;
    const w = sync.imu && sync.imu.windows ? sync.imu.windows.filter((x) => x.conf > 0) : [];
    if (w.length) centre = w.reduce((a, b) => (b.conf > a.conf ? b : a)).tS;
    const span = opts.detailS || 20;
    const t0 = Math.max(0, Math.min(dur - span, centre - span / 2)), t1 = Math.min(dur, t0 + span);
    out.imu = Object.assign({ t0, t1 }, imuPair(gopro, volt, model, t0, t1, 25));
  }
  return out;
}

module.exports = { syncStrip };

// Agreement of the IMU detail curves when the Volt curve is shifted by deltaS seconds
// (Pearson r on the overlap; null when too little overlaps). Shown next to the nudge control.
function stripMatch(strip, deltaS) {
  const d = strip && strip.imu;
  if (!d || d.t.length < 10) return null;
  const dt = d.t[1] - d.t[0];
  const sh = Math.round(deltaS / dt);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = 0; i < d.a.length; i++) {
    const j = i - sh;
    if (j < 0 || j >= d.b.length) continue;
    const a = d.a[i], b = d.b[j];
    if (a === null || b === null) continue;
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
  }
  if (n < 0.5 * d.a.length) return null;
  const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? Math.round((cov / Math.sqrt(va * vb)) * 1000) / 1000 : null;
}

module.exports.stripMatch = stripMatch;
