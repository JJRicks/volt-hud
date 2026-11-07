'use strict';
// Synthetic fixtures (no private ride data): a GPMF payload builder, a tiny
// MP4 writer with a gpmd track, and a synthetic ride (GoPro + Volt exports)
// with a known offset and drift.

// ---------- GPMF KLV ----------
function klv(key, type, size, repeat, data) {
  const len = size * repeat;
  const pad = (4 - (len % 4)) % 4;
  const b = Buffer.alloc(8 + len + pad);
  b.write(key, 0, 'latin1');
  b[4] = type === null ? 0 : type.charCodeAt(0);
  b[5] = size;
  b.writeUInt16BE(repeat, 6);
  data.copy(b, 8);
  return b;
}
function nest(key, parts) { const d = Buffer.concat(parts); return klv(key, null, 1, d.length, d); }
function str(key, s) { return klv(key, 'c', 1, s.length, Buffer.from(s, 'latin1')); }
function i16s(key, rows) {
  const w = rows[0].length;
  const d = Buffer.alloc(rows.length * w * 2);
  rows.forEach((r, i) => r.forEach((v, k) => d.writeInt16BE(Math.round(v), (i * w + k) * 2)));
  return klv(key, 's', w * 2, rows.length, d);
}
function i32s(key, rows) {
  const w = rows[0].length;
  const d = Buffer.alloc(rows.length * w * 4);
  rows.forEach((r, i) => r.forEach((v, k) => d.writeInt32BE(Math.round(v), (i * w + k) * 4)));
  return klv(key, 'l', w * 4, rows.length, d);
}
function u32(key, v) { const d = Buffer.alloc(4); d.writeUInt32BE(v); return klv(key, 'L', 4, 1, d); }
function u16(key, v) { const d = Buffer.alloc(2); d.writeUInt16BE(v); return klv(key, 'S', 2, 1, d); }
function gpsu(ms) {
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w, '0');
  const s = p(d.getUTCFullYear() % 100, 2) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) + p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2) + '.' + p(d.getUTCMilliseconds(), 3);
  return klv('GPSU', 'U', 16, 1, Buffer.from(s, 'latin1'));
}

// One 1 s payload: ACCL rows (m/s^2, scale 100) and GPS5 rows ([lat, lon, alt, s2, s3]).
function gpmfPayload(opts) {
  const strms = [];
  if (opts.accl) {
    strms.push(nest('STRM', [u32('TSMP', opts.acclTsmp || 0), str('STNM', 'Accelerometer'), str('SIUN', 'm/s2'), i16s('SCAL', [[100]]), i16s('ACCL', opts.accl.map((r) => r.map((v) => v * 100)))]));
  }
  if (opts.gps5) {
    const scal = [10000000, 10000000, 1000, 1000, 100];
    strms.push(nest('STRM', [u32('TSMP', opts.gpsTsmp || 0), str('STNM', 'GPS (Lat., Long., Alt., 2D speed, 3D speed)'), u32('GPSF', opts.fix == null ? 3 : opts.fix), gpsu(opts.gpsuMs), u16('GPSP', opts.gpsp == null ? 150 : opts.gpsp),
      str('UNIT', 'degdegm\u0000m/sm/s'), i32s('SCAL', [scal]), i32s('GPS5', opts.gps5.map((r) => r.map((v, k) => v * scal[k])))]));
  }
  return nest('DEVC', [u32('DVID', 1), str('DVNM', opts.name || 'GoPro Max')].concat(strms));
}

// ---------- MP4 writer ----------
function box(type, ...parts) {
  const d = Buffer.concat(parts);
  const b = Buffer.alloc(8);
  b.writeUInt32BE(8 + d.length);
  b.write(type, 4, 'latin1');
  return Buffer.concat([b, d]);
}
function full(type, version, flags, ...parts) {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(((version & 255) << 24) | (flags & 0xffffff));
  return box(type, h, ...parts);
}
function u32b(...vals) { const b = Buffer.alloc(4 * vals.length); vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; }
function u64b(v) { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(v / 4294967296)); b.writeUInt32BE(v % 4294967296, 4); return b; }

