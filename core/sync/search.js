'use strict';
// Sync without a GoPro clock (no GPS time, unset camera clock): search every placement of the ride
// on the clip where the two overlap meaningfully, with orientation-invariant signals the GoPro and
// the Volt data share. See docs/sync-design.md, "No GPS on the GoPro".
//
//   vibration : GoPro rolling RMS of high-passed |accel|  vs  Volt speed      (moving vs stopped)
//   accel     : GoPro gravity-removed horizontal |accel|  vs  |d speed / dt|  (speeding up, braking)
//   bumps     : GoPro high-passed |accel| + envelope      vs  phone |accel|   (the existing IMU feature)
//
// Each is a masked normalised cross-correlation over every lag (FFT, so an hour-long ride stays
// fast). The curves are z-scored over the search range and summed; the caller refines the best
// placement with the windowed IMU sync and decides the confidence.

const S = require('../util/signal');
const { maskedNcc } = require('../util/fft');

const AXIS_HZ = 10; // common start-time axis
const TOL_S = { vibration: 2, accel: 2, bumps: 0.1 }; // how far a method's own peak may sit (speed lags on BLE)

function gridFrom(t0, n, rate) { const g = new Float64Array(n); for (let i = 0; i < n; i++) g[i] = t0 + i / rate; return g; }
function accelMag(t, x, y, z) { const n = t.length, m = new Float64Array(n); for (let i = 0; i < n; i++) m[i] = Math.hypot(x[i], y[i], z[i]); return m; }

// ---- GoPro signals (video time, grid from 0) ----
function goproVibration(gopro, rate) {
  const a = gopro.accl, r0 = 50, T = gopro.durationS;
  const N = Math.ceil(T * r0);
  const b = S.binMean(a.t, accelMag(a.t, a.x, a.y, a.z), -0.5 / r0, 1 / r0, N);
  const hp = S.highPass(b, r0); // remove gravity and slow changes (1 s)
  const ms = S.movingAverage(hp.map((x) => x * x), r0 * 2); // 4 s rolling mean square
  const M = Math.floor(T * rate), out = new Float64Array(M);
  for (let k = 0; k < M; k++) { const v = ms[Math.min(N - 1, Math.round((k / rate) * r0))]; out[k] = Number.isFinite(v) ? Math.log(Math.sqrt(v) + 0.2) : NaN; }
  return out;
}

// GRAV gives gravity in the camera frame, but its axis order and signs differ from ACCL on some
// cameras: pick the signed permutation that best matches the low-passed accel direction.
function gravMapping(gopro) {
  const a = gopro.accl, g = gopro.grav;
  if (!g || !g.t || g.t.length < 50 || !a) return null;
  const rate = 5, n = Math.floor(gopro.durationS * rate), gr = gridFrom(0, n, rate);
  const lp = (v) => S.movingAverage(S.binMean(a.t, v, -0.5 / rate, 1 / rate, n), rate);
  const A = [lp(a.x), lp(a.y), lp(a.z)];
  const G = [S.interpAt(g.t, g.x, gr, 1), S.interpAt(g.t, g.y, gr, 1), S.interpAt(g.t, g.z, gr, 1)];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let best = null;
  for (const p of perms) for (let s = 0; s < 8; s++) {
    const sg = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
    let e = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(A[0][i], A[1][i], A[2][i]);
      if (!(m > 1)) continue;
      let d = 0;
      for (let k = 0; k < 3; k++) { const q = A[k][i] / m - sg[k] * G[p[k]][i]; d += q * q; }
      if (Number.isFinite(d)) { e += d; c++; }
    }
    if (c > 20 && (!best || e / c < best.err)) best = { perm: p, sign: sg, err: e / c };
  }
  return best && best.err < 0.1 ? best : null; // ~18 degrees RMS: otherwise GRAV is not usable
}

