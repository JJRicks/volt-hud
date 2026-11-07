'use strict';
// Numeric helpers shared by sync and derive. Plain arrays / Float64Array; Node 17 safe.

function median(a) {
  const b = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!b.length) return NaN;
  const m = b.length >> 1;
  return b.length & 1 ? b[m] : (b[m - 1] + b[m]) / 2;
}

function mean(a) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}

function std(a) {
  const m = mean(a);
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
  return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
}

// Robust line y = slope*x + intercept (Theil–Sen). Large inputs use a strided
// subset of pairs so the cost stays near maxPairs. Returns rms of residuals too.
function theilSen(x, y, opts) {
  const maxPairs = (opts && opts.maxPairs) || 200000;
  const n = x.length;
  if (n < 2) return null;
  const x0 = x[0], y0 = y[0];
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = x[i] - x0; ys[i] = y[i] - y0; }
  const slopes = [];
  const stride = Math.max(1, Math.ceil((n * (n - 1)) / 2 / maxPairs));
  let c = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (c++ % stride) continue;
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const ints = new Float64Array(n);
  for (let i = 0; i < n; i++) ints[i] = ys[i] - slope * xs[i];
  const b = median(ints);
  const res = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) { res[i] = ys[i] - (slope * xs[i] + b); ss += res[i] * res[i]; }
  // intercept relative to the true origin: y = slope*x + intercept
  const intercept = y0 + b - slope * x0;
  return { slope, intercept, x0, y0: y0 + b, rms: Math.sqrt(ss / n), madResidual: median(Array.from(res, Math.abs)), n };
}

// Weighted least squares line y = a + b*x. Returns {a, b, rms}.
function weightedLine(x, y, w) {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) { sw += w[i]; sx += w[i] * x[i]; sy += w[i] * y[i]; }
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) { sxx += w[i] * (x[i] - mx) * (x[i] - mx); sxy += w[i] * (x[i] - mx) * (y[i] - my); }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < x.length; i++) { const r = y[i] - (a + b * x[i]); ss += w[i] * r * r; }
  return { a, b, rms: Math.sqrt(ss / sw) };
}

// Linear interpolation of irregular (t, v) onto grid times g. maxGap: leave NaN
// where neighbouring source samples are further apart than this.
function interpAt(t, v, g, maxGap) {
  const out = new Float64Array(g.length);
  const mg = maxGap == null ? Infinity : maxGap;
  let j = 0;
  for (let i = 0; i < g.length; i++) {
    const x = g[i];
    while (j + 1 < t.length && t[j + 1] < x) j++;
    if (!t.length || x < t[0] || x > t[t.length - 1]) { out[i] = NaN; continue; }
    if (t[j] === x || j + 1 >= t.length) { out[i] = t[j] === x ? v[j] : NaN; continue; }
    const t0 = t[j], t1 = t[j + 1];
    if (t1 - t0 > mg) { out[i] = NaN; continue; }
    const a = (x - t0) / (t1 - t0);
    out[i] = v[j] + a * (v[j + 1] - v[j]);
  }
  return out;
}

// Step-hold (last value at or before g), NaN if older than maxAge.
function holdAt(t, v, g, maxAge) {
  const out = new Float64Array(g.length);
  const ma = maxAge == null ? Infinity : maxAge;
  let j = -1;
  for (let i = 0; i < g.length; i++) {
    while (j + 1 < t.length && t[j + 1] <= g[i]) j++;
    out[i] = j >= 0 && g[i] - t[j] <= ma ? v[j] : NaN;
  }
  return out;
}

// Box-average irregular samples into bins of width dt starting at t0 (n bins).
function binMean(t, v, t0, dt, n) {
  const s = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < t.length; i++) {
    const k = Math.floor((t[i] - t0) / dt);
    if (k >= 0 && k < n && Number.isFinite(v[i])) { s[k] += v[i]; c[k]++; }
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = c[k] ? s[k] / c[k] : NaN;
  return out;
}

// Centered moving average over (2h+1) samples, NaN-aware.
function movingAverage(a, h) {
  const n = a.length;
  const out = new Float64Array(n);
  let s = 0, c = 0;
  const add = (k, sign) => { if (k >= 0 && k < n && Number.isFinite(a[k])) { s += sign * a[k]; c += sign; } };
  for (let k = -h; k <= h; k++) add(k, 1);
  for (let i = 0; i < n; i++) {
    out[i] = c ? s / c : NaN;
    add(i - h, -1);
    add(i + h + 1, 1);
  }
  return out;
}

