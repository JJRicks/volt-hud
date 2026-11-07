'use strict';
// ride.volthud.json timeline + style -> HUD build spec for the ExtendScript comp builder
// (ae/jsx/build-comp.jsx). All data logic lives here (tested in Node); the builder only
// creates layers, bakes the given keys and writes the given expressions.

const B = require('./bake');
const { TOKENS, hexToRgb, accentRamp, normalizeStyle } = require('./style');
const { layoutWidgets } = require('./layout');

const KMH_TO_MPH = 0.621371192;
const FONTS = { regular: 'SairaHUD-Regular', medium: 'SairaHUD-Medium', semibold: 'SairaHUD-SemiBold', bold: 'SairaHUD-Bold' };

// Minutes east of UTC for an IANA zone at a moment; falls back to this machine's zone.
function tzOffsetMin(tz, utcMs) {
  if (tz) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p = {};
      for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
    } catch (e) { /* unknown zone: fall through */ }
  }
  return -new Date(utcMs).getTimezoneOffset();
}
function localZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } }

function chan(arr, rate, o) {
  o = o || {};
  const valid = arr.some(B.isNum);
  const out = { hold: !!o.hold, ok: B.okKeys(arr, rate), valid };
  if (!valid) { out.keys = { t: [0], v: [0] }; out.ok = { t: [0], v: [0] }; return out; }
  out.keys = o.hold ? B.steps(arr, rate, o.digits) : B.roundKeys(B.decimate(arr, rate, o.tol, o.maxSeg), o.digits == null ? 3 : o.digits);
  return out;
}

function firstValid(a) { for (let i = 0; i < a.length; i++) if (B.isNum(a[i])) return i; return -1; }
function lastValid(a) { for (let i = a.length - 1; i >= 0; i--) if (B.isNum(a[i])) return i; return -1; }

