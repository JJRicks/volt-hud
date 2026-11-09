'use strict';
// Turning timeline channels (10 Hz arrays with null = no data) into After Effects keyframes:
// null-aware smoothing, and decimation to the fewest linear keys within a tolerance.
// See docs/m0-results.md: baked keyframes, not sourceData expressions.

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// Map with null passthrough.
function mapN(a, f) { return Array.from(a, (x, i) => (isNum(x) ? f(x, i) : null)); }

// Centred moving average over +-h samples, valid neighbours only; null stays null.
function maN(a, h) {
  const n = a.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!isNum(a[i])) { out[i] = null; continue; }
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) if (isNum(a[k])) { s += a[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

// Zero-phase exponential smoothing (forward then backward), time constant tau seconds.
// Each valid run is smoothed on its own.
function easeN(a, tau, rate) {
  const k = 1 - Math.exp(-1 / (tau * rate));
  const out = a.slice();
  let prev = null;
  for (let i = 0; i < out.length; i++) { if (!isNum(out[i])) { prev = null; continue; } prev = prev === null ? out[i] : prev + k * (out[i] - prev); out[i] = prev; }
  prev = null;
  for (let i = out.length - 1; i >= 0; i--) { if (!isNum(out[i])) { prev = null; continue; } prev = prev === null ? out[i] : prev + k * (out[i] - prev); out[i] = prev; }
  return out;
}

// Critically damped spring following the target (like Volt's GaugeSmoother), omega in rad/s.
function springN(a, omega, rate) {
  const out = new Array(a.length);
  const sub = 10, dt = 1 / rate / sub;
  let x = null, v = 0;
  for (let i = 0; i < a.length; i++) {
    const tgt = a[i];
    if (!isNum(tgt)) { out[i] = null; x = null; v = 0; continue; }
    if (x === null) { x = tgt; v = 0; }
    for (let s = 0; s < sub; s++) { const acc = omega * omega * (tgt - x) - 2 * omega * v; v += acc * dt; x += v * dt; }
    out[i] = x;
  }
  return out;
}

// Running maximum of valid values (null before the first valid sample).
function runningMax(a, init) {
  let m = init == null ? -Infinity : init;
  return Array.from(a, (x) => { if (isNum(x) && x > m) m = x; return m === -Infinity ? null : m; });
}

// Stopped-scooter mask (true = stopped) from a 10 Hz speed in km/h, with hysteresis so the digits
// don't flicker. The dash reports about 1 Hz in 0.1 km/h steps, with stray 0.1-0.5 km/h blips while
// parked, and the +-1.5 s smoothing smears those and ramp tails into neighbours, so a parked scooter
// hovers at 0.02-0.2 mph and rounds to "0.1". A sample becomes stopped once the speed has stayed
// under enterKmh for dwellS; it stays stopped until the speed reaches leaveKmh. GPS sources are
// noisier when parked, so they get higher thresholds. Slow rolling above the band still shows.
function stoppedMask(kmh, rate, src, o) {
  o = Object.assign({ enterKmh: 0.4, leaveKmh: 0.6, gpsEnterKmh: 1.2, gpsLeaveKmh: 1.8, dwellS: 0.5 }, o);
  const n = kmh.length, mask = new Array(n).fill(false);
  const dwell = Math.max(1, Math.round(o.dwellS * rate));
  let stopped = false, run = 0;
  for (let i = 0; i < n; i++) {
    if (!isNum(kmh[i])) { stopped = false; run = 0; continue; }
    const gps = src && (src[i] === 'gopro-gps' || src[i] === 'phone-gps');
    const enter = gps ? o.gpsEnterKmh : o.enterKmh, leave = gps ? o.gpsLeaveKmh : o.leaveKmh;
    if (stopped) {
      if (kmh[i] >= leave) { stopped = false; run = 0; } else mask[i] = true;
    } else if (kmh[i] < enter) {
      run++;
      if (run >= dwell) { stopped = true; for (let k = i - run + 1; k <= i; k++) mask[k] = true; }
    } else run = 0;
  }
  return mask;
}

// Fewest keys so that linear interpolation stays within tol of every valid sample.
// Returns {t:[], v:[]} with t in seconds (sample i at i/rate). Across a null run the value is
// held at the last valid value (a key at the first null sample), so nothing drifts while the
// widget shows "no data". With zeroPins, the edges of every run of exact zeros are keys, so a
// stopped stretch interpolates as exactly 0.
function decimate(a, rate, tol, maxSeg, zeroPins) {
  maxSeg = maxSeg || 300;
  const t = [], v = [];
  const n = a.length;
  const pin = (i) => zeroPins && a[i] === 0 && (i === 0 || a[i - 1] !== 0 || i === n - 1 || a[i + 1] !== 0);
  const push = (i, val) => { t.push(Math.round((i / rate) * 1e4) / 1e4); v.push(val); };
  let i = 0;
  while (i < n) {
    if (!isNum(a[i])) { i++; continue; }
    let e = i; // run [i, e]
    while (e + 1 < n && isNum(a[e + 1])) e++;
    let anchor = i;
    push(anchor, a[anchor]);
    while (anchor < e) {
      let j = anchor + 1, best = j;
      for (; j <= e && j - anchor <= maxSeg; j++) {
        let ok = true;
        const va = a[anchor], vb = a[j];
        for (let m = anchor + 1; m < j; m++) { const lerp = va + ((vb - va) * (m - anchor)) / (j - anchor); if (Math.abs(a[m] - lerp) > tol) { ok = false; break; } }
        if (!ok) break;
        best = j;
        if (pin(j)) break;
      }
      anchor = best;
      push(anchor, a[anchor]);
    }
    if (e + 1 < n) push(e + 1, a[e]); // hold through the gap
    i = e + 1;
  }
  return { t, v };
}

// Keys only where the (rounded) value changes; meant for HOLD interpolation.
function steps(a, rate, digits) {
  const t = [], v = [];
  const p = Math.pow(10, digits == null ? 3 : digits);
  let prev;
  for (let i = 0; i < a.length; i++) {
    if (!isNum(a[i])) continue;
    const x = Math.round(a[i] * p) / p;
    if (x !== prev) { t.push(Math.round((i / rate) * 1e4) / 1e4); v.push(x); prev = x; }
  }
  return { t, v };
}

// Validity flags (1 data, 0 no data) as HOLD keys at transitions; null when always valid.
function okKeys(a, rate) {
  const t = [], v = [];
  let prev = -1, anyNull = false;
  for (let i = 0; i < a.length; i++) {
    const s = isNum(a[i]) ? 1 : 0;
    if (!s) anyNull = true;
    if (s !== prev) { t.push(Math.round((i / rate) * 1e4) / 1e4); v.push(s); prev = s; }
  }
  return anyNull ? { t, v } : null;
}

function roundKeys(k, d) { const p = Math.pow(10, d); k.v = k.v.map((x) => Math.round(x * p) / p); return k; }

// Douglas-Peucker on [x,y] points (same units as tol).
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / L;
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

module.exports = { isNum, mapN, maN, easeN, springN, runningMax, stoppedMask, decimate, steps, okKeys, roundKeys, simplify };
