'use strict';
// Assemble project: find recordings, their MP4s and rides in a folder, pair them with the sync engine,
// and choose the Premiere settings. Runs in Node (tests) and in the After Effects engine page (CEP).

const fs = require('fs');
const path = require('path');
const { loadGoPro, chapterKey, sortChapters } = require('./parse/gopro');
const { loadVolt } = require('./parse/volt');
const { syncRide } = require('./sync/sync');

const MIN_OVERLAP_S = 20;
const CONF_RANK = { high: 3, medium: 2, low: 1 };

// GoPro Reframe's "Projection" menu, 0-based (order checked against the plug-in's own strings and a saved project):
// Source 0, HD Scope 1, HD 16:9 2, HD 4:3 3, Social 1:1 4, Social 4:5 5, Social 9:16 6, UHD 16:9 7, UHD Scope 8, 4K DCI 9.
function outputFor(size, shape) {
  const tall = shape === '9:16', uhd = size === '4k';
  if (tall && uhd) return { width: 2160, height: 3840, aspect: '9:16', resolution: '4k', preset: 'vertical', projection: 6, motionScale: 200, upscaled: true };
  if (tall) return { width: 1080, height: 1920, aspect: '9:16', resolution: '1080', preset: 'vertical', projection: 6, motionScale: null, upscaled: false };
  if (uhd) return { width: 3840, height: 2160, aspect: '16:9', resolution: '4k', preset: 'focus', projection: 7, motionScale: null, upscaled: false };
  return { width: 1920, height: 1080, aspect: '16:9', resolution: '1080', preset: 'focus', projection: 2, motionScale: null, upscaled: false };
}

function baseOf(file) { return path.basename(file).replace(/\.[^.]+$/, ''); }
function statOrNull(p) { try { return fs.statSync(p); } catch (e) { return null; } }

// Reads the folder only. Everything that is not a .360, a matching MP4 or a ride Everything file is ignored.
function scanFolder(dir) {
  const names = fs.readdirSync(dir).filter((n) => n[0] !== '.').sort();
  const groups = new Map(), mp4ByBase = new Map(), rides = [];
  for (const n of names) {
    const full = path.join(dir, n);
    const st = statOrNull(full);
    if (!st || !st.isFile()) continue;
    if (/\.360$/i.test(n)) {
      const k = chapterKey(n).file;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(full);
    } else if (/^ride-.*-everything\.json$/i.test(n)) {
      rides.push(full);
    } else {
      const m = /^([^_]+)_.*\.mp4$/i.exec(n);
      if (m) {
        const b = m[1].toLowerCase();
        if (!mp4ByBase.has(b)) mp4ByBase.set(b, []);
        mp4ByBase.get(b).push({ path: full, mtimeMs: st.mtimeMs });
      }
    }
  }
  const recordings = [], skipped = [];
  for (const [key, list] of groups) {
    const videos = sortChapters(list).paths;
    const mp4s = [], missing = [], notes = [];
    for (const v of videos) {
      const c = (mp4ByBase.get(baseOf(v).toLowerCase()) || []).slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (!c.length) { missing.push(path.basename(v)); continue; }
      if (c.length > 1) notes.push(`${path.basename(v)} has ${c.length} MP4s; used the newest, ${path.basename(c[0].path)}`);
      mp4s.push(c[0].path);
    }
    const name = baseOf(videos[0]);
    if (missing.length) skipped.push({ name, reason: `no MP4 for ${missing.join(', ')}` });
    else recordings.push({ key, name, videos, mp4s, notes });
  }
  return { recordings, skipped, rides };
}

function overlapSeconds(videoDurationS, rideStartVideoS, rideElapsedS) {
  if (!Number.isFinite(rideStartVideoS) || !Number.isFinite(videoDurationS)) return 0;
  const end = Number.isFinite(rideElapsedS) ? rideStartVideoS + rideElapsedS : videoDurationS;
  return Math.max(0, Math.min(videoDurationS, end) - Math.max(0, rideStartVideoS));
}

// One ride per recording and one recording per ride, best confidence first, then longest overlap.
function choosePairs(candidates) {
  const sorted = candidates.filter((c) => c.overlapS >= MIN_OVERLAP_S).sort((a, b) =>
    (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0) || b.overlapS - a.overlapS || (b.score || 0) - (a.score || 0));
  const usedRec = new Set(), usedRide = new Set(), out = [];
  for (const c of sorted) {
    if (usedRec.has(c.recording) || usedRide.has(c.ride)) continue;
    usedRec.add(c.recording); usedRide.add(c.ride); out.push(c);
  }
  return out;
}

