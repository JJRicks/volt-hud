'use strict';
// Derived HUD channels on the video grid. Smoothing is documented in
// docs/derivations.md. All inputs are on the Volt monotonic clock (ms) unless
// noted; outputs are arrays aligned with `monoGrid` (NaN = no data).

const S = require('../util/signal');

const G = 9.80665;

// Fused speed (m/s) with a per-sample source flag.
// 1. scooter dash speed (km/h at sensor update times), local-linear smoothed
//    over +-1.5 s, valid while the newest update is <= 2.5 s old;
// 2. GoPro GPS 2D speed (fix >= 2), smoothed +-0.5 s;
// 3. phone GPS speed (speed accuracy <= 1.5 m/s), interpolated across <= 2.5 s.
function fusedSpeed(volt, monoGrid, goproGps, videoGrid) {
  const n = monoGrid.length;
  const v = new Float64Array(n).fill(NaN);
  const src = new Array(n).fill(null);
  const sp = volt.scooter && volt.scooter.series.speed_kmh;
  if (sp && sp.t.length >= 2) {
    const ms = sp.v.map((x) => x / 3.6);
    const sm = S.localLinear(sp.t, ms, monoGrid, 1500, 2).val;
    const fresh = S.holdAt(sp.t, sp.t, monoGrid, 2500);
    const end = sp.t[sp.t.length - 1];
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(fresh[i]) && monoGrid[i] <= end + 1500 && Number.isFinite(sm[i])) { v[i] = Math.max(0, sm[i]); src[i] = 'scooter'; }
    }
  }
  if (goproGps && videoGrid) {
    const t = [], s = [];
    for (let i = 0; i < goproGps.t.length; i++) if (goproGps.fix[i] >= 2) { t.push(goproGps.t[i]); s.push(goproGps.s2[i]); }
    if (t.length > 10) {
      const sm = S.localLinear(t, s, videoGrid, 0.5, 3).val;
      for (let i = 0; i < n; i++) if (src[i] === null && Number.isFinite(sm[i])) { v[i] = Math.max(0, sm[i]); src[i] = 'gopro-gps'; }
    }
  }
  const gps = volt.phone && volt.phone.gps;
  if (gps && gps.t.length > 2) {
    const t = [], s = [];
    for (let i = 0; i < gps.t.length; i++) if (Number.isFinite(gps.speed[i]) && !(gps.speedAcc[i] > 1.5)) { t.push(gps.t[i]); s.push(gps.speed[i]); }
    const it = S.interpAt(t, s, monoGrid, 2500);
    for (let i = 0; i < n; i++) if (src[i] === null && Number.isFinite(it[i])) { v[i] = Math.max(0, it[i]); src[i] = 'phone-gps'; }
  }
  return { mps: v, src };
}

// Power (W, + = draw, - = regen) and direction flag, interpolated between
// reports up to 2.5 s apart. Battery: step-hold up to 60 s.
function powerBattery(volt, monoGrid) {
  const n = monoGrid.length;
  const P = volt.power || { t: [], w: [], dir: [] };
  const w = S.interpAt(P.t, P.w, monoGrid, 2500);
  const dirRaw = S.holdAt(P.t, P.dir, monoGrid, 2500);
  const dir = new Array(n);
  for (let i = 0; i < n; i++) dir[i] = Number.isFinite(w[i]) ? (dirRaw[i] === 0 ? 0 : w[i] >= 0 ? 1 : -1) : null;
  const B = volt.scooter && volt.scooter.series.battery_percent;
  const bat = B ? S.holdAt(B.t, B.v, monoGrid, 60000) : new Float64Array(n).fill(NaN);
  return { w, dir, bat };
}

// Pressure (hPa) -> altitude (m), ISA hypsometric formula relative to p0.
function pressureAltitude(hPa, p0) {
  return 44330.77 * (1 - Math.pow(hPa / p0, 0.190263));
}

// Altitude and vertical rate. Candidates: raw phone pressure (ISA altitude,
// local linear +-8 s), the route's barometric relative altitude (+-8 s) and
// phone GPS altitude (+-5 s). Single-sample spikes (> 2 m off the line through
// both neighbours, baro only) are dropped. The candidate whose 1 Hz vertical
// rate is least rough (std of successive differences) wins: in a pocket at
// speed the barometer sees wind pressure, and GPS altitude is often smoother.
function vertical(volt, monoGrid, opts) {
  const cands = [];
  const pr = volt.phone && volt.phone.pressure;
  if (pr && pr.t.length > 10) {
    const p0 = S.median(pr.hPa);
    cands.push({ source: 'barometer', t: pr.t, h: despike(pr.t, pr.hPa.map((p) => pressureAltitude(p, p0))), half: 8000 });
  }
  if (volt.route && volt.route.relAlt.filter(Number.isFinite).length > 10) cands.push({ source: 'route-relative', t: volt.route.t, h: despike(volt.route.t, volt.route.relAlt), half: 8000 });
  const gps = volt.phone && volt.phone.gps;
  if (gps && gps.t.length > 10) {
    const h = gps.alt.map((a, i) => (gps.vAcc[i] > 20 ? NaN : a));
    const h0 = S.median(h);
    cands.push({ source: 'phone-gps', t: gps.t, h: h.map((x) => x - h0), half: 5000 });
  }
  const n = monoGrid.length;
  if (!cands.length) return { alt: new Float64Array(n).fill(NaN), vert: new Float64Array(n).fill(NaN), source: null, roughness: {} };
  const roughness = {};
  for (const c of cands) {
    const g = [];
    for (let m = c.t[0]; m <= c.t[c.t.length - 1]; m += 1000) g.push(m);
    const sl = S.localLinear(c.t, c.h, g, c.half, 3).slope;
    const d = [];
    for (let i = 1; i < sl.length; i++) if (Number.isFinite(sl[i]) && Number.isFinite(sl[i - 1])) d.push((sl[i] - sl[i - 1]) * 1000);
    c.rough = d.length > 5 ? S.std(d) : Infinity;
    roughness[c.source] = Math.round(c.rough * 1000) / 1000;
  }
  const forced = opts && opts.altitudeSource;
  const best = (forced && cands.find((c) => c.source === forced)) || cands.slice().sort((a, b) => a.rough - b.rough)[0];
  const ll = S.localLinear(best.t, best.h, monoGrid, best.half, 3);
  const lo = best.t[0], hi = best.t[best.t.length - 1];
  const alt = new Float64Array(n), vert = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const inside = monoGrid[i] >= lo - 1000 && monoGrid[i] <= hi + 1000;
    alt[i] = inside ? ll.val[i] : NaN;
    vert[i] = inside ? ll.slope[i] * 1000 : NaN; // m per ms -> m/s
  }
  return { alt, vert, source: best.source, roughness };
}