function goproHorizAccel(gopro, rate) {
  const map = gravMapping(gopro);
  if (!map) return null;
  const a = gopro.accl, g = gopro.grav, n = Math.floor(gopro.durationS * rate), gr = gridFrom(0, n, rate);
  const lp = (v) => S.movingAverage(S.binMean(a.t, v, -0.5 / rate, 1 / rate, n), Math.max(1, Math.round(rate * 0.5)));
  const A = [lp(a.x), lp(a.y), lp(a.z)];
  const gs = [g.x, g.y, g.z].map((v) => S.interpAt(g.t, v, gr, 1));
  const G = [0, 1, 2].map((k) => gs[map.perm[k]].map((v) => map.sign[k] * v));
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gm = Math.hypot(G[0][i], G[1][i], G[2][i]);
    if (!(gm > 0)) { h[i] = NaN; continue; }
    const ux = G[0][i] / gm, uy = G[1][i] / gm, uz = G[2][i] / gm;
    const dot = A[0][i] * ux + A[1][i] * uy + A[2][i] * uz;
    h[i] = Math.hypot(A[0][i] - dot * ux, A[1][i] - dot * uy, A[2][i] - dot * uz);
  }
  return { v: S.movingAverage(h, Math.round(rate / 2)), mapping: map };
}

// ---- Volt signals (seconds from monoRef) ----
function voltSpeed(volt, monoRef) {
  const sp = volt.scooter && volt.scooter.series && volt.scooter.series.speed_kmh;
  if (sp && sp.t.length >= 10) return { t: Array.from(sp.t, (m) => (m - monoRef) / 1000), v: Array.from(sp.v, (x) => x / 3.6), source: 'scooter' };
  const g = volt.phone && volt.phone.gps;
  if (g && g.t.length >= 10) {
    const t = [], v = [];
    for (let i = 0; i < g.t.length; i++) if (Number.isFinite(g.speed[i]) && !(g.speedAcc[i] > 1.5)) { t.push((g.t[i] - monoRef) / 1000); v.push(g.speed[i]); }
    if (t.length >= 10) return { t, v, source: 'phone-gps' };
  }
  return null;
}
function voltAccelMag(volt, monoRef) {
  const m = volt.motion;
  if (!m || !m.t || m.t.length < 100) return null;
  const t = new Float64Array(m.t.length), v = new Float64Array(m.t.length);
  for (let i = 0; i < m.t.length; i++) { t[i] = (m.t[i] - monoRef) / 1000; const r = m.raw[i]; v[i] = Math.hypot(r[0], r[1], r[2]); }
  return { t, v };
}

// The first sustained motion: speed at or above thresholdKmh for at least holdS (default 3 km/h for
// 3 s). Returns {mono, source} or null.
function firstMotion(volt, opts) {
  const thr = ((opts && opts.thresholdKmh) || 3) / 3.6, hold = (opts && opts.holdS) || 3;
  const sp = voltSpeed(volt, 0);
  if (!sp) return null;
  const { t, v } = sp; // t in ms/1000 of the mono clock
  for (let i = 0; i < t.length; i++) {
    if (!(v[i] >= thr)) continue;
    let ok = true, j = i;
    for (; j < t.length && t[j] <= t[i] + hold; j++) if (!(v[j] >= thr)) { ok = false; break; }
    if (ok && j < t.length && t[j - 1] - t[i] >= hold * 0.6) return { mono: t[i] * 1000, source: sp.source, thresholdKmh: thr * 3.6, holdS: hold };
  }
  return null;
}

// ---- shared feature helpers (same as the windowed IMU sync) ----
function shockFeature(t, mag, g0, n, rate) {
  const dt = 1 / rate;
  const density = t.length / Math.max(1e-9, t[t.length - 1] - t[0]);
  const g = gridFrom(g0, n, rate);
  const x = density > rate * 1.5 ? S.binMean(t, mag, g0 - dt / 2, dt, n) : S.interpAt(t, mag, g, 0.25);
  return S.movingAverage(S.highPass(x, Math.round(rate * 1.0)), Math.max(1, Math.round(rate * 0.075)));
}
function envelope(x, rate) {
  const r = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) r[i] = Math.abs(x[i]);
  return S.highPass(S.movingAverage(r, Math.round(rate * 0.25)), Math.round(rate * 2));
}

