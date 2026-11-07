'use strict';
// Sync v1 + v2: GNSS clock fits (coarse), speed cross-correlation, windowed IMU
// fine sync with a linear drift fit. See docs/sync-design.md and docs/derivations.md.
//
// Model: t_video_s = videoAtRefS + slope * (mono_ms - monoRefMs) / 1000
// (mono = the Volt phone's monotonic clock, video = seconds from the first
// chapter's frame 0).

const S = require('../util/signal');
const { monoToUtc } = require('../parse/volt');
const Q = require('./search');

function makeModel(monoRefMs, videoAtRefS, slope) {
  return { monoRefMs, videoAtRefS, slope };
}
function monoToVideo(m, mono) { return m.videoAtRefS + (m.slope * (mono - m.monoRefMs)) / 1000; }
function videoToMono(m, v) { return m.monoRefMs + ((v - m.videoAtRefS) * 1000) / m.slope; }
// Shift a model by delta seconds on the video axis, with an extra drift (s per s of video).
function shiftModel(m, deltaS, driftPerS, tRefVideo) {
  // new(v_old) = v_old + delta + drift*(v_old - tRef)
  const d = driftPerS || 0;
  const tr = tRefVideo == null ? m.videoAtRefS : tRefVideo;
  return makeModel(m.monoRefMs, m.videoAtRefS + deltaS + d * (m.videoAtRefS - tr), m.slope * (1 + d));
}

// GoPro clock fit: utc_ms = slope * video_ms + intercept.
function fitGoProClock(gpsTime) {
  if (!gpsTime || !gpsTime.t.length) return null;
  const good = [], all = [];
  for (let i = 0; i < gpsTime.t.length; i++) {
    if (!Number.isFinite(gpsTime.utc[i])) continue;
    const p = [gpsTime.t[i] * 1000, gpsTime.utc[i]];
    all.push(p);
    if (gpsTime.fix[i] >= 2 && gpsTime.dop[i] < 5) good.push(p);
  }
  // GPSU without a fix jumps by seconds (one owner clip: 145 of 488 stamps over 5 s off), and a few
  // fixes bunched together give a meaningless slope (3 fixes in 2 s: -10,989 ppm). So: drop stamps
  // more than 2 s from the median offset, and fit a slope only from at least 10 kept points over
  // 120 s or more whose drift is physically plausible (under 200 ppm); otherwise assume the camera
  // clock runs at rate 1 and take the median offset.
  const clean = (pts) => {
    if (!pts.length) return pts;
    const off = pts.map((p) => p[1] - p[0]).sort((a, b) => a - b);
    const med = off[off.length >> 1];
    return pts.filter((p) => Math.abs(p[1] - p[0] - med) <= 2000);
  };
  const g = clean(good), a = clean(all);
  const withFix = g.length >= 3;
  const use = withFix ? g : a;
  if (use.length < 2) return null;
  const span = use[use.length - 1][0] - use[0][0];
  const f = S.theilSen(use.map((p) => p[0]), use.map((p) => p[1]));
  const driftPpm = (f.slope - 1) * 1e6;
  const dropped = (withFix ? good.length : all.length) - use.length;
  if (use.length >= 10 && span >= 120000 && Math.abs(driftPpm) < 200) {
    return { slope: f.slope, intercept: f.intercept, rmsMs: f.rms, madMs: f.madResidual, n: f.n, withFix, driftPpm, dropped, spanS: span / 1000 };
  }
  const off = use.map((p) => p[1] - p[0]).sort((x, y) => x - y);
  const intercept = off[off.length >> 1];
  const res = use.map((p) => Math.abs(p[1] - p[0] - intercept)).sort((x, y) => x - y);
  const rms = Math.sqrt(use.reduce((s, p) => s + Math.pow(p[1] - p[0] - intercept, 2), 0) / use.length);
  return { slope: 1, intercept, rmsMs: rms, madMs: res[res.length >> 1], n: use.length, withFix, driftPpm: 0, dropped, spanS: span / 1000, rateAssumed: true,
    fittedDriftPpm: Number.isFinite(driftPpm) ? driftPpm : null };
}

function coarseModel(volt, gfit, monoRef) {
  const pf = volt.clock;
  // video_ms = (utc - gi)/gs ; utc = pf.utc0 + pf.slope*(mono - pf.mono0)
  const utcRef = monoToUtc(pf, monoRef);
  const videoAtRefS = (utcRef - gfit.intercept) / gfit.slope / 1000;
  return makeModel(monoRef, videoAtRefS, pf.slope / gfit.slope);
}

