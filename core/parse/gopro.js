'use strict';
// GoPro .360/.MP4 telemetry: moov reader -> gopro-telemetry, chapters merged
// onto one video timeline (seconds from the first chapter's frame 0).

const path = require('path');
const { readGpmd } = require('./mp4-moov');

let goproTelemetry = null;
function gt() {
  if (!goproTelemetry) goproTelemetry = require('gopro-telemetry');
  return goproTelemetry;
}

// GoPro chapter names: GS01xxxx.360 / GX01xxxx.MP4 / GH01xxxx.MP4 (chapter = 2 digits, file = 4 digits).
function chapterKey(p) {
  const m = /^G[A-Z](\d{2})(\d{4})\./i.exec(path.basename(p));
  return m ? { file: m[2], chapter: Number(m[1]) } : { file: path.basename(p), chapter: 0 };
}

function sortChapters(paths) {
  const list = paths.map((p) => ({ p, k: chapterKey(p) }));
  const files = new Set(list.map((x) => x.k.file));
  list.sort((a, b) => (a.k.file < b.k.file ? -1 : a.k.file > b.k.file ? 1 : a.k.chapter - b.k.chapter));
  return { paths: list.map((x) => x.p), mixed: files.size > 1 };
}

// --- tiny KLV walker for per-payload GPS time and fix (independent of gopro-telemetry) ---
const TYPE_SIZE = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4, Q: 8, U: 16, F: 4, G: 16 };

function* klv(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const key = buf.toString('latin1', p, p + 4);
    const type = String.fromCharCode(buf[p + 4]);
    const size = buf[p + 5];
    const repeat = buf.readUInt16BE(p + 6);
    const len = size * repeat;
    const dataStart = p + 8;
    if (dataStart + len > end) return;
    yield { key, type, size, repeat, start: dataStart, len };
    p = dataStart + ((len + 3) & ~3);
  }
}

function readNum(buf, off, type) {
  switch (type) {
    case 'b': return buf.readInt8(off);
    case 'B': return buf.readUInt8(off);
    case 's': return buf.readInt16BE(off);
    case 'S': return buf.readUInt16BE(off);
    case 'l': return buf.readInt32BE(off);
    case 'L': return buf.readUInt32BE(off);
    case 'f': return buf.readFloatBE(off);
    case 'd': return buf.readDoubleBE(off);
    case 'J': return buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
    default: return NaN;
  }
}

function gpsuToMs(s) {
  // yymmddhhmmss.sss
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?/.exec(s);
  if (!m) return NaN;
  return Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Math.round(parseFloat(m[7] || '0') * 1000);
}

// For each payload: {GPSU ms, GPSF, GPSP, gps5Count, gps9: [{utcMs, fix, dop}]}.
function scanGpsMeta(rawData, timing) {
  const out = [];
  let p = 0;
  for (let i = 0; i < timing.samples.length; i++) {
    const size = timing._sizes ? timing._sizes[i] : null;
    const end = size != null ? p + size : rawData.length;
    const rec = { i, cts: timing.samples[i].cts, gpsu: NaN, gpsf: NaN, gpsp: NaN, gps5: 0, gps9: [] };
    for (const devc of klv(rawData, p, end)) {
      if (devc.key !== 'DEVC') continue;
      for (const strm of klv(rawData, devc.start, devc.start + devc.len)) {
        if (strm.key !== 'STRM') continue;
        let scal = null;
        for (const e of klv(rawData, strm.start, strm.start + strm.len)) {
          if (e.key === 'GPSU' && e.type === 'U') rec.gpsu = gpsuToMs(rawData.toString('latin1', e.start, e.start + 16));
          else if (e.key === 'GPSF') rec.gpsf = readNum(rawData, e.start, e.type);
          else if (e.key === 'GPSP') rec.gpsp = readNum(rawData, e.start, e.type);
          else if (e.key === 'GPS5') rec.gps5 = e.repeat;
          else if (e.key === 'SCAL') {
            const ts = TYPE_SIZE[e.type] || 4;
            scal = [];
            for (let k = 0; k < (e.size * e.repeat) / ts; k++) scal.push(readNum(rawData, e.start + k * ts, e.type));
          } else if (e.key === 'GPS9' && e.type === '?') {
            // GPS9 is a complex type (lllllllSS); fields 6,7 = days since 2000, ms since midnight; 8 = DOP; 9 = fix
            for (let r = 0; r < e.repeat; r++) {
              const o = e.start + r * e.size;
              const days = rawData.readInt32BE(o + 20), msec = rawData.readInt32BE(o + 24);
              const dop = rawData.readUInt16BE(o + 28), fix = rawData.readUInt16BE(o + 30);
              const s5 = scal && scal.length > 5 ? scal[5] : 1, s6 = scal && scal.length > 6 ? scal[6] : 1000;
              const s7 = scal && scal.length > 7 ? scal[7] : 100;
              rec.gps9.push({ utcMs: Date.UTC(2000, 0, 1) + (days / s5) * 86400000 + (msec / s6) * 1000, dop: dop / s7, fix });
            }
          }
        }
      }
    }
    out.push(rec);
    p = end;
  }
  return out;
}