function highPass(a, h) {
  const m = movingAverage(a, h);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - m[i];
  return out;
}

function fillNaN(a, value) {
  const out = Float64Array.from(a);
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = value;
  return out;
}

// Normalised cross-correlation of a and b (same grid) for integer lags in
// [lo, hi]: c(L) = corr(a[i], b[i+L]) over the overlap, NaN-aware.
// A positive lag means b is late: b(t+L) matches a(t).
function nccScan(a, b, lo, hi, minOverlap) {
  const lags = [], vals = [];
  const mo = minOverlap || 10;
  for (let L = lo; L <= hi; L++) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const i0 = Math.max(0, -L), i1 = Math.min(a.length, b.length - L);
    for (let i = i0; i < i1; i++) {
      const x = a[i], y = b[i + L];
      if (x !== x || y !== y) continue; // NaN
      n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    let c = NaN;
    if (n >= mo) {
      const cov = sab - (sa * sb) / n;
      const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
      c = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
    }
    lags.push(L); vals.push(c);
  }
  return { lags, vals };
}

// Peak analysis of a correlation curve: parabolic refinement, second-best
// local maximum outside +-exclude samples, and peak-to-sidelobe ratio.
function peakInfo(scan, exclude) {
  const { lags, vals } = scan;
  let bi = -1;
  for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i]) && (bi < 0 || vals[i] > vals[bi])) bi = i;
  if (bi < 0) return null;
  let frac = 0;
  if (bi > 0 && bi < vals.length - 1 && Number.isFinite(vals[bi - 1]) && Number.isFinite(vals[bi + 1])) {
    const y0 = vals[bi - 1], y1 = vals[bi], y2 = vals[bi + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
  }
  const ex = exclude || 1;
  let si = -1;
  const side = [];
  for (let i = 0; i < vals.length; i++) {
    if (!Number.isFinite(vals[i]) || Math.abs(i - bi) <= ex) continue;
    side.push(vals[i]);
    const isLocalMax = (i === 0 || !(vals[i - 1] > vals[i])) && (i === vals.length - 1 || !(vals[i + 1] > vals[i]));
    if (isLocalMax && (si < 0 || vals[i] > vals[si])) si = i;
  }
  const sm = mean(side), ss = std(side);
  return {
    lag: lags[bi] + frac,
    peak: vals[bi],
    atEdge: bi === 0 || bi === vals.length - 1,
    second: si >= 0 ? { lag: lags[si], peak: vals[si] } : null,
    psr: ss > 0 ? (vals[bi] - sm) / ss : NaN,
  };
}

// Local linear regression slope (and value) of irregular (t, v) at times g,
// using samples within +-h. Equivalent to a first-order Savitzky–Golay filter.
function localLinear(t, v, g, h, minN) {
  const val = new Float64Array(g.length), slope = new Float64Array(g.length);
  const mn = minN || 3;
  let lo = 0, hi = 0;
  for (let i = 0; i < g.length; i++) {
    const x = g[i];
    while (lo < t.length && t[lo] < x - h) lo++;
    while (hi < t.length && t[hi] <= x + h) hi++;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = lo; k < hi; k++) {
      if (!Number.isFinite(v[k])) continue;
      const dx = t[k] - x;
      n++; sx += dx; sy += v[k]; sxx += dx * dx; sxy += dx * v[k];
    }
    if (n < mn) { val[i] = NaN; slope[i] = NaN; continue; }
    const den = n * sxx - sx * sx;
    const b = den > 0 ? (n * sxy - sx * sy) / den : 0;
    slope[i] = den > 0 ? b : NaN;
    val[i] = (sy - b * sx) / n;
  }
  return { val, slope };
}

function round(a, d) {
  const f = Math.pow(10, d);
  return Array.from(a, (x) => (Number.isFinite(x) ? Math.round(x * f) / f : null));
}

module.exports = {
  median, mean, std, theilSen, weightedLine, interpAt, holdAt, binMean, movingAverage, highPass,
  fillNaN, nccScan, peakInfo, localLinear, round,
};