// ---- signals on the video grid ----
function grid(t0, t1, rate) {
  const n = Math.max(0, Math.floor((t1 - t0) * rate) + 1);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = t0 + i / rate;
  return g;
}

function goproSpeed(gopro) {
  const g = gopro.gps;
  if (!g) return null;
  const t = [], v = [];
  for (let i = 0; i < g.t.length; i++) if (g.fix[i] >= 2 && Number.isFinite(g.s2[i]) && g.s2[i] >= 0 && g.s2[i] < 40) { t.push(g.t[i]); v.push(g.s2[i]); }
  return t.length >= 20 ? { t, v } : null;
}

function voltSpeeds(volt) {
  const out = {};
  const sp = volt.scooter && volt.scooter.series.speed_kmh;
  if (sp && sp.t.length >= 10) out.scooter = { t: sp.t.slice(), v: sp.v.map((x) => x / 3.6) };
  const gps = volt.phone && volt.phone.gps;
  if (gps && gps.t.length >= 10) {
    const t = [], v = [];
    for (let i = 0; i < gps.t.length; i++) if (Number.isFinite(gps.speed[i]) && !(gps.speedAcc[i] > 1.5)) { t.push(gps.t[i]); v.push(gps.speed[i]); }
    if (t.length >= 10) out.phone = { t, v };
  }
  return out;
}

function onVideo(model, sig) { return { t: sig.t.map((m) => monoToVideo(model, m)), v: sig.v }; }

// Correlate reference (video-time signal) against a Volt signal mapped with
// `model`. Returns the correction delta (s) to add to the model's video times.
function xcorrDelta(ref, mov, rate, searchS, t0, t1, opts) {
  const g = grid(t0, t1, rate);
  const maxGap = (opts && opts.maxGap) || 2.5;
  // high-pass (3 s) so the peak is sharp: smooth speed curves give broad NCC
  // humps, and changes of speed are what both clocks share
  const hp = Math.round(rate * ((opts && opts.highPassS) || 3));
  const a = S.highPass(S.interpAt(ref.t, ref.v, g, maxGap), hp);
  const b = S.highPass(S.interpAt(mov.t, mov.v, g, maxGap), hp);
  const L = Math.round(searchS * rate);
  const scan = S.nccScan(a, b, -L, L, Math.max(10, rate * 5));
  const pk = S.peakInfo(scan, Math.max(1, Math.round(rate * ((opts && opts.excludeS) || 1))));
  if (!pk) return null;
  // b(t+L) ~ a(t): Volt shows up L samples late on the model's axis, so delta = -L/rate
  return {
    deltaS: -pk.lag / rate,
    peak: pk.peak,
    psr: pk.psr,
    atEdge: pk.atEdge,
    second: pk.second ? { deltaS: -pk.second.lag / rate, peak: pk.second.peak } : null,
    curve: { deltaS: scan.lags.map((l) => -l / rate), ncc: scan.vals.map((x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)) },
  };
}

// ---- IMU features (orientation-invariant) ----
// shock: |accel| -> 50 Hz -> high-pass (2 s) -> low-pass (0.15 s).
function accelFeature(t, mag, model, g, rate) {
  const tv = model ? t.map((m) => monoToVideo(model, m)) : t;
  const dt = 1 / rate;
  // box-average dense sources; interpolate sparse ones
  let x;
  const density = t.length / Math.max(1e-9, tv[tv.length - 1] - tv[0]);
  if (density > rate * 1.5) x = S.binMean(tv, mag, g[0] - dt / 2, dt, g.length);
  else x = S.interpAt(tv, mag, g, 0.25);
  const hp = S.highPass(x, Math.round(rate * 1.0));
  return S.movingAverage(hp, Math.max(1, Math.round(rate * 0.075)));
}

function goproAccelMag(gopro) {
  const a = gopro.accl;
  const n = a.t.length;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = Math.hypot(a.x[i], a.y[i], a.z[i]);
  return { t: a.t, v: m };
}
function phoneAccelMag(motion) {
  const n = motion.t.length;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) { const r = motion.raw[i]; m[i] = Math.hypot(r[0], r[1], r[2]); }
  return { t: motion.t, v: m };
}

function envelope(x, rate) {
  const r = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) r[i] = Math.abs(x[i]);
  return S.highPass(S.movingAverage(r, Math.round(rate * 0.25)), Math.round(rate * 2));
}

