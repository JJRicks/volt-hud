'use strict';
// Minimal MP4/MOV box reader. Reads only the `moov` box and, on request, the
// samples of one track via its sample tables (stts/stsz/stsc/stco/co64), with
// fs.readSync at offsets, so a 30 GB .360 never loads whole.
// Node 17+ (CEP 12) compatible: CommonJS, no Node 18+ APIs.

const fs = require('fs');

const MAC_EPOCH_OFFSET_S = 2082844800; // 1904-01-01 -> 1970-01-01

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

function u64(buf, off) {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return hi * 4294967296 + lo; // exact below 2^53
}

// Iterate the boxes in buf[start, end). Yields {type, start, headerSize, size}.
function boxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) { size = u64(buf, p + 8); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p, headerSize: header, size });
    p += size;
  }
  return out;
}

function child(buf, box, type) {
  return boxes(buf, box.start + box.headerSize, box.start + box.size).find((b) => b.type === type) || null;
}
function children(buf, box, type) {
  return boxes(buf, box.start + box.headerSize, box.start + box.size).filter((b) => b.type === type);
}
function body(box) { return box.start + box.headerSize; }

// Find the top-level moov box without reading mdat.
function findMoov(fd, fileSize) {
  let p = 0;
  const hdr = Buffer.alloc(16);
  while (p + 8 <= fileSize) {
    fs.readSync(fd, hdr, 0, 16, p);
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) { size = u64(hdr, 8); header = 16; }
    else if (size === 0) size = fileSize - p;
    if (size < header) throw new Error('bad MP4 box at ' + p);
    if (type === 'moov') return { pos: p, size };
    p += size;
  }
  throw new Error('no moov box found');
}

function parseFullBoxVersion(buf, box) {
  return buf.readUInt8(body(box));
}

function parseTimes(buf, box) {
  // mvhd / mdhd: version, flags, creation, modification, timescale, duration
  const b = body(box);
  const v = buf.readUInt8(b);
  if (v === 1) {
    return { creation: u64(buf, b + 4), timescale: buf.readUInt32BE(b + 20), duration: u64(buf, b + 24) };
  }
  return { creation: buf.readUInt32BE(b + 4), timescale: buf.readUInt32BE(b + 12), duration: buf.readUInt32BE(b + 16) };
}

function parseTrak(buf, trak) {
  const t = {};
  const tkhd = child(buf, trak, 'tkhd');
  if (tkhd) {
    const b = body(tkhd);
    const v = buf.readUInt8(b);
    t.trackId = v === 1 ? buf.readUInt32BE(b + 20) : buf.readUInt32BE(b + 12);
  }
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) return t;
  const mdhd = child(buf, mdia, 'mdhd');
  if (mdhd) {
    const m = parseTimes(buf, mdhd);
    t.timescale = m.timescale;
    t.duration = m.duration;
  }
  const hdlr = child(buf, mdia, 'hdlr');
  if (hdlr) {
    const b = body(hdlr);
    t.handler = buf.toString('latin1', b + 8, b + 12);
    let name = buf.toString('latin1', b + 24, hdlr.start + hdlr.size);
    // QuickTime writes a Pascal string; ISO writes a C string
    if (name.length && name.charCodeAt(0) === name.length - 1) name = name.slice(1);
    t.handlerName = name.replace(/\0+$/, '').trim();
  }
  const minf = child(buf, mdia, 'minf');
  const stbl = minf && child(buf, minf, 'stbl');
  if (!stbl) return t;
  const stsd = child(buf, stbl, 'stsd');
  if (stsd) {
    const b = body(stsd);
    if (buf.readUInt32BE(b + 4) > 0) t.codec = buf.toString('latin1', b + 12, b + 16);
  }
  t._stbl = stbl;
  return t;
}