// curve from maskedNcc (placement p of the Volt grid [u0 + k/rate] on the video grid [k/rate])
// resampled onto the common start axis: start = p/rate - u0.
function toAxis(c, rate, u0, sLo, nAxis) {
  const out = new Float64Array(nAxis);
  for (let k = 0; k < nAxis; k++) {
    const x = (sLo + k / AXIS_HZ + u0) * rate - c.d0;
    const i = Math.floor(x), f = x - i;
    out[k] = i >= 0 && i + 1 < c.vals.length ? c.vals[i] * (1 - f) + c.vals[i + 1] * f : NaN;
  }
  return out;
}
function zscore(x) {
  const m = S.mean(x), s = S.std(x);
  const o = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = s > 0 && Number.isFinite(x[i]) ? (x[i] - m) / s : NaN;
  return o;
}
function maxFilter(x, h) {
  if (h < 1) return x;
  const o = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let m = NaN;
    for (let k = Math.max(0, i - h); k <= Math.min(x.length - 1, i + h); k++) if (x[k] > m || m !== m) m = x[k];
    o[i] = m;
  }
  return o;
}
function argmaxIn(x, lo, hi) { let b = -1; for (let i = Math.max(0, lo); i <= Math.min(x.length - 1, hi); i++) if (Number.isFinite(x[i]) && (b < 0 || x[i] > x[b])) b = i; return b; }