// Windowed IMU fine sync around `model`. Returns delta model (linear in video t).
function imuSync(gopro, volt, model, opts) {
  const rate = opts.rate || 50;
  const ga = goproAccelMag(gopro), pa = phoneAccelMag(volt.motion);
  const pv0 = monoToVideo(model, pa.t[0]), pv1 = monoToVideo(model, pa.t[pa.t.length - 1]);
  const t0 = Math.max(ga.t[0], pv0) - opts.searchS, t1 = Math.min(ga.t[ga.t.length - 1], pv1) + opts.searchS;
  if (!(t1 - t0 > 20)) return { ok: false, reason: 'IMU overlap under 20 s' };
  const g = grid(t0, t1, rate);
  const fa = accelFeature(ga.t, ga.v, null, g, rate);
  const fb = accelFeature(pa.t, pa.v, model, g, rate);
  const ea = envelope(fa, rate), eb = envelope(fb, rate);
  // global scan first (sets the window centre)
  const L = Math.round(opts.searchS * rate);
  const comb = (lo, hi, i0, i1) => {
    const A = fa.subarray(i0, i1), B = fb.subarray(i0, i1), EA = ea.subarray(i0, i1), EB = eb.subarray(i0, i1);
    const s1 = S.nccScan(A, B, lo, hi, rate * 5), s2 = S.nccScan(EA, EB, lo, hi, rate * 5);
    return { lags: s1.lags, vals: s1.vals.map((v, k) => (Number.isFinite(v) && Number.isFinite(s2.vals[k]) ? 0.6 * v + 0.4 * s2.vals[k] : NaN)) };
  };
  const gscan = comb(-L, L, 0, g.length);
  const gpk = S.peakInfo(gscan, Math.round(rate * 0.5));
  if (!gpk) return { ok: false, reason: 'no IMU correlation' };
  const globalDelta = -gpk.lag / rate;
  const global = {
    deltaS: globalDelta, peak: gpk.peak, psr: gpk.psr, atEdge: gpk.atEdge,
    second: gpk.second ? { deltaS: -gpk.second.lag / rate, peak: gpk.second.peak } : null,
    curve: { deltaS: gscan.lags.filter((_, k) => k % 5 === 0).map((l) => -l / rate), ncc: gscan.vals.filter((_, k) => k % 5 === 0).map((x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)) },
  };

  // windows
  const overlap = t1 - t0 - 2 * opts.searchS;
  const win = opts.windowS || Math.max(20, Math.min(120, overlap / 6));
  const step = win / 2;
  const fine = Math.round((opts.fineS || 1) * rate);
  const centre = Math.round(gpk.lag);
  const windows = [];
  for (let ws = t0 + opts.searchS; ws + win <= t1 - opts.searchS + 1e-9; ws += step) {
    const i0 = Math.max(0, Math.round((ws - t0) * rate) - fine - Math.abs(centre));
    const i1 = Math.min(g.length, Math.round((ws + win - t0) * rate) + fine + Math.abs(centre));
    // restrict the correlation to the window's own samples of A: mask outside
    const A = Float64Array.from(fa.subarray(i0, i1)), EA = Float64Array.from(ea.subarray(i0, i1));
    const a0 = Math.round((ws - t0) * rate) - i0, a1 = a0 + Math.round(win * rate);
    for (let k = 0; k < A.length; k++) if (k < a0 || k >= a1) { A[k] = NaN; EA[k] = NaN; }
    const B = fb.subarray(i0, i1), EB = eb.subarray(i0, i1);
    const s1 = S.nccScan(A, B, centre - fine, centre + fine, rate * 5), s2 = S.nccScan(EA, EB, centre - fine, centre + fine, rate * 5);
    const scan = { lags: s1.lags, vals: s1.vals.map((v, k) => (Number.isFinite(v) && Number.isFinite(s2.vals[k]) ? 0.6 * v + 0.4 * s2.vals[k] : NaN)) };
    const pk = S.peakInfo(scan, Math.round(rate * 0.2));
    // activity: quiet windows (stopped) get low weight
    let e = 0, c = 0;
    for (let k = a0; k < a1; k++) if (Number.isFinite(A[k]) && Number.isFinite(B[k])) { e += B[k] * B[k]; c++; }
    const rmsB = c ? Math.sqrt(e / c) : 0;
    if (!pk) continue;
    const conf = Math.max(0, pk.peak) * Math.min(1, Math.max(0, (pk.psr - 2) / 6)) * Math.min(1, rmsB / (opts.minAccelRms || 0.3));
    windows.push({ tS: ws + win / 2, deltaS: -pk.lag / rate, peak: pk.peak, psr: pk.psr, atEdge: pk.atEdge, conf, accelRms: rmsB });
  }
  const minConf = opts.minConf == null ? 0.05 : opts.minConf;
  const used = windows.filter((w) => w.conf >= minConf && !w.atEdge);
  windows.forEach((w) => { w.used = used.indexOf(w) >= 0; });
  let fit = null;
  if (used.length >= 3) {
    // robust: drop windows > 3 MAD from the median, then weighted line
    const med = S.median(used.map((w) => w.deltaS));
    const mad = S.median(used.map((w) => Math.abs(w.deltaS - med))) || 0.005;
    const keep = used.filter((w) => Math.abs(w.deltaS - med) <= Math.max(3 * 1.4826 * mad, 0.04));
    keep.forEach((w) => (w.inlier = true));
    if (keep.length >= 3) {
      const tr = S.mean(keep.map((w) => w.tS));
      const x = keep.map((w) => w.tS - tr), y = keep.map((w) => w.deltaS), wt = keep.map((w) => w.conf);
      const l = S.weightedLine(x, y, wt);
      const span = Math.max.apply(null, x) - Math.min.apply(null, x);
      // A drift term is only trusted over a long enough span and when it is
      // physically plausible (crystals: tens of ppm); otherwise fit a constant.
      const minSpan = opts.minDriftSpanS || 300;
      const driftOk = span >= minSpan && Math.abs(l.b) < 300e-6;
      if (driftOk) {
        fit = { tRefS: tr, deltaAtRefS: l.a, driftPerS: l.b, driftPpm: l.b * 1e6, residualMs: l.rms * 1000, windowsUsed: keep.length, spanS: span };
      } else {
        const c = S.weightedLine(x.map(() => 0), y, wt);
        fit = { tRefS: tr, deltaAtRefS: c.a, driftPerS: 0, driftPpm: 0, residualMs: c.rms * 1000, windowsUsed: keep.length, spanS: span, constant: true,
          unconstrainedDriftPpm: l.b * 1e6, driftNote: span < minSpan ? 'window span ' + Math.round(span) + ' s < ' + minSpan + ' s: drift not fitted' : 'fitted drift implausible: not used' };
      }
    }
  } else if (used.length) {
    const tr = S.mean(used.map((w) => w.tS));
    used.forEach((w) => (w.inlier = true));
    const wsum = used.reduce((a, w) => a + w.conf, 0);
    const d = used.reduce((a, w) => a + w.conf * w.deltaS, 0) / wsum;
    const rms = Math.sqrt(used.reduce((a, w) => a + w.conf * (w.deltaS - d) * (w.deltaS - d), 0) / wsum);
    fit = { tRefS: tr, deltaAtRefS: d, driftPerS: 0, driftPpm: 0, residualMs: rms * 1000, windowsUsed: used.length, constant: true };
  }
  return { ok: !!fit, global, windows, fit, windowS: win, rate, reason: fit ? null : 'too few confident IMU windows' };
}