function buildHudSpec(tl, styleIn, opts) {
  opts = opts || {};
  if (!tl || tl.format !== 'volthud-timeline') throw new Error('not a volthud timeline');
  const style = normalizeStyle(Object.assign({}, tl.style || {}, styleIn || {}));
  const rate = tl.rateHz, n = tl.samples, ch = tl.channels;
  const fps = tl.video.fps;
  const frames = Math.max(1, Math.round(tl.video.durationS * fps));
  const imperial = style.units === 'imperial';
  const kSpeed = imperial ? KMH_TO_MPH : 1;
  const warnings = [];
  const nul = () => new Array(n).fill(null);
  const get = (k) => (Array.isArray(ch[k]) && ch[k].length === n ? ch[k] : nul());

  // ---- channels (display units where the expression only formats) ----
  const speedDisp = B.mapN(get('speedKmh'), (x) => x * kSpeed);
  const spd = B.maN(speedDisp, Math.round(0.25 * rate)); // 0.5 s centred
  const ring = B.springN(spd, 8, rate);
  const pw = get('powerW');
  const dir = get('powerDir');
  const pwDraw = Array.from(pw, (x, i) => (B.isNum(x) && dir[i] !== 0 && x > 0 ? x : null));
  const pwpk = B.runningMax(pwDraw);
  const vrt = B.mapN(get('vertMps'), (x) => (Math.abs(x) < 0.1 ? 0 : x));
  const jrk = B.easeN(B.mapN(get('jerk'), (x) => Math.min(Math.max(x, 0), 6)), 0.3, rate);
  const utc = get('utcMs');
  const i0 = firstValid(utc);
  const tz = style.tz || tl.tz || opts.tz || localZone();
  let clk = nul(), baseDayMs = 0, tzOff = 0;
  if (i0 >= 0) {
    tzOff = tzOffsetMin(tz, utc[i0]);
    const local0 = utc[i0] + tzOff * 60000;
    baseDayMs = Math.floor(local0 / 86400000) * 86400000;
    clk = B.mapN(utc, (x) => (x + tzOff * 60000 - baseDayMs) / 1000);
  }
  // trip distance (cumulative), max speed so far
  const kmh = get('speedKmh');
  const fs0 = firstValid(kmh);
  const trip = nul();
  let acc = 0;
  for (let i = 0; i < n; i++) { if (B.isNum(kmh[i])) acc += kmh[i] / 3.6 / rate / 1000; if (fs0 >= 0 && i >= fs0) trip[i] = acc * (imperial ? KMH_TO_MPH : 1); }
  const vmax = B.runningMax(B.mapN(spd, (x) => Math.round(x)));
  for (let i = 0; i < n; i++) if (trip[i] === null) vmax[i] = null;

  const C = {
    spd: chan(spd, rate, { tol: 0.05, digits: 2 }),
    ring: chan(ring, rate, { tol: 0.1, digits: 2 }),
    pw: chan(pw, rate, { tol: 3, digits: 1 }),
    pwdir: chan(B.mapN(dir, (x) => x), rate, { hold: true, digits: 0 }),
    pwpk: chan(pwpk, rate, { hold: true, digits: 0 }),
    bat: chan(get('batteryPct'), rate, { hold: true, digits: 0 }),
    vrt: chan(vrt, rate, { tol: 0.005, digits: 3 }),
    grd: chan(get('gradePct'), rate, { tol: 0.2, digits: 1 }),
    glon: chan(get('gLon'), rate, { tol: 0.003, digits: 3 }),
    glat: chan(get('gLat'), rate, { tol: 0.003, digits: 3 }),
    gtot: chan(get('gTotal'), rate, { tol: 0.003, digits: 3 }),
    jrk: chan(jrk, rate, { tol: 0.03, digits: 2 }),
    clk: chan(clk, rate, { tol: 0.02, digits: 3, maxSeg: 100000 }),
    trip: chan(trip, rate, { tol: 0.002, digits: 4 }),
    vmax: chan(vmax, rate, { hold: true, digits: 0 }),
  };

  // ---- optional coordinates / mini-map (privacy: only with the explicit opt-in) ----
  const hasCoords = Array.isArray(ch.lat) && ch.lat.length === n && ch.lat.some(B.isNum);
  let mapPath = null;
  if ((style.widgets.coords || style.widgets.map) && !hasCoords) warnings.push('Coordinates are on, but the timeline has no lat/lon (rebuild it with coordinates enabled). Those widgets show [no data].');
  if (style.widgets.coords) {
    C.lat = chan(hasCoords ? ch.lat : nul(), rate, { tol: 0.000002, digits: 6 });
    C.lon = chan(hasCoords ? ch.lon : nul(), rate, { tol: 0.000002, digits: 6 });
  }
  if (style.widgets.map) {
    const mx = nul(), my = nul(), mp = nul();
    if (hasCoords) {
      const lat = ch.lat, lon = ch.lon;
      const idx = []; for (let i = 0; i < n; i++) if (B.isNum(lat[i]) && B.isNum(lon[i])) idx.push(i);
      let la0 = 0; idx.forEach((i) => { la0 += lat[i]; }); la0 /= idx.length;
      const kx = 111320 * Math.cos((la0 * Math.PI) / 180), ky = 110540;
      const P = idx.map((i) => [lon[i] * kx, -lat[i] * ky]); // metres, y down
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      P.forEach((p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
      const pad = 24, box = 300 - 2 * pad;
      const sc = box / Math.max(x1 - x0, y1 - y0, 1);
      const ox = pad + (box - (x1 - x0) * sc) / 2, oy = pad + (box - (y1 - y0) * sc) / 2;
      const toBox = (p) => [ox + (p[0] - x0) * sc, oy + (p[1] - y0) * sc];
      const simp = B.simplify(P, 2).map(toBox);
      mapPath = simp.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
      // progress = arc length along the simplified path of the nearest point (monotone)
      const cum = [0]; for (let k = 1; k < simp.length; k++) cum.push(cum[k - 1] + Math.hypot(simp[k][0] - simp[k - 1][0], simp[k][1] - simp[k - 1][1]));
      const total = cum[cum.length - 1] || 1;
      let seg = 0;
      for (const i of idx) {
        const q = toBox([lon[i] * kx, -lat[i] * ky]);
        let best = Infinity, bestS = cum[seg];
        for (let k = seg; k < Math.min(simp.length - 1, seg + 40); k++) {
          const a = simp[k], b = simp[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
          const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
          const d = Math.hypot(a[0] + u * dx - q[0], a[1] + u * dy - q[1]);
          if (d < best) { best = d; bestS = cum[k] + u * Math.sqrt(L2); if (k > seg) seg = k; }
        }
        mx[i] = q[0]; my[i] = q[1]; mp[i] = (100 * bestS) / total;
      }
    }
    C.mapx = chan(mx, rate, { tol: 0.3, digits: 1 });
    C.mapy = chan(my, rate, { tol: 0.3, digits: 1 });
    C.mapp = chan(B.runningMax(mp), rate, { tol: 0.05, digits: 2 });
  }

  // ---- widget parameters ----
  let maxSpd = 0, peak = 0, low = 0;
  for (let i = 0; i < n; i++) {
    if (B.isNum(spd[i]) && spd[i] > maxSpd) maxSpd = spd[i];
    if (B.isNum(pw[i]) && dir[i] !== 0) { if (pw[i] > peak) peak = pw[i]; if (pw[i] < low) low = pw[i]; }
  }
  const step = 250;
  const scaleDraw = Math.min(6000, Math.max(1000, Math.ceil(peak / step) * step));
  const scaleRegen = Math.min(3000, Math.max(500, Math.ceil(-low / step) * step));
  const tickEvery = scaleDraw > 3000 ? 1000 : 500;
  const ticksDraw = []; for (let w = tickEvery; w < scaleDraw; w += tickEvery) ticksDraw.push(w);
  const ride = tl.ride || {};
  const rideStart = B.isNum(ride.videoStartS) ? ride.videoStartS : fs0 >= 0 ? fs0 / rate : 0;
  const rideEnd = B.isNum(ride.videoEndS) ? ride.videoEndS : lastValid(kmh) >= 0 ? lastValid(kmh) / rate : tl.video.durationS;
  const lay = layoutWidgets(style);
  const P = {
    speed: { unit: imperial ? 'mph' : 'km/h', ringMax: Math.max(30, Math.ceil(maxSpd / 10) * 10) },
    power: { scaleDraw, scaleRegen, ticksDraw, ticksRegen: scaleRegen > 500 ? [500] : [] },
    battery: {},
    vertical: { unit: style.vertUnit },
    gmeter: { unit: style.gUnit, pxPerG: 220, trailS: 1.5 },
    jerk: { max: 3 },
    clock: { clock24: style.clock24, baseDayMs, tz, tzOffsetMin: tzOff },
    stats: { distUnit: imperial ? 'mi' : 'km', speedUnit: imperial ? 'mph' : 'km/h', rideStart: Math.round(rideStart * 1000) / 1000, rideEnd: Math.round(rideEnd * 1000) / 1000 },
    coords: {},
    map: { path: mapPath },
  };
  const widgets = Object.keys(lay.widgets).map((id) => Object.assign({ id }, lay.widgets[id], { p: P[id] }));

  const col = {};
  for (const k in TOKENS) col[k] = hexToRgb(TOKENS[k]);
  const ramp = accentRamp(style.accent);
  col.accent = ramp.accent; col.accentDeep = ramp.deep; col.accentHi = ramp.hi;
  // labels drawn straight over video (not on a plate) sit between muted and text, for contrast
  col.label = col.muted.map((x, i) => Math.round((x + (col.text[i] - x) * 0.45) * 1000) / 1000);

  const base = (tl.video.files && tl.video.files[0] ? String(tl.video.files[0]).replace(/\.[^.]+$/, '') : 'ride');
  let keys = 0; for (const k in C) keys += C[k].keys.t.length + (C[k].ok ? C[k].ok.t.length : 0);
  return {
    format: 'volthud-hudspec', version: 1,
    comp: { name: style.compName || 'Volt HUD ' + base, width: style.comp[0], height: style.comp[1], fps, frames, durationS: tl.video.durationS },
    style, colors: col, fonts: FONTS, plate: style.plate, safe: lay.safe,
    rateHz: rate, channels: C, widgets, warnings, keyCount: keys,
    source: { files: tl.video.files, rideStartVideoS: ride.videoStartS, sync: tl.sync ? { confidence: tl.sync.confidence, nudge_ms: tl.sync.nudge_ms, method: tl.sync.method } : null },
  };
}

module.exports = { buildHudSpec, tzOffsetMin, FONTS, KMH_TO_MPH };
