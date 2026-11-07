'use strict';
// t=0 check between a .360 and a reframed/equirect MP4: compare stream
// durations and frame counts, then cross-correlate decoded mono audio (8 kHz)
// near the start and near the end. Needs ffmpeg/ffprobe on PATH (CLI only).

const { execFileSync } = require('child_process');
const S = require('./util/signal');
const { readMoov } = require('./parse/mp4-moov');

const RATE = 8000;

function decode(file, startS, durS) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(startS), '-t', String(durS), '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const n = buf.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// Lag (s) of b relative to a: b(t + lag) ~ a(t). Coarse on a 1 kHz envelope, then fine at 8 kHz.
function audioLag(a, b, maxS) {
  const dec = 8;
  const env = (x) => { const n = Math.floor(x.length / dec); const o = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < dec; k++) s += Math.abs(x[i * dec + k]); o[i] = s / dec; } return S.highPass(o, 50); };
  const ea = env(a), eb = env(b);
  const L = Math.round((maxS * RATE) / dec);
  const c = S.peakInfo(S.nccScan(ea, eb, -L, L, 1000), 20);
  if (!c) return null;
  const centre = Math.round(c.lag * dec);
  const fine = S.nccScan(a, b, centre - 2 * dec, centre + 2 * dec, RATE);
  const p = S.peakInfo(fine, 2);
  return { lagS: p.lag / RATE, ncc: p.peak, coarseNcc: c.peak, coarsePsr: c.psr };
}

// Per-frame mean luma of one video stream (32x16 gray), a cheap content signature.
function lumaSeries(file, streamSpec, startS, durS) {
  const W = 32, H = 16;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(startS), '-t', String(durS), '-i', file, '-map', streamSpec, '-vf', 'scale=' + W + ':' + H + ',format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const n = Math.floor(buf.length / (W * H));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < W * H; k++) s += buf[i * W * H + k]; out[i] = s / (W * H); }
  return out;
}

// Frame lag of b vs a (opt-in: mean luma proved too flat to match on the MAX sample)
// (b[i+L] ~ a[i]) on high-passed luma, +-maxFrames.
function frameLag(a, b, maxFrames) {
  const ha = S.highPass(a, 15), hb = S.highPass(b, 15);
  const p = S.peakInfo(S.nccScan(ha, hb, -maxFrames, maxFrames, 60), 1);
  return p ? { lagFrames: Math.round(p.lag * 100) / 100, ncc: p.peak, psr: p.psr } : null;
}

function probeFile(file) {
  const m = readMoov(file);
  const tracks = m.tracks.map((t) => ({ handler: t.handler, codec: t.codec, samples: t.sampleCount, durationS: t.durationS }));
  return { durationS: m.durationS, tracks, hasGpmd: m.tracks.some((t) => t.codec === 'gpmd') };
}

function checkMp4(file360, fileMp4, opts) {
  const win = (opts && opts.windowS) || 10;
  const a = probeFile(file360), b = probeFile(fileMp4);
  const vid = (p) => p.tracks.find((t) => t.handler === 'vide');
  const aud = (p) => p.tracks.find((t) => t.handler === 'soun' && t.codec === 'mp4a') || p.tracks.find((t) => t.handler === 'soun');
  const T = Math.min(a.durationS, b.durationS);
  const endStart = Math.max(0, T - win - 2);
  const startA = decode(file360, 0, win), startB = decode(fileMp4, 0, win);
  const endA = decode(file360, endStart, win), endB = decode(fileMp4, endStart, win);
  const start = audioLag(startA, startB, 1.0);
  const end = audioLag(endA, endB, 1.0);
  let video = null;
  if (opts && opts.video) {
    // .360 has two lens tracks (0:v:0, 0:v:1); the MP4 one. Same absolute windows.
    video = {};
    for (const [name, t0] of [['start', 0], ['end', endStart]]) {
      const mp4 = lumaSeries(fileMp4, '0:v:0', t0, win);
      video[name] = {};
      for (const spec of ['0:v:0', '0:v:1']) {
        try { video[name]['360 ' + spec] = frameLag(lumaSeries(file360, spec, t0, win), mp4, 5); } catch (e) { video[name]['360 ' + spec] = { error: e.message.split('\n')[0] }; }
      }
    }
  }
  const frame = vid(a) && vid(a).samples ? vid(a).durationS / vid(a).samples : 1001 / 30000;
  const verdict = [];
  if (start && end) {
    const ms = (x) => Math.round(x * 1000 * 10) / 10;
    verdict.push('MP4 audio vs .360 audio: ' + ms(start.lagS) + ' ms at the start, ' + ms(end.lagS) + ' ms near the end (positive = MP4 later).');
    if (Math.abs(start.lagS) < frame / 2 && Math.abs(end.lagS) < frame / 2) verdict.push('Audio shares t=0 with no drift (within half a frame), so any video frame-count shortfall is most likely at the end (video not compared frame by frame).');
    else if (Math.abs(start.lagS - end.lagS) < frame / 2) verdict.push('Constant offset of ' + ms(start.lagS) + ' ms (' + (start.lagS / frame).toFixed(2) + ' frames): shift the MP4 by this.');
    else verdict.push('Offset changes between start and end: check for trimming or speed change.');
  }
  if (video) {
    const lags = [];
    for (const w in video) for (const k in video[w]) if (video[w][k] && Number.isFinite(video[w][k].lagFrames) && video[w][k].ncc > 0.5) lags.push(w + ' ' + k + ': ' + video[w][k].lagFrames + ' frames (NCC ' + video[w][k].ncc.toFixed(2) + ')');
    verdict.push('Video luma lag of the MP4 vs .360 lens tracks: ' + (lags.join('; ') || 'no confident match'));
  }
  const fa = vid(a) ? vid(a).samples : null, fb = vid(b) ? vid(b).samples : null;
  if (fa != null && fb != null && fa !== fb) {
    const other = a.tracks.filter((t) => t.handler === 'vide').map((t) => t.samples);
    verdict.push('Video frames: .360 ' + other.join(' / ') + ' (per lens track), MP4 ' + fb + '.');
  }
  return {
    file360: { durationS: a.durationS, video: vid(a), audio: aud(a), hasGpmd: a.hasGpmd },
    mp4: { durationS: b.durationS, video: vid(b), audio: aud(b), hasGpmd: b.hasGpmd },
    frameS: frame,
    windowS: win,
    endWindowStartS: endStart,
    video,
    start,
    end,
    verdict,
  };
}

module.exports = { checkMp4, audioLag };