function scoreOf(peak, psr) {
  if (!Number.isFinite(peak) || !Number.isFinite(psr)) return 0;
  return Math.max(0, Math.min(1, peak)) * Math.max(0, Math.min(1, (psr - 3) / 7));
}

// Is the MP4 creation time usable as a coarse clock? Unset cameras say 2016-01-01; the camera
// clock is local time labelled UTC, so hours off is normal, but days off means it was never set.
function cameraClock(gopro, volt, monoRef) {
  const c = gopro.chapters && gopro.chapters[0] && gopro.chapters[0].info && gopro.chapters[0].info.creationTime;
  if (!c) return { ok: false, reason: 'none' };
  const ms = c instanceof Date ? c.getTime() : new Date(c).getTime();
  if (!Number.isFinite(ms)) return { ok: false, reason: 'none' };
  const iso = new Date(ms).toISOString().slice(0, 10);
  if (new Date(ms).getUTCFullYear() < 2020) return { ok: false, ms, reason: 'the camera clock says ' + iso + ' (never set)' };
  if (volt.clock) {
    const r0 = monoToUtc(volt.clock, monoRef), r1 = monoToUtc(volt.clock, (volt.stop && volt.stop.mono) || monoRef);
    const off = ms < r0 ? r0 - ms : ms > r1 ? ms - r1 : 0;
    if (off > 2 * 86400000) return { ok: false, ms, reason: 'the camera clock says ' + iso + ', ' + Math.round(off / 86400000) + ' days from the ride' };
  }
  return { ok: true, ms };
}

// Plain words for each signal, for the owner.
const WORDS = { gnss: 'GoPro GPS time', speed: 'GPS speed', bumps: 'bumps', vibration: 'stops and starts', accel: 'speeding up and braking', anchor: 'your start mark' };
function listWords(keys) {
  const w = keys.map((k) => WORDS[k] || k);
  return w.length <= 1 ? w.join('') : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
}