// Search. opts: {lo, hi, skip} limit the reported best start (video s of monoRef) to a window, e.g. an
// anchor +-5 s; curves and their z-scores still use the whole plausible range.
function searchStart(gopro, volt, monoRef, opts) {
  opts = opts || {};
  const skip = opts.skip || []; // e.g. ['accel'] (tests and comparisons)
  const T = gopro.durationS;
  const sp = voltSpeed(volt, monoRef), pa = voltAccelMag(volt, monoRef);
  const haveAccl = !!(gopro.accl && gopro.accl.t.length > 100);
  if (!haveAccl || (!sp && !pa)) return { ok: false, reason: !haveAccl ? 'no GoPro accelerometer data' : 'no Volt speed or motion data' };
  // the ride's span on its own clock
  let u0 = Infinity, u1 = -Infinity;
  for (const s of [sp, pa]) if (s) { u0 = Math.min(u0, s.t[0]); u1 = Math.max(u1, s.t[s.t.length - 1]); }
  const RT = u1 - u0;
  const minOvS = Math.min(60, 0.5 * Math.min(T, RT));
  // placements: at least minOvS of the ride inside the clip
  const sLo = -u1 + minOvS, sHi = T - u0 - minOvS;
  if (!(sHi > sLo)) return { ok: false, reason: 'ride or clip too short to search' };
  const nAxis = Math.floor((sHi - sLo) * AXIS_HZ) + 1;
  const curves = {};
  const used = {};

  if (sp && skip.indexOf('vibration') < 0) {
    // vibration vs speed, 2 Hz
    const r = 2, vib = goproVibration(gopro, r);
    const n = Math.floor(RT * r) + 1;
    const spd = S.interpAt(sp.t, sp.v, gridFrom(u0, n, r), 3).map((x) => Math.log(Math.max(0, x) + 1));
    curves.vibration = toAxis(maskedNcc(vib, spd, Math.round(minOvS * r)), r, u0, sLo, nAxis);
    used.vibration = 'GoPro vibration vs ' + (sp.source === 'scooter' ? 'scooter' : 'phone GPS') + ' speed';
  }
  if (sp && skip.indexOf('accel') < 0) {
    // accel vs |dv/dt|, 5 Hz. Kept as a vote: on the owner's sample it turned two trimmed
    // clips from low to medium and fixed one wrong placement (full clip + 4 trims); needs GRAV.
    const ra = 5, ha = goproHorizAccel(gopro, ra);
    if (ha) {
      const na = Math.floor(RT * ra) + 1;
      const dv = S.localLinear(sp.t, sp.v, gridFrom(u0, na, ra), 1.5, 3).slope.map(Math.abs);
      curves.accel = toAxis(maskedNcc(ha.v, dv, Math.round(minOvS * ra)), ra, u0, sLo, nAxis);
      used.accel = 'GoPro horizontal acceleration vs speed changes';
    }
  }
  if (pa && skip.indexOf('bumps') < 0) {
    const rb = 25;
    const a = gopro.accl;
    const fa = shockFeature(a.t, accelMag(a.t, a.x, a.y, a.z), 0, Math.floor(T * rb) + 1, rb);
    const fb = shockFeature(pa.t, pa.v, u0, Math.floor(RT * rb) + 1, rb);
    const mo = Math.round(minOvS * rb);
    const c1 = maskedNcc(fa, fb, mo), c2 = maskedNcc(envelope(fa, rb), envelope(fb, rb), mo);
    const vals = new Float64Array(c1.vals.length);
    for (let i = 0; i < vals.length; i++) vals[i] = 0.6 * c1.vals[i] + 0.4 * c2.vals[i];
    curves.bumps = toAxis({ d0: c1.d0, vals }, rb, u0, sLo, nAxis);
    used.bumps = 'GoPro bumps vs phone bumps';
  }

  const names = Object.keys(curves);
  const comb = new Float64Array(nAxis).fill(0);
  const zs = {};
  for (const k of names) {
    zs[k] = maxFilter(zscore(curves[k]), Math.round(TOL_S[k] * AXIS_HZ));
    for (let i = 0; i < nAxis; i++) comb[i] += zs[k][i]; // NaN propagates: all methods must cover a lag
  }
  const iLo = opts.lo == null ? 0 : Math.max(0, Math.ceil((opts.lo - sLo) * AXIS_HZ));
  const iHi = opts.hi == null ? nAxis - 1 : Math.min(nAxis - 1, Math.floor((opts.hi - sLo) * AXIS_HZ));
  if (iHi < iLo) return { ok: false, reason: 'search window outside the plausible range' };
  const bi = argmaxIn(comb, iLo, iHi);
  if (bi < 0) return { ok: false, reason: 'no overlap with enough data' };
  // second best: a local maximum at least 3 s away, anywhere in the plausible range
  const ex = 3 * AXIS_HZ;
  let si = -1;
  for (let i = 0; i < nAxis; i++) {
    if (!Number.isFinite(comb[i]) || Math.abs(i - bi) <= ex) continue;
    const lm = !(comb[i - 1] > comb[i]) && !(comb[i + 1] > comb[i]);
    if (lm && (si < 0 || comb[i] > comb[si])) si = i;
  }
  const at = (i) => sLo + i / AXIS_HZ;
  const best = { startS: at(bi), score: comb[bi] };
  const second = si >= 0 ? { startS: at(si), score: comb[si] } : null;
  // each method's own peak near the best (within its tolerance + 1 s)
  const methods = {};
  for (const k of names) {
    const h = Math.round((TOL_S[k] + 1) * AXIS_HZ);
    const raw = curves[k];
    const li = argmaxIn(raw, bi - h, bi + h), gi = argmaxIn(raw, 0, nAxis - 1);
    methods[k] = {
      label: used[k],
      localPeakS: li >= 0 ? at(li) : null, localNcc: li >= 0 ? raw[li] : null,
      globalPeakS: gi >= 0 ? at(gi) : null, globalNcc: gi >= 0 ? raw[gi] : null,
      zAtBest: zs[k][bi],
    };
  }
  // a window search (anchor): is there a clearly better placement outside it?
  let outside = null;
  if (opts.lo != null || opts.hi != null) {
    let oi = -1;
    for (let i = 0; i < nAxis; i++) if ((i < iLo - ex || i > iHi + ex) && Number.isFinite(comb[i]) && (oi < 0 || comb[i] > comb[oi])) oi = i;
    if (oi >= 0) outside = { startS: at(oi), score: comb[oi] };
  }
  return {
    ok: true, best, second, ratio: second && best.score > 0 ? Math.max(0, second.score) / best.score : second ? 1 : 0,
    atWindowEdge: (opts.lo != null || opts.hi != null) && (bi - iLo < 3 || iHi - bi < 3),
    outside, methods, speedSource: sp ? sp.source : null, minOverlapS: minOvS,
    range: { loS: sLo, hiS: sHi }, rideSpanS: RT,
  };
}

module.exports = { searchStart, firstMotion, goproVibration, goproHorizAccel, gravMapping, voltSpeed, TOL_S };