function toArrays(samples, nAxes) {
  const n = samples.length;
  const t = new Float64Array(n);
  const ax = [];
  for (let k = 0; k < nAxes; k++) ax.push(new Float64Array(n));
  for (let i = 0; i < n; i++) {
    t[i] = samples[i].cts / 1000;
    const v = samples[i].value;
    for (let k = 0; k < nAxes; k++) ax[k][i] = Array.isArray(v) ? v[k] : v;
  }
  return { t, ax };
}

// A camera that never got a GPS lock can write empty samples among its 0,0 rows.
function gpsSamples(samples) { return samples.filter((s) => Array.isArray(s.value)); }

function concatF64(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Load one or more chapters. opts.gyro: also read GYRO (large: ~800 Hz on MAX).
async function loadGoPro(paths, opts) {
  opts = opts || {};
  const sorted = sortChapters([].concat(paths));
  const chapters = [];
  const acc = { gps: [], accl: [], gyro: [], grav: [], gpsTime: [] };
  let offsetS = 0;
  let device = null;
  let gpsSrc = null;
  for (const p of sorted.paths) {
    const r = readGpmd(p);
    r.timing._sizes = null;
    // sample sizes for the KLV scan: recover from the concatenated layout
    const meta = scanGpsMetaFromParts(r);
    const streams = ['GPS5', 'GPS9', 'ACCL', 'GRAV'];
    if (opts.gyro) streams.push('GYRO');
    const res = await gt()({ rawData: r.rawData, timing: r.timing }, { stream: streams, repeatSticky: true, ellipsoid: true, tolerant: true });
    const dev = Object.keys(res)[0];
    const d = dev ? res[dev] : { streams: {} };
    device = device || d['device name'] || null;
    const st = d.streams || {};
    const summary = {};
    for (const k in st) summary[k] = { name: st[k].name, units: st[k].units, samples: st[k].samples.length };
    chapters.push({ file: path.basename(p), offsetS, durationS: r.info.videoDurationS, fps: r.info.fps, info: r.info, streams: summary, gpsMeta: summariseGpsMeta(meta) });

    const shift = (a) => { for (let i = 0; i < a.length; i++) a[i] += offsetS; return a; };
    const g = st.GPS9 || st.GPS5;
    const gs = g ? gpsSamples(g.samples) : [];
    if (gs.length) {
      gpsSrc = gpsSrc || (st.GPS9 ? 'GPS9' : 'GPS5');
      const isG9 = !!st.GPS9;
      const n = gs.length;
      const t = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n), alt = new Float64Array(n), s2 = new Float64Array(n), s3 = new Float64Array(n), fix = new Float64Array(n), dop = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const s = gs[i], v = s.value;
        t[i] = s.cts / 1000 + offsetS; lat[i] = v[0]; lon[i] = v[1]; alt[i] = v[2]; s2[i] = v[3]; s3[i] = v[4];
        if (isG9) { dop[i] = v[7]; fix[i] = v[8]; } else { fix[i] = s.fix != null ? s.fix : NaN; dop[i] = s.precision != null ? s.precision / 100 : NaN; }
      }
      acc.gps.push({ t, lat, lon, alt, s2, s3, fix, dop });
    }
    for (const [key, name] of [['ACCL', 'accl'], ['GRAV', 'grav'], ['GYRO', 'gyro']]) {
      if (!st[key]) continue;
      const a = toArrays(st[key].samples, 3);
      shift(a.t);
      acc[name].push(a);
    }
    // GPS time pairs (video seconds, UTC ms) for the clock fit
    const gtp = { t: [], utc: [], fix: [], dop: [] };
    for (const m of meta) {
      if (m.gps9.length) {
        // GPS9: per-sample UTC; spread across the payload like gopro-telemetry does
        const dur = r.timing.samples[m.i].duration;
        m.gps9.forEach((s, k) => { gtp.t.push((m.cts + (dur * k) / m.gps9.length) / 1000 + offsetS); gtp.utc.push(s.utcMs); gtp.fix.push(s.fix); gtp.dop.push(s.dop); });
      } else if (Number.isFinite(m.gpsu)) {
        gtp.t.push(m.cts / 1000 + offsetS); gtp.utc.push(m.gpsu); gtp.fix.push(m.gpsf); gtp.dop.push(m.gpsp / 100);
      }
    }
    acc.gpsTime.push(gtp);
    offsetS += r.info.videoDurationS;
  }

  const join3 = (list) => (list.length ? { t: concatF64(list.map((a) => a.t)), x: concatF64(list.map((a) => a.ax[0])), y: concatF64(list.map((a) => a.ax[1])), z: concatF64(list.map((a) => a.ax[2])) } : null);
  const gps = acc.gps.length ? ['t', 'lat', 'lon', 'alt', 's2', 's3', 'fix', 'dop'].reduce((o, k) => { o[k] = concatF64(acc.gps.map((g) => g[k])); return o; }, {}) : null;
  if (gps) gps.src = gpsSrc;
  const gpsTime = { t: [], utc: [], fix: [], dop: [] };
  for (const g of acc.gpsTime) for (const k in gpsTime) gpsTime[k].push.apply(gpsTime[k], g[k]);
  return {
    device,
    chapters,
    mixedFileNumbers: sorted.mixed,
    durationS: offsetS,
    fps: chapters.length ? chapters[0].fps : null,
    gps,
    gpsTime,
    accl: join3(acc.accl),
    grav: join3(acc.grav),
    gyro: join3(acc.gyro),
  };
}