// Main entry. opts: {nudgeMs, speedSearchS, imuSearchS, imu: bool, anchorVideoS}
// anchorVideoS: "I start rolling at this video time": the Volt data's first sustained motion is put
// there, then fine-tuned within +-5 s.
function syncRide(gopro, volt, opts) {
  opts = opts || {};
  const notes = [];
  const monoRef = volt.start && Number.isFinite(volt.start.mono) ? volt.start.mono : volt.clock ? volt.clock.mono0 : 0;
  const gfit = fitGoProClock(gopro.gpsTime);
  let model, method, mode;
  let search = null, anchor = null;
  const stats = {};
  const anchorS = opts.anchorVideoS == null || opts.anchorVideoS === '' ? NaN : Number(opts.anchorVideoS);
  if (Number.isFinite(anchorS)) {
    mode = 'anchor';
    const fm = Q.firstMotion(volt);
    const lead = fm ? (fm.mono - monoRef) / 1000 : 0;
    const start0 = anchorS - lead;
    anchor = { videoS: anchorS, firstMotionMono: fm ? fm.mono : null, firstMotionRideS: fm ? lead : null, source: fm ? fm.source : null, thresholdKmh: fm ? fm.thresholdKmh : null, startS: start0 };
    if (!fm) notes.push('No sustained motion found in the Volt data: your mark is used as the ride start.');
    const win = opts.anchorSearchS || 5;
    search = Q.searchStart(gopro, volt, monoRef, { lo: start0 - win, hi: start0 + win, skip: opts.searchSkip });
    model = makeModel(monoRef, search.ok ? search.best.startS : start0, 1);
    method = search.ok ? 'anchor+search' : 'anchor';
    if (!search.ok) notes.push('Could not fine-tune your mark: ' + search.reason + '.');
  } else if (gfit && volt.clock) {
    mode = 'gnss';
    model = coarseModel(volt, gfit, monoRef);
    method = volt.clock.source === 'gnss' ? 'gnss' : 'gnss-gopro+phone-wall';
    if (!gfit.withFix) notes.push('GoPro GPS never reached a 2D/3D fix; GPSU time is used for the coarse map but GPS speed is unavailable.');
    stats.goproClock = { rmsMs: gfit.rmsMs, madMs: gfit.madMs, n: gfit.n, driftPpm: gfit.driftPpm, withFix: gfit.withFix };
    stats.phoneClock = { source: volt.clock.source, rmsMs: volt.clock.rmsMs, n: volt.clock.n, driftPpm: volt.clock.driftPpm, wallMinusGnssMs: volt.clock.wallMinusGnssMs };
  } else {
    const cam = cameraClock(gopro, volt, monoRef);
    if (cam.reason && cam.reason !== 'none') notes.push('No GoPro GPS time, and ' + cam.reason + ': ignored it and searched the whole ride.');
    else if (!cam.ok) notes.push('No GoPro GPS time and no camera clock: searched the whole ride.');
    search = Q.searchStart(gopro, volt, monoRef, { skip: opts.searchSkip });
    if (search.ok && cam.ok && volt.clock) {
      // A set camera clock (local time labelled UTC) pins the start to within minutes, modulo the
      // time zone: search +-3 min around each zone-shifted reading inside the plausible range, and
      // prefer that unless the whole-ride best is clearly stronger (then the clock is likely wrong
      // and the disagreement check below marks the result low).
      const clockStart = (monoToUtc(volt.clock, monoRef) - cam.ms) / 1000, W = 180;
      let bestW = null;
      for (let k = -15; k <= 15; k++) for (const m of [0, 1800, 2700]) {
        const c = clockStart + k * 3600 + m;
        if (c + W < search.range.loS || c - W > search.range.hiS) continue;
        const w = Q.searchStart(gopro, volt, monoRef, { lo: c - W, hi: c + W, skip: opts.searchSkip, secondInWindow: true });
        if (w.ok && (!bestW || w.best.score > bestW.best.score)) { bestW = w; bestW.clockCentreS = c; }
      }
      if (bestW && bestW.best.score >= 0.67 * search.best.score) {
        stats.clockWindow = { centreS: bestW.clockCentreS, halfWidthS: W, wholeRideBestS: search.best.startS };
        search = bestW;
      }
    }
    if (search.ok) {
      mode = 'search';
      model = makeModel(monoRef, search.best.startS, 1);
      method = 'search';
      if (cam.ok && volt.clock) {
        // the camera clock is often hours off (local time labelled UTC): only a cross-check
        const clockStart = (monoToUtc(volt.clock, monoRef) - cam.ms) / 1000;
        stats.cameraClock = { startS: clockStart, searchMinusClockS: search.best.startS - clockStart };
      }
    } else if (cam.ok && volt.clock) {
      mode = 'clock';
      model = coarseModel(volt, { slope: 1, intercept: cam.ms }, monoRef);
      method = 'clock';
      notes.push('No GoPro GPS time and the search could not run (' + search.reason + '): coarse map from the camera clock, often minutes or hours off.');
    } else {
      mode = 'none';
      model = makeModel(monoRef, 0, 1);
      method = 'none';
      notes.push('No clock information and the search could not run (' + search.reason + '): the ride is placed at video 0:00.');
    }
  }
  const coarse = Object.assign({}, model);
  const coarseSearch = mode === 'gnss' ? 10 : mode === 'search' || mode === 'anchor' ? 3 : 900;

  // Step 1: speed
  const gs = goproSpeed(gopro);
  const vs = voltSpeeds(volt);
  let speed = null;
  const ref = vs.phone || vs.scooter;
  if (gs && ref) {
    const ov = onVideo(model, ref);
    const t0 = Math.max(gs.t[0], ov.t[0]), t1 = Math.min(gs.t[gs.t.length - 1], ov.t[ov.t.length - 1]);
    const search = opts.speedSearchS || coarseSearch;
    speed = xcorrDelta(gs, ov, 10, search, t0 - search, t1 + search);
    if (speed) {
      speed.against = vs.phone ? 'phone-gps' : 'scooter';
      speed.score = scoreOf(speed.peak, speed.psr);
      if (vs.phone && vs.scooter) {
        const o2 = onVideo(model, vs.scooter);
        const s2 = xcorrDelta(gs, o2, 10, search, t0 - search, t1 + search);
        if (s2) speed.scooter = { deltaS: s2.deltaS, peak: s2.peak, psr: s2.psr };
      }
      if (speed.psr > 3 && speed.peak > 0.5 && !speed.atEdge) { model = shiftModel(model, speed.deltaS); method += '+speed'; }
      else notes.push('Speed correlation too weak (PSR ' + speed.psr.toFixed(1) + '); kept the coarse offset.');
    }
  } else if (!gs) notes.push('Speed cross-correlation skipped: no GoPro GPS speed with a fix.');

  // Scooter reporting lag vs phone GPS (both on the Volt clock)
  if (vs.phone && vs.scooter) {
    const t0 = Math.max(vs.phone.t[0], vs.scooter.t[0]) / 1000, t1 = Math.min(vs.phone.t[vs.phone.t.length - 1], vs.scooter.t[vs.scooter.t.length - 1]) / 1000;
    const r = xcorrDelta({ t: vs.phone.t.map((x) => x / 1000), v: vs.phone.v }, { t: vs.scooter.t.map((x) => x / 1000), v: vs.scooter.v }, 10, 3, t0, t1);
    // delta < 0 means the scooter value appears later than phone GPS
    if (r) stats.scooterLag = { lagMs: Math.round(-r.deltaS * 1000), peak: r.peak, psr: r.psr };
  }

  // Step 2: IMU
  let imu = null;
  const haveImu = gopro.accl && gopro.accl.t.length > 100 && volt.motion && volt.motion.t.length > 100;
  if (opts.imu !== false && haveImu) {
    const searchS = opts.imuSearchS || (method.indexOf('speed') >= 0 ? 1.5 : mode === 'search' || mode === 'anchor' ? 2 : coarseSearch);
    imu = imuSync(gopro, volt, model, { searchS, fineS: 1, rate: opts.imuRate || 50, windowS: opts.imuWindowS, minConf: opts.imuMinConf });
    if (imu.ok) {
      const f = imu.fit;
      model = shiftModel(model, f.deltaAtRefS, f.driftPerS, f.tRefS);
      method += '+imu';
    } else if (imu.global && imu.global.psr > 6 && imu.global.peak > 0.2 && !imu.global.atEdge) {
      model = shiftModel(model, imu.global.deltaS);
      method += '+imu-global';
      notes.push('IMU windows too weak for a drift fit; used the global IMU peak.');
    } else notes.push('IMU sync failed: ' + (imu.reason || 'weak peak'));
  } else if (!haveImu) notes.push('IMU sync skipped: phone motion or GoPro ACCL missing.');

  // Confidence
  let confidence = 'low', score = 0, decidedBy = 'clock';
  const imuHigh = !!(imu && imu.ok && imu.fit.windowsUsed >= 5 && imu.fit.residualMs < 40);
  const imuTight = !!(imu && imu.ok && imu.fit.windowsUsed >= 3 && imu.fit.residualMs < 60);
  const agreed = [];
  if (mode === 'gnss') {
    agreed.push('gnss');
    if (imu && imu.ok && imu.fit.windowsUsed >= 5 && imu.fit.residualMs < 40) {
      confidence = 'high'; decidedBy = 'imu';
      score = Math.min(1, imu.fit.windowsUsed / 8) * Math.max(0, 1 - imu.fit.residualMs / 80) * (0.5 + 0.5 * scoreOf(imu.global.peak, imu.global.psr));
    } else if (imu && imu.ok) {
      confidence = 'medium'; decidedBy = 'imu';
      score = 0.5 * Math.min(1, imu.fit.windowsUsed / 5) * Math.max(0, 1 - imu.fit.residualMs / 150);
    } else if (speed && method.indexOf('speed') >= 0) {
      confidence = speed.psr > 3 ? 'medium' : 'low'; decidedBy = 'speed'; score = scoreOf(speed.peak, speed.psr) * 0.7;
    } else if (method.indexOf('imu-global') >= 0) {
      confidence = 'medium'; decidedBy = 'imu-global'; score = scoreOf(imu.global.peak, imu.global.psr) * 0.6;
    } else score = 0.2;
    if (method.indexOf('speed') >= 0) agreed.push('speed');
    if (method.indexOf('imu') >= 0) agreed.push('bumps');
  } else if (mode === 'search' || mode === 'anchor') {
    // each method's own peak must sit near the final placement to count as agreeing
    const startNow = monoToVideo(model, monoRef);
    const votes = [];
    if (search && search.ok) {
      for (const k of Object.keys(search.methods)) {
        const m = search.methods[k], tol = k === 'bumps' ? 0.15 : Q.TOL_S[k];
        m.agrees = m.localPeakS != null && Math.abs(m.localPeakS - startNow) <= tol;
        if (m.agrees) votes.push(k);
      }
    }
    if (method.indexOf('speed') >= 0) votes.push('speed');
    const bumpsOk = votes.indexOf('bumps') >= 0 && imuTight;
    stats.search = search && search.ok ? { ratio: search.ratio, best: search.best, second: search.second, votes, imuTight, imuHigh, minOverlapS: search.minOverlapS } : null;
    decidedBy = imu && imu.ok ? 'imu' : search && search.ok ? 'search' : mode;
    if (mode === 'search') {
      const unique = search.ratio <= 0.75;
      if (unique && imuHigh && bumpsOk && votes.length >= 2) confidence = 'high';
      else if (unique && bumpsOk && votes.length >= 2) confidence = 'medium';
      if (!unique) notes.push('Not sure: another placement ' + Math.round(search.second.startS - startNow) + ' s away fits almost as well (' + Math.round(search.ratio * 100) + ' %).');
      else if (!bumpsOk) notes.push('Not sure: the bumps do not confirm this placement.');
      else if (votes.length < 2) notes.push('Not sure: only one signal supports this placement.');
      score = Math.max(0, Math.min(1, (0.85 - search.ratio) / 0.35)) * (bumpsOk ? 1 : 0.4) * Math.min(1, votes.length / 3);
      if (stats.cameraClock) {
        // A camera clock set from the phone app is right to within seconds, but it is local time
        // labelled UTC, so allow whole-hour zones (and :30 / :45 ones). Two similar rides back to
        // back can line up without any clock (an owner pairing did, 3 signals agreeing), so a
        // clear disagreement means "probably the wrong ride or video": never better than low.
        const d = startNow - stats.cameraClock.startS;
        const resid = Math.min.apply(null, [0, 1800, 2700].map((m) => { const x = (d - m) / 3600; return Math.abs(x - Math.round(x)) * 3600; }));
        stats.cameraClock.residualS = Math.round(resid);
        if (resid > 180) {
          confidence = 'low'; score = Math.min(score, 0.1);
          notes.push('The camera clock disagrees by about ' + Math.round(resid / 60) + ' min: is this the right ride for this video? If the camera clock was wrong, check the placement and nudge.');
        } else notes.push('The camera clock agrees' + (Math.abs(d) > 1800 ? ' (after a ' + Math.round(d / 3600) + ' h time-zone difference)' : '') + '.');
      }
    } else {
      votes.push('anchor');
      const edge = search && search.ok && search.atWindowEdge;
      if (bumpsOk && imuHigh && !edge && votes.length >= 3) confidence = 'high';
      else if (bumpsOk && !edge) confidence = 'medium';
      if (!bumpsOk || edge) notes.push('The bumps do not confirm your start mark within ' + (opts.anchorSearchS || 5) + ' s: check it and nudge if needed.');
      if (search && search.ok && search.outside && search.outside.score > 1.25 * search.best.score) notes.push('The automatic search prefers ' + search.outside.startS.toFixed(1) + ' s for the ride start (Volt START), ' + Math.abs(search.outside.startS - anchor.startS).toFixed(0) + ' s ' + (search.outside.startS > anchor.startS ? 'later' : 'earlier') + ' than your mark puts it.');
      score = (bumpsOk ? 0.6 : 0.15) + (imuHigh ? 0.3 : 0) + (edge ? -0.1 : 0);
    }
    for (const k of votes) if (agreed.indexOf(k) < 0) agreed.push(k);
    if (mode === 'anchor' && confidence === 'low') {
      // not confirmed: keep the owner's mark exactly, so a nudge starts from what they chose
      model = makeModel(monoRef, anchor.startS, 1);
      method = 'anchor';
      agreed.length = 0; agreed.push('anchor');
      decidedBy = 'anchor';
    }
  } else {
    // clock-only or nothing: never better than low
    if (mode === 'clock') agreed.push('clock');
    score = 0.05;
  }
  score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;

  // plain-language summary for the owner
  const why = mode === 'gnss' ? '' : mode === 'anchor' ? '' : ' (GoPro had no GPS)';
  let summary;
  const ag = agreed.filter((k) => k !== 'gnss' && k !== 'anchor' && k !== 'clock');
  if (mode === 'gnss') summary = 'Synced from the GoPro’s GPS time' + (ag.length ? ', fine-tuned on ' + listWords(ag) : '') + '.';
  else if (mode === 'anchor') summary = confidence === 'low' ? 'Using your start mark as you set it; the bumps could not confirm it. Check it and nudge if needed.' : 'Synced from your start mark, fine-tuned on ' + listWords(ag.length ? ag : ['bumps']) + '.';
  else if (mode === 'search') summary = confidence === 'low' ? 'Best guess only' + why + ': check it and nudge, or mark when you start rolling.' : 'Synced from ' + listWords(ag) + why + '.';
  else if (mode === 'clock') summary = 'Rough guess from the camera clock' + why + ': check it and nudge, or mark when you start rolling.';
  else summary = 'Could not sync: mark when you start rolling, or nudge by hand.';

  const nudgeMs = opts.nudgeMs || 0;
  const final = shiftModel(model, nudgeMs / 1000);
  const rideStartVideoS = monoToVideo(final, monoRef);
  const out = {
    model: 'linear',
    monoRefMs: final.monoRefMs,
    videoAtRefS: final.videoAtRefS,
    slope: final.slope,
    d0_ms: Math.round(rideStartVideoS * 1000 * 10) / 10,
    d1_ppm: Math.round((final.slope - 1) * 1e6 * 100) / 100,
    method,
    mode,
    confidence,
    score,
    decidedBy,
    agreed,
    summary,
    nudge_ms: nudgeMs,
    rideStartVideoS,
    coarse: { videoAtRefS: coarse.videoAtRefS, slope: coarse.slope, rideStartVideoS: monoToVideo(coarse, monoRef) },
    correctionFromCoarseMs: Math.round((monoToVideo(model, monoRef) - monoToVideo(coarse, monoRef)) * 1000),
    stats,
    notes,
    anchor,
    search: search && search.ok ? { best: search.best, second: search.second, ratio: search.ratio, methods: search.methods, range: search.range, minOverlapS: search.minOverlapS, outside: search.outside, atWindowEdge: search.atWindowEdge } : search ? { ok: false, reason: search.reason } : null,
    speed: speed ? { against: speed.against, deltaS: speed.deltaS, peak: speed.peak, psr: speed.psr, second: speed.second, score: speed.score, scooter: speed.scooter, curve: speed.curve } : null,
    imu: imu ? { ok: imu.ok, reason: imu.reason, global: imu.global, windows: imu.windows, fit: imu.fit, windowS: imu.windowS } : null,
  };
  const dec = decidedBy === 'speed' ? speed : decidedBy.indexOf('imu') === 0 && imu ? imu.global : null;
  out.peak = dec ? { value: dec.peak, psr: dec.psr, secondBest: dec.second, secondToBestRatio: dec.second ? dec.second.peak / dec.peak : null } : null;
  if (search && search.ok && (mode === 'search' || mode === 'anchor')) out.peak = Object.assign(out.peak || {}, { search: { score: search.best.score, second: search.second, ratio: search.ratio } });
  return out;
}

function modelOf(sync) { return makeModel(sync.monoRefMs, sync.videoAtRefS, sync.slope); }

module.exports = { syncRide, cameraClock, fitGoProClock, coarseModel, monoToVideo, videoToMono, makeModel, shiftModel, modelOf, xcorrDelta, imuSync, accelFeature, goproSpeed, voltSpeeds, grid };