function despike(t, h) {
  const out = h.slice();
  for (let i = 1; i < h.length - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    const pred = dt > 0 ? h[i - 1] + ((h[i + 1] - h[i - 1]) * (t[i] - t[i - 1])) / dt : h[i];
    if (Math.abs(h[i] - pred) > 2) out[i] = NaN;
  }
  return out;
}

// Phone yaw rate about the world "up" axis from rotation-vector quaternions:
// q_rel = q[k+1] * q[k]^-1 (world-frame increment), omega = axis*angle/dt.
function yawRate(motion) {
  const t = [], w = [];
  if (!motion) return { t, w };
  const q = motion.quat;
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1], b = q[i];
    if (!(a.every(Number.isFinite) && b.every(Number.isFinite))) continue;
    const dt = (motion.t[i] - motion.t[i - 1]) / 1000;
    if (!(dt > 0 && dt < 0.25)) continue;
    // Android rotation vector: [x,y,z,w], device -> world (ENU)
    const [bx, by, bz, bw] = b, [ax, ay, az, aw] = a;
    // conj(a) = [-ax,-ay,-az,aw]; q_rel = b * conj(a)
    const rx = bw * -ax + bx * aw + by * -az - bz * -ay;
    const ry = bw * -ay - bx * -az + by * aw + bz * -ax;
    const rz = bw * -az + bx * -ay - by * -ax + bz * aw;
    let rw = bw * aw - bx * -ax - by * -ay - bz * -az;
    let sx = rx, sy = ry, sz = rz;
    if (rw < 0) { rw = -rw; sx = -sx; sy = -sy; sz = -sz; }
    const sinHalf = Math.hypot(sx, sy, sz);
    const ang = 2 * Math.atan2(sinHalf, rw);
    const wz = sinHalf > 1e-12 ? (sz / sinHalf) * (ang / dt) : 0;
    t.push((motion.t[i] + motion.t[i - 1]) / 2);
    w.push(wz);
  }
  return { t, w };
}

// Longitudinal g = d(speed)/dt (local linear, +-1 s); lateral g = v * yaw rate
// (yaw smoothed +-0.5 s), + = to the left (counter-clockwise turn).
// Jerk = |d a_vec / dt| over +-0.5 s on the smoothed g vector (m/s^3).
function gForces(speedMps, monoGrid, rateHz, motion) {
  const n = monoGrid.length;
  const valid = [], tv = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(speedMps[i])) { tv.push(monoGrid[i]); valid.push(speedMps[i]); }
  const dv = S.localLinear(tv, valid, monoGrid, 1000, 5).slope; // m/s per ms
  const yr = yawRate(motion);
  const yaw = S.localLinear(yr.t, yr.w, monoGrid, 500, 4).val;
  const lon = new Float64Array(n), lat = new Float64Array(n), tot = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = Number.isFinite(speedMps[i]) ? (dv[i] * 1000) / G : NaN;
    lat[i] = Number.isFinite(speedMps[i]) && Number.isFinite(yaw[i]) ? (speedMps[i] * yaw[i]) / G : NaN;
    tot[i] = Number.isFinite(lon[i]) ? Math.hypot(lon[i], Number.isFinite(lat[i]) ? lat[i] : 0) : NaN;
  }
  const h = Math.max(1, Math.round(rateHz * 0.5));
  const jerk = new Float64Array(n);
  const tsec = Array.from(monoGrid, (m) => m / 1000);
  const jl = S.localLinear(tsec, Array.from(lon, (x) => x * G), tsec, h / rateHz, 3).slope;
  const jt = S.localLinear(tsec, Array.from(lat, (x) => x * G), tsec, h / rateHz, 3).slope;
  for (let i = 0; i < n; i++) jerk[i] = Number.isFinite(jl[i]) ? Math.hypot(jl[i], Number.isFinite(jt[i]) ? jt[i] : 0) : NaN;
  return { lon, lat, tot, jerk };
}

module.exports = { fusedSpeed, powerBattery, vertical, pressureAltitude, yawRate, gForces, G };
