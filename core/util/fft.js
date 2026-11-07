'use strict';
// Radix-2 complex FFT and a masked normalised cross-correlation over every lag
// (NaN = missing), so whole-ride searches stay O(N log N). Node 17 safe.

// In-place iterative FFT of (re, im), length a power of two. inverse: unscaled.
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Masked NCC of a (length na) and b (length nb) for every placement d of b on a's
// axis: c(d) = corr(a[i], b[i - d]) over the samples where both are finite.
// Returns {d0, vals, n}: vals[k] is the NCC at d = d0 + k, d from -(nb-1) to na-1;
// NaN where the overlap has fewer than minOverlap valid pairs.
function maskedNcc(a, b, minOverlap) {
  const na = a.length, nb = b.length;
  const N = pow2(na + nb);
  const spec = (x, n, pow) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < n; i++) { const v = x[i]; if (v === v) re[i] = pow === 0 ? 1 : pow === 1 ? v : v * v; }
    fft(re, im, false);
    return { re, im };
  };
  // corr over d: S(d) = sum_i x[i] y[i-d] = sum_j y[j] x[j+d]  ->  IFFT(conj(Y) X)[d]
  const A0 = spec(a, na, 0), A1 = spec(a, na, 1), A2 = spec(a, na, 2);
  const B0 = spec(b, nb, 0), B1 = spec(b, nb, 1), B2 = spec(b, nb, 2);
  // two real results per inverse FFT: IFFT(P + iQ) = p + iq when p, q are real
  const inv2 = (X1, Y1, X2, Y2) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      // P = conj(Y1) X1, Q = conj(Y2) X2
      const pr = Y1.re[k] * X1.re[k] + Y1.im[k] * X1.im[k], pi = Y1.re[k] * X1.im[k] - Y1.im[k] * X1.re[k];
      const qr = Y2.re[k] * X2.re[k] + Y2.im[k] * X2.im[k], qi = Y2.re[k] * X2.im[k] - Y2.im[k] * X2.re[k];
      re[k] = pr - qi; im[k] = pi + qr;
    }
    fft(re, im, true);
    for (let k = 0; k < N; k++) { re[k] /= N; im[k] /= N; }
    return [re, im];
  };
  const [cn, cab] = inv2(A0, B0, A1, B1); // n, sum a*b
  const [csa, csb] = inv2(A1, B0, A0, B1); // sum a (over b's mask), sum b (over a's mask)
  const [csaa, csbb] = inv2(A2, B0, A0, B2);
  const len = na + nb - 1, vals = new Float64Array(len), cnt = new Float64Array(len);
  const mo = minOverlap || 10;
  for (let k = 0; k < len; k++) {
    const d = k - (nb - 1);
    const idx = d >= 0 ? d : N + d;
    const n = Math.round(cn[idx]);
    cnt[k] = n;
    if (n < mo) { vals[k] = NaN; continue; }
    const sa = csa[idx], sb = csb[idx];
    const va = csaa[idx] - (sa * sa) / n, vb = csbb[idx] - (sb * sb) / n;
    const cov = cab[idx] - (sa * sb) / n;
    vals[k] = va > 1e-9 * n && vb > 1e-9 * n ? Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb))) : NaN;
  }
  return { d0: -(nb - 1), vals, n: cnt };
}

module.exports = { fft, maskedNcc, pow2 };
