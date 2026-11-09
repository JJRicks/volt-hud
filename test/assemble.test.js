'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../core/assemble');

function folder(names) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'volthud-assemble-'));
  for (const n of names) fs.writeFileSync(path.join(d, n), 'x');
  return d;
}

test('scan groups chapters, matches MP4s by name, ignores everything else', () => {
  const d = folder(['GS011304.360', 'GS021304.360', 'GS011304_2026-11-07_15-49-25-118.mp4', 'GS021304_a.mp4', 'GS011305.360', 'GS011305_equirect.MP4',
    'GS011306.360', 'Rides1080.mp4', 'eggnogg.mp4', 'oops.mp3', 'Rides.prproj', 'Volthud.aep', 'ride-aaa-everything.json', 'ride-bbb-combined.json']);
  try {
    const s = A.scanFolder(d);
    assert.deepStrictEqual(s.recordings.map((r) => r.name), ['GS011304', 'GS011305']);
    assert.strictEqual(s.recordings[0].mp4s.length, 2);
    assert.ok(s.recordings[0].mp4s[1].endsWith('GS021304_a.mp4'));
    assert.deepStrictEqual(s.skipped.map((x) => x.name), ['GS011306']);
    assert.deepStrictEqual(s.rides.map((f) => path.basename(f)), ['ride-aaa-everything.json']);
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('a recording missing one chapter MP4 is skipped and reported', () => {
  const d = folder(['GS011400.360', 'GS021400.360', 'GS011400_a.mp4']);
  try {
    const s = A.scanFolder(d);
    assert.strictEqual(s.recordings.length, 0);
    assert.match(s.skipped[0].reason, /GS021400\.360/);
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('two MP4s for a chapter: newest wins and is noted', () => {
  const d = folder(['GS011500.360', 'GS011500_old.mp4', 'GS011500_new.mp4']);
  try {
    fs.utimesSync(path.join(d, 'GS011500_old.mp4'), new Date(1000000), new Date(1000000));
    const s = A.scanFolder(d);
    assert.ok(s.recordings[0].mp4s[0].endsWith('_new.mp4'));
    assert.match(s.recordings[0].notes[0], /2 MP4s/);
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('pairing: best confidence first, one to one, no-overlap pairs dropped', () => {
  const r1 = { name: 'r1' }, r2 = { name: 'r2' }, a = { file: 'a' }, b = { file: 'b' };
  const out = A.choosePairs([
    { recording: r1, ride: a, confidence: 'low', overlapS: 500, score: 0.9 },
    { recording: r1, ride: b, confidence: 'high', overlapS: 100, score: 0.4 },
    { recording: r2, ride: b, confidence: 'medium', overlapS: 300, score: 0.5 },
    { recording: r2, ride: a, confidence: 'low', overlapS: 5, score: 0.9 },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].recording, r1); assert.strictEqual(out[0].ride, b);
});

test('overlap clips the ride to the video', () => {
  assert.strictEqual(A.overlapSeconds(600, 54, 1000), 546);
  assert.strictEqual(A.overlapSeconds(600, -100, 300), 200);
  assert.strictEqual(A.overlapSeconds(100, 895, 60), 0);
});

test('plan runs the sync across pairs and orders recordings by time', async () => {
  const d = folder(['GS011001.360', 'GS011001_a.mp4', 'GS011002.360', 'GS011002_a.mp4', 'GS011003.360', 'GS011003_a.mp4', 'ride-aa-everything.json', 'ride-bb-everything.json']);
  const t0 = 1700000000000;
  const start = { GS011001: t0 + 200000, GS011002: t0, GS011003: t0 + 100000 };
  try {
    const plan = await A.planFolder(d, {
      loadGoPro: async (v) => ({ durationS: 600, fps: 29.97, gpsTime: { t: [0], utc: [start[path.basename(v[0], '.360')]], fix: [3] }, name: path.basename(v[0]) }),
      loadVolt: (f) => ({ id: path.basename(f), summary: { elapsedMs: 300000 } }),
      syncRide: (g, v) => ((g.name === 'GS011001.360' && v.id.indexOf('aa') > 0) ? { confidence: 'high', score: 0.5, rideStartVideoS: 30 }
        : (g.name === 'GS011002.360' && v.id.indexOf('bb') > 0) ? { confidence: 'low', score: 0.2, rideStartVideoS: 100 }
          : { confidence: 'low', score: 0.1, rideStartVideoS: 9000 }),
    });
    assert.deepStrictEqual(plan.recordings.map((r) => r.name), ['GS011002', 'GS011003', 'GS011001']);
    assert.strictEqual(plan.recordings[0].pair.confidence, 'low');
    assert.strictEqual(plan.recordings[1].pair, undefined);
    assert.strictEqual(path.basename(plan.recordings[2].pair.ride.file), 'ride-aa-everything.json');
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('Reframe projection and output sizes', () => {
  assert.deepStrictEqual([A.outputFor('1080', '16:9').projection, A.outputFor('1080', '9:16').projection, A.outputFor('4k', '16:9').projection, A.outputFor('4k', '9:16').projection], [2, 6, 7, 6]);
  assert.strictEqual(A.outputFor('4k', '9:16').motionScale, 200);
  assert.strictEqual(A.outputFor('1080', '16:9').preset, 'focus');
  assert.strictEqual(A.outputFor('1080', '9:16').preset, 'vertical');
  assert.deepStrictEqual([A.outputFor('4k', '16:9').width, A.outputFor('4k', '16:9').height], [3840, 2160]);
});

test('assembly name never reuses a taken .aep or .prproj', () => {
  const d = folder(['Volt Assembly 2026-11-09 1423.prproj', 'Volt Assembly 2026-11-09 1423 2.aep']);
  try {
    assert.strictEqual(A.assemblyStem(d, new Date(2026, 10, 9, 14, 23)), 'Volt Assembly 2026-11-09 1423 3');
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('report lists every recording, low confidence, and skips', () => {
  const t = A.reportText({ aep: '/x/a.aep', prproj: '/x/a.prproj', recordings: [{ name: 'GS1', ride: 'ride-a', confidence: 'low', comp: 'c', rideStartVideoS: 12.34 }, { name: 'GS2' }], skipped: [{ name: 'GS3', reason: 'no MP4 for GS3.360' }] });
  assert.match(t, /GS1: on V1 with HUD from ride-a \(low sync, ride starts 12\.3 s in\)\. LOW confidence/);
  assert.match(t, /GS2: on V1, no HUD/);
  assert.match(t, /Skipped GS3/);
});

test('a .360 that cannot be read is not reported as a missing MP4', () => {
  const A = require('../core/assemble');
  assert.strictEqual(A.noRecordingsReason([{ name: 'GS011307', reason: 'could not read the .360 (bad file)' }]), 'no recording in this folder could be read');
  assert.strictEqual(A.noRecordingsReason([{ name: 'GS011307', reason: 'no MP4 for GS011307.360' }]), 'no recording in this folder has an MP4');
  assert.strictEqual(A.noRecordingsReason([]), 'no recording in this folder has an MP4');
});

test('empty GPS samples from a camera with no lock are left out', () => {
  const { gpsSamples } = require('../core/parse/gopro');
  const a = { value: [0, 0, 0, 0, 0], cts: 0 }, none = { value: null, cts: 50 }, b = { value: [1, 2, 3, 4, 5], cts: 100 };
  assert.deepStrictEqual(gpsSamples([a, none, b]), [a, b]);
  assert.deepStrictEqual(gpsSamples([none]), []);
});