// The moov reader concatenates samples; recover their sizes from the payload
// structure (each gpmd sample is one or more whole DEVC boxes).
function scanGpsMetaFromParts(r) {
  const sizes = r.info.sampleSizes;
  if (sizes) r.timing._sizes = sizes;
  const meta = scanGpsMeta(r.rawData, r.timing);
  delete r.timing._sizes;
  return meta;
}

function summariseGpsMeta(meta) {
  const fix = {};
  let n = 0, utc0 = NaN, utc1 = NaN, dopGood = 0;
  for (const m of meta) {
    const list = m.gps9.length ? m.gps9.map((s) => ({ utc: s.utcMs, fix: s.fix, dop: s.dop })) : [{ utc: m.gpsu, fix: m.gpsf, dop: m.gpsp / 100 }];
    for (const s of list) {
      if (!Number.isFinite(s.utc)) continue;
      n++;
      if (!(utc0 <= s.utc)) utc0 = s.utc;
      if (!(utc1 >= s.utc)) utc1 = s.utc;
      fix[s.fix] = (fix[s.fix] || 0) + 1;
      if (s.fix >= 2 && s.dop < 5) dopGood++;
    }
  }
  return { timeSamples: n, utcStart: Number.isFinite(utc0) ? new Date(utc0).toISOString() : null, utcEnd: Number.isFinite(utc1) ? new Date(utc1).toISOString() : null, fixHistogram: fix, goodFixSamples: dopGood };
}

module.exports = { loadGoPro, sortChapters, chapterKey, scanGpsMeta, gpsuToMs, klv, gpsSamples };