function firstUtcMs(gopro) {
  const g = gopro && gopro.gpsTime;
  if (!g || !g.utc) return null;
  for (let i = 0; i < g.utc.length; i++) if (Number.isFinite(g.utc[i]) && (g.fix == null || g.fix[i] > 0)) return g.utc[i] - g.t[i] * 1000;
  return null;
}

// Time order, oldest first; GoPro file numbers break ties and stand in when a recording has no GPS time.
function timeOrder(recs) {
  return recs.slice().sort((a, b) => {
    if (Number.isFinite(a.startUtcMs) && Number.isFinite(b.startUtcMs) && a.startUtcMs !== b.startUtcMs) return a.startUtcMs - b.startUtcMs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// Loads every recording and ride, syncs each pair, and returns the plan. `deps` swaps the loaders in tests.
async function planFolder(dir, deps) {
  deps = deps || {};
  const pipeline = require('./pipeline');
  const loadG = deps.loadGoPro || loadGoPro;
  const loadV = deps.loadVolt || ((f) => { const vi = pipeline.expandVolt([f]); return loadVolt(vi.inputs, vi.rideId ? { rideId: vi.rideId } : undefined); });
  const sync = deps.syncRide || ((g, v) => syncRide(g, v, { imu: true }));
  const onStep = deps.onStep || (() => {});
  const scan = scanFolder(dir);
  const problems = [];
  const rides = [];
  for (const f of scan.rides) {
    onStep('Reading ' + path.basename(f));
    try { rides.push({ file: f, volt: loadV(f) }); } catch (e) { problems.push(`${path.basename(f)}: could not read (${e.message})`); }
  }
  const recs = [];
  for (const r of scan.recordings) {
    onStep('Reading ' + r.name);
    try {
      const gopro = await loadG(r.videos);
      recs.push(Object.assign({}, r, { gopro, durationS: gopro.durationS, fps: gopro.fps, startUtcMs: firstUtcMs(gopro) }));
    } catch (e) { scan.skipped.push({ name: r.name, reason: `could not read the .360 (${e.message})` }); }
  }
  const candidates = [];
  for (const r of recs) for (const v of rides) {
    onStep(`Matching ${r.name} with ${path.basename(v.file)}`);
    let s;
    try { s = sync(r.gopro, v.volt); } catch (e) { continue; }
    const elapsedMs = v.volt.summary && v.volt.summary.elapsedMs;
    candidates.push({ recording: r, ride: v, sync: s, confidence: s.confidence, score: s.score, rideStartVideoS: s.rideStartVideoS,
      overlapS: overlapSeconds(r.durationS, s.rideStartVideoS, Number.isFinite(elapsedMs) ? elapsedMs / 1000 : NaN) });
  }
  for (const p of choosePairs(candidates)) { p.recording.pair = p; }
  return { dir, recordings: timeOrder(recs), skipped: scan.skipped, rides, problems };
}

// "Volt Assembly 2026-11-09 1423", with " 2", " 3"... so that neither the .aep nor the .prproj already exists.
function assemblyStem(dir, now) {
  const d = now || new Date();
  const z = (n) => String(n).padStart(2, '0');
  const stem = `Volt Assembly ${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
  for (let n = 1; ; n++) {
    const s = n === 1 ? stem : `${stem} ${n}`;
    if (!fs.existsSync(path.join(dir, s + '.aep')) && !fs.existsSync(path.join(dir, s + '.prproj'))) return s;
  }
}

// Plain-English report the Mac app shows after a run.
function reportText(r) {
  const lines = [];
  if (r.aep) lines.push('After Effects: ' + path.basename(r.aep));
  if (r.prproj) lines.push('Premiere: ' + path.basename(r.prproj));
  for (const x of r.recordings || []) {
    let l = x.name + ': ';
    if (x.comp) l += `on V1 with HUD from ${x.ride} (${x.confidence} sync, ride starts ${x.rideStartVideoS.toFixed(1)} s in)`;
    else l += 'on V1, no HUD (no matching ride)';
    if (x.confidence === 'low') l += '. LOW confidence: check the sync';
    lines.push(l);
  }
  for (const s of r.skipped || []) lines.push(`Skipped ${s.name}: ${s.reason}`);
  for (const n of r.notes || []) lines.push(n);
  return lines.join('\n');
}

module.exports = { outputFor, scanFolder, overlapSeconds, choosePairs, timeOrder, planFolder, assemblyStem, reportText, firstUtcMs, MIN_OVERLAP_S };