function trak(id, handler, name, codec, timescale, sampleDur, sizes, chunkOffsets, perChunk, use64) {
  const dur = sampleDur * sizes.length;
  const tkhd = full('tkhd', 0, 7, u32b(0, 0, id, 0, dur), Buffer.alloc(60));
  const mdhd = full('mdhd', 0, 0, u32b(0, 0, timescale, dur), Buffer.from([0x55, 0xc4, 0, 0]));
  const hdlr = full('hdlr', 0, 0, u32b(0), Buffer.from(handler, 'latin1'), u32b(0, 0, 0), Buffer.from(name + '\u0000', 'latin1'));
  const entry = box(codec, Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(codec === 'gpmd' ? 0 : 70));
  const stsd = full('stsd', 0, 0, u32b(1), entry);
  const stts = full('stts', 0, 0, u32b(1, sizes.length, sampleDur));
  const stsz = full('stsz', 0, 0, u32b(0, sizes.length, ...sizes));
  // perChunk: array of [firstChunk, samplesPerChunk]
  const stsc = full('stsc', 0, 0, u32b(perChunk.length), ...perChunk.map((p) => u32b(p[0], p[1], 1)));
  const co = use64 ? full('co64', 0, 0, u32b(chunkOffsets.length), ...chunkOffsets.map(u64b)) : full('stco', 0, 0, u32b(chunkOffsets.length, ...chunkOffsets));
  const stbl = box('stbl', stsd, stts, stsz, stsc, co);
  const minf = box('minf', stbl);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

// payloads: Buffers (one gpmd sample each). Writes: ftyp, mdat (video dummy
// frames interleaved with gpmd chunks of two samples), moov at the end.
function makeMp4(payloads, opts) {
  opts = opts || {};
  const fps = 30000 / 1001;
  const frames = Math.round(payloads.length * fps);
  const ftyp = box('ftyp', Buffer.from('mp41', 'latin1'), u32b(0), Buffer.from('mp41', 'latin1'));
  const chunks = [];
  let pos = ftyp.length + 8;
  const vSizes = [], vOffsets = [], gOffsets = [];
  const gSizes = payloads.map((p) => p.length);
  for (let i = 0; i < frames; i++) {
    const fr = Buffer.alloc(16, i & 255);
    vSizes.push(fr.length); vOffsets.push(pos); chunks.push(fr); pos += fr.length;
    // after every 60 frames, write a gpmd chunk of up to 2 samples
    if (i % 60 === 59 || i === frames - 1) {
      const k = gOffsets.length * 2;
      if (k < payloads.length) {
        gOffsets.push(pos);
        for (let j = k; j < Math.min(k + 2, payloads.length); j++) { chunks.push(payloads[j]); pos += payloads[j].length; }
      }
    }
  }
  const mdatBody = Buffer.concat(chunks);
  const mdat = Buffer.concat([u32b(8 + mdatBody.length), Buffer.from('mdat', 'latin1'), mdatBody]);
  const creation = Math.round((opts.creationMs || Date.UTC(2016, 0, 1)) / 1000) + 2082844800;
  const mvhd = full('mvhd', 0, 0, u32b(creation, creation, 1000, Math.round((frames * 1001) / 30)), Buffer.alloc(80));
  const gPer = [[1, 2]];
  if (payloads.length % 2) gPer.push([gOffsets.length, 1]);
  const moov = box('moov', mvhd,
    trak(1, 'vide', 'GoPro H.265', 'hvc1', 30000, 1001, vSizes, vOffsets, [[1, 1]], false),
    trak(2, 'meta', 'GoPro MET', 'gpmd', 1000, 1001, gSizes, gOffsets, gPer, !!opts.co64));
  return Buffer.concat([ftyp, mdat, moov]);
}

// ---------- synthetic ride ----------
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

// Truth: video_s = videoAtStartS + (mono - mono0)/1000 * (1 + driftPpm*1e-6).
// UTC: utc = utc0 + (mono - mono0) (phone mono runs at GNSS rate).
function makeRide(o) {
  o = Object.assign({ durationS: 600, videoAtStartS: 20, rideS: 540, driftPpm: 40, goproGpsLatencyMs: 1300, scooterLagMs: 500, seed: 7, mono0: 5000000, utc0: Date.UTC(2026, 10, 7, 0, 0, 0), withGoproFix: true }, o);
  const r = rng(o.seed);
  const k = 1 + o.driftPpm * 1e-6;
  const videoOfMono = (m) => o.videoAtStartS + ((m - o.mono0) / 1000) * k;
  const monoOfVideo = (v) => o.mono0 + ((v - o.videoAtStartS) / k) * 1000;
  // speed profile (m/s) vs ride time: stop-and-go segments
  const segs = [];
  let tt = 0;
  while (tt < o.rideS) { const len = 20 + r() * 60; segs.push({ t0: tt, t1: tt + len, v: r() < 0.25 ? 0 : 4 + r() * 10 }); tt += len; }
  const target = (t) => { for (const s of segs) if (t >= s.t0 && t < s.t1) return s.v; return 0; };
  // smooth by first-order lag (tau 3 s) on a 10 ms grid
  const dt = 0.01, N = Math.ceil(o.rideS / dt) + 1;
  const sp = new Float64Array(N);
  for (let i = 1; i < N; i++) { const tr = i * dt < 3 || i * dt > o.rideS - 5 ? 0 : target(i * dt); sp[i] = sp[i - 1] + ((tr - sp[i - 1]) * dt) / 3; }
  const speedAt = (t) => { const i = Math.round(t / dt); return i < 0 || i >= N ? 0 : sp[i]; };
  // shocks: sparse impulses -> damped 3 Hz ringing, in ride time
  const imp = [];
  for (let t = 1; t < o.rideS; t += 0.2 + r() * 1.5) imp.push({ t, a: (0.5 + r() * 2.5) * (r() < 0.5 ? -1 : 1) });
  const shockAt = (t) => {
    let s = 0;
    for (let j = 0; j < imp.length; j++) { const d = t - imp[j].t; if (d < 0) break; if (d < 1.2) s += imp[j].a * Math.exp(-d / 0.25) * Math.sin(2 * Math.PI * 3 * d); }
    return s;
  };
  // impulses are sorted; speed the scan with a moving start
  const shockScanner = () => { let j0 = 0; return (t) => { while (j0 < imp.length && imp[j0].t < t - 1.2) j0++; let s = 0; for (let j = j0; j < imp.length && imp[j].t <= t; j++) { const d = t - imp[j].t; s += imp[j].a * Math.exp(-d / 0.25) * Math.sin(2 * Math.PI * 3 * d); } return s; }; };
  // each consumer scans forward in time, so each gets its own scanner
  let shockFast = shockScanner();
  void shockAt;

  // GoPro: ACCL 200 Hz over the whole clip, GPS5 18 Hz, GPSU 1 Hz (with latency).
  const rideTimeOfVideo = (v) => (monoOfVideo(v) - o.mono0) / 1000;
  const n200 = Math.floor(o.durationS * 200);
  const at = new Float64Array(n200), ax = new Float64Array(n200), ay = new Float64Array(n200), az = new Float64Array(n200);
  for (let i = 0; i < n200; i++) {
    const v = i / 200; at[i] = v;
    const rt = rideTimeOfVideo(v);
    const s = rt >= 0 && rt <= o.rideS ? shockFast(rt) : 0;
    az[i] = 9.81 + s + 0.15 * gauss(r); ax[i] = 0.1 * gauss(r); ay[i] = 0.1 * gauss(r);
  }
  const n18 = Math.floor(o.durationS * 18);
  const g = { t: new Float64Array(n18), lat: new Float64Array(n18), lon: new Float64Array(n18), alt: new Float64Array(n18), s2: new Float64Array(n18), s3: new Float64Array(n18), fix: new Float64Array(n18), dop: new Float64Array(n18), src: 'GPS5' };
  for (let i = 0; i < n18; i++) {
    const v = i / 18; g.t[i] = v;
    g.s2[i] = Math.max(0, speedAt(rideTimeOfVideo(v)) + 0.1 * gauss(r)); g.s3[i] = g.s2[i];
    g.fix[i] = o.withGoproFix ? 3 : 0; g.dop[i] = o.withGoproFix ? 1.5 : 99.99;
  }
  const gpsTime = { t: [], utc: [], fix: [], dop: [] };
  for (let v = 0; v < o.durationS; v += 1.001) {
    gpsTime.t.push(v);
    gpsTime.utc.push(o.utc0 + (monoOfVideo(v) - o.mono0) + o.goproGpsLatencyMs + Math.round(20 * gauss(r)));
    gpsTime.fix.push(o.withGoproFix ? 3 : 0); gpsTime.dop.push(o.withGoproFix ? 1.5 : 99.99);
  }
  const gopro = {
    device: 'Synthetic', durationS: o.durationS, fps: 29.97,
    chapters: [{ file: 'GS019999.360', offsetS: 0, durationS: o.durationS, fps: 29.97, info: { creationTime: new Date(o.utc0), gpmdSamples: Math.ceil(o.durationS) }, streams: {}, gpsMeta: { fixHistogram: {} } }],
    gps: g, gpsTime, accl: { t: at, x: ax, y: ay, z: az }, grav: null, gyro: null,
  };

  // Volt exports (CSV text). Ride mono range [mono0, mono0 + rideS*1000].
  const wallOff = 1264; // phone wall clock ahead of GNSS
  const utcOf = (m) => o.utc0 + (m - o.mono0);
  const sensors = ['schema_version,event,recorded_utc,wall_ms,monotonic_ms,frame,key,numeric,text,unit,source_command,sensor_updated_monotonic_ms,sensor_age_ms,current_direction,details'];
  const row = (ev, m, frame, key, numeric, text, cmd, upd, dir, det) => sensors.push(['1', ev, new Date(utcOf(m) + wallOff).toISOString(), Math.round(utcOf(m) + wallOff), Math.round(m), frame, key, numeric, text, '', cmd, upd, '', dir || '', det || ''].join(','));
  row('START', o.mono0, '', 'profile', '', '"Synthetic, ride"', '', '', 'POSITIVE_IS_DRAW');
  let frame = 0;
  for (let t = 0.3; t < o.rideS; t += 1) {
    const m = o.mono0 + t * 1000;
    const upd = Math.round(m - 200 - r() * 300);
    const tr = (upd - o.mono0) / 1000 - o.scooterLagMs / 1000; // the value describes an earlier moment
    const v = speedAt(tr);
    const acc = (speedAt(tr + 0.5) - speedAt(tr - 0.5));
    const cur = 10 * acc + 0.8 * v + 0.5; // regen when braking hard
    frame++;
    row('BEGIN', m, frame, '', 3, '', '', '', '');
    row('SENSOR', m, frame, 'speed_kmh', (v * 3.6).toFixed(1), '', '146', upd, '');
    row('SENSOR', m, frame, 'voltage_v', '50.0', '', '144', upd + 7, '');
    row('SENSOR', m, frame, 'current_a', cur.toFixed(2), '', '144', upd + 7, '');
    row('SENSOR', m, frame, 'battery_percent', (80 - (4 * t) / o.rideS).toFixed(0), '', '144', upd + 7, '');
    row('COMMIT', m, frame, '', '', '', '', '', '');
  }
  row('STOP', o.mono0 + o.rideS * 1000, '', '', '', '', '', '', '', 'manual');

  const phone = ['event,wall_ms,monotonic_ms,a,b,c,d,e,f,g,h,i,j'];
  phone.push(['START', utcOf(o.mono0) + wallOff, o.mono0, ''].join(','));
  let alt = 100;
  for (let t = 2; t < o.rideS; t += 1) {
    const m = o.mono0 + t * 1000 + 49;
    alt += 0.02 * speedAt(t);
    phone.push(['GPS', Math.round(utcOf(m)), Math.round(m), '0', '0', '5', (speedAt(t) + 0.15 * gauss(r)).toFixed(3), '0.5', (alt + 0.5 * gauss(r)).toFixed(1), '3'].join(','));
    phone.push(['PRESSURE', Math.round(utcOf(m + 300) + wallOff), Math.round(m + 300), (1000 - alt / 8.3).toFixed(3)].join(','));
  }
  phone.push(['STOP', utcOf(o.mono0 + o.rideS * 1000) + wallOff, o.mono0 + o.rideS * 1000].join(','));

  shockFast = shockScanner();
  const motion = ['monotonic_ms,raw_x_mps2,raw_y_mps2,raw_z_mps2,linear_x_mps2,linear_y_mps2,linear_z_mps2,earth_east_mps2,earth_north_mps2,earth_up_mps2,rotation_x,rotation_y,rotation_z,rotation_w,accuracy'];
  for (let t = 0.05; t < o.rideS; t += 0.05 + (r() - 0.5) * 0.01) {
    const s = 0.7 * shockFast(t) + 0.15 * gauss(r);
    // phone held at a fixed odd angle: gravity split over the axes
    const mag = 9.81 + s;
    motion.push([Math.round((o.mono0 + t * 1000) * 1000) / 1000, (mag * 0.6).toFixed(4), (mag * 0.0).toFixed(4), (mag * 0.8).toFixed(4), 0, 0, s.toFixed(4), 0, 0, s.toFixed(4), 0, 0, 0, 1, 3].join(','));
  }

  return {
    truth: { videoAtStartS: o.videoAtStartS, driftPpm: o.driftPpm, videoOfMono, monoOfVideo, scooterLagMs: o.scooterLagMs, latencyMs: o.goproGpsLatencyMs },
    gopro,
    files: { 'ride-synth00-sensors.csv': sensors.join('\n') + '\n', 'ride-synth00-phone.csv': phone.join('\n') + '\n', 'ride-synth00-motion.csv': motion.join('\n') + '\n' },
  };
}

module.exports = { gpmfPayload, makeMp4, makeRide, klv, nest, str };