// Expand the sample tables into per-sample {offset, size, dts, duration} (track timescale).
function sampleTable(buf, t) {
  const stbl = t._stbl;
  const stszB = child(buf, stbl, 'stsz');
  const stz2 = child(buf, stbl, 'stz2');
  const sttsB = child(buf, stbl, 'stts');
  const stscB = child(buf, stbl, 'stsc');
  const stcoB = child(buf, stbl, 'stco');
  const co64B = child(buf, stbl, 'co64');
  if (!(stszB || stz2) || !sttsB || !stscB || !(stcoB || co64B)) throw new Error('incomplete sample table');

  let sizes;
  if (stszB) {
    const b = body(stszB);
    const fixed = buf.readUInt32BE(b + 4);
    const n = buf.readUInt32BE(b + 8);
    sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || buf.readUInt32BE(b + 12 + 4 * i);
  } else {
    const b = body(stz2);
    const field = buf.readUInt8(b + 7);
    const n = buf.readUInt32BE(b + 8);
    sizes = new Array(n);
    for (let i = 0; i < n; i++) {
      if (field === 16) sizes[i] = buf.readUInt16BE(b + 12 + 2 * i);
      else if (field === 8) sizes[i] = buf.readUInt8(b + 12 + i);
      else { const byte = buf.readUInt8(b + 12 + (i >> 1)); sizes[i] = i & 1 ? byte & 15 : byte >> 4; }
    }
  }
  const n = sizes.length;

  const chunkOffsets = [];
  if (co64B) {
    const b = body(co64B);
    const c = buf.readUInt32BE(b + 4);
    for (let i = 0; i < c; i++) chunkOffsets.push(u64(buf, b + 8 + 8 * i));
  } else {
    const b = body(stcoB);
    const c = buf.readUInt32BE(b + 4);
    for (let i = 0; i < c; i++) chunkOffsets.push(buf.readUInt32BE(b + 8 + 4 * i));
  }

  const stsc = [];
  {
    const b = body(stscB);
    const c = buf.readUInt32BE(b + 4);
    for (let i = 0; i < c; i++) {
      stsc.push({ first: buf.readUInt32BE(b + 8 + 12 * i), per: buf.readUInt32BE(b + 12 + 12 * i) });
    }
  }

  const durations = [];
  {
    const b = body(sttsB);
    const c = buf.readUInt32BE(b + 4);
    for (let i = 0; i < c; i++) {
      const count = buf.readUInt32BE(b + 8 + 8 * i);
      const delta = buf.readUInt32BE(b + 12 + 8 * i);
      for (let k = 0; k < count && durations.length < n; k++) durations.push(delta);
    }
  }

  const samples = new Array(n);
  let s = 0;
  for (let e = 0; e < stsc.length && s < n; e++) {
    const firstChunk = stsc[e].first;
    const lastChunk = e + 1 < stsc.length ? stsc[e + 1].first - 1 : chunkOffsets.length;
    for (let c = firstChunk; c <= lastChunk && s < n; c++) {
      let off = chunkOffsets[c - 1];
      for (let k = 0; k < stsc[e].per && s < n; k++) {
        samples[s] = { offset: off, size: sizes[s] };
        off += sizes[s];
        s++;
      }
    }
  }
  if (s < n) throw new Error('sample table maps only ' + s + ' of ' + n + ' samples');
  let dts = 0;
  for (let i = 0; i < n; i++) {
    const d = durations[i] != null ? durations[i] : durations[durations.length - 1] || 0;
    samples[i].dts = dts;
    samples[i].duration = d;
    dts += d;
  }
  return samples;
}

// Open a file and describe its tracks. Reads only the box headers and moov.
function readMoov(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const loc = findMoov(fd, fileSize);
    if (loc.size > 512 * 1024 * 1024) throw new Error('moov too large');
    const buf = readAt(fd, loc.pos, loc.size);
    const moov = { type: 'moov', start: 0, headerSize: loc.size > 0xffffffff ? 16 : 8, size: buf.length };
    const mvhdB = child(buf, moov, 'mvhd');
    const mvhd = mvhdB ? parseTimes(buf, mvhdB) : null;
    const tracks = children(buf, moov, 'trak').map((tb, i) => {
      const t = parseTrak(buf, tb);
      t.index = i;
      if (t._stbl) {
        try { t.samples = sampleTable(buf, t); } catch (e) { t.samples = []; t.tableError = e.message; }
      } else t.samples = [];
      delete t._stbl;
      t.sampleCount = t.samples.length;
      t.durationS = t.timescale ? t.duration / t.timescale : null;
      return t;
    });
    return {
      path,
      fileSize,
      timescale: mvhd ? mvhd.timescale : null,
      durationS: mvhd && mvhd.timescale ? mvhd.duration / mvhd.timescale : null,
      creationTime: mvhd && mvhd.creation ? new Date((mvhd.creation - MAC_EPOCH_OFFSET_S) * 1000) : null,
      tracks,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function isGpmd(t) {
  return t.codec === 'gpmd' || (t.handler === 'meta' && /GoPro MET/i.test(t.handlerName || ''));
}

// Read the gpmd track's samples. Returns gopro-telemetry's {rawData, timing}
// plus a summary. cts/duration are in ms, as gopro-telemetry expects.
function readGpmd(path) {
  const info = readMoov(path);
  const track = info.tracks.find(isGpmd);
  if (!track) throw new Error('no gpmd (GoPro MET) track in ' + path);
  const video = info.tracks.find((t) => t.handler === 'vide' && t.sampleCount > 0);
  const total = track.samples.reduce((a, s) => a + s.size, 0);
  const rawData = Buffer.alloc(total);
  const fd = fs.openSync(path, 'r');
  try {
    let p = 0;
    for (const s of track.samples) {
      const n = fs.readSync(fd, rawData, p, s.size, s.offset);
      if (n !== s.size) throw new Error('short read at ' + s.offset);
      p += s.size;
    }
  } finally {
    fs.closeSync(fd);
  }
  const ts = track.timescale;
  const frameDuration = video && video.samples.length ? video.samples[0].duration / video.timescale : null;
  const videoDurationS = video ? video.durationS : info.durationS;
  const timing = {
    frameDuration: frameDuration,
    videoDuration: videoDurationS,
    start: info.creationTime || new Date(0),
    samples: track.samples.map((s) => ({ cts: (s.dts * 1000) / ts, duration: (s.duration * 1000) / ts })),
  };
  return {
    rawData,
    timing,
    info: {
      path,
      fileSize: info.fileSize,
      durationS: info.durationS,
      videoDurationS,
      fps: frameDuration ? 1 / frameDuration : null,
      creationTime: info.creationTime,
      gpmdTrackIndex: track.index,
      gpmdSamples: track.sampleCount,
      gpmdBytes: total,
      sampleSizes: track.samples.map((s) => s.size),
      tracks: info.tracks.map((t) => ({
        index: t.index, trackId: t.trackId, handler: t.handler, handlerName: t.handlerName,
        codec: t.codec, sampleCount: t.sampleCount, durationS: t.durationS,
      })),
    },
  };
}

module.exports = { readMoov, readGpmd, boxes, MAC_EPOCH_OFFSET_S };
