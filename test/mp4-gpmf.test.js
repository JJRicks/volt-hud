'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gpmfPayload, makeMp4 } = require('../tools/fixtures/synth');
const { readGpmd, readMoov } = require('../core/parse/mp4-moov');
const { loadGoPro, sortChapters, gpsuToMs } = require('../core/parse/gopro');

const T0 = Date.UTC(2026, 10, 7, 0, 36, 23, 900);
function payloads(n, startMs, fix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const accl = [];
    for (let k = 0; k < 200; k++) accl.push([9.81, 0.5 * Math.sin(k / 10), -0.25]);
    const gps5 = [];
    for (let k = 0; k < 18; k++) gps5.push([10 + i * 1e-4, 20, 100, 5 + i * 0.1, 5]);
    out.push(gpmfPayload({ accl, gps5, gpsuMs: startMs + i * 1001, fix }));
  }
  return out;
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'volthud-')); }

test('moov reader returns exactly the gpmd samples (stco and co64)', () => {
  const dir = tmp();
  for (const co64 of [false, true]) {
    const p = payloads(7, T0, 3);
    const file = path.join(dir, co64 ? 'GS010001.360' : 'GS010002.360');
    fs.writeFileSync(file, makeMp4(p, { co64 }));
    const r = readGpmd(file);
    assert.ok(r.rawData.equals(Buffer.concat(p)), 'bytes match');
    assert.strictEqual(r.timing.samples.length, 7);
    assert.strictEqual(r.timing.samples[3].cts, 3003);
    assert.ok(Math.abs(r.info.fps - 29.97) < 0.01);
    const m = readMoov(file);
    assert.deepStrictEqual(m.tracks.map((t) => t.codec), ['hvc1', 'gpmd']);
    assert.strictEqual(m.tracks[1].handlerName, 'GoPro MET');
  }
});

test('GPSU parsing', () => {
  assert.strictEqual(gpsuToMs('261107003623.910'), Date.UTC(2026, 10, 7, 0, 36, 23, 910));
});

test('loadGoPro decodes ACCL/GPS5 via gopro-telemetry and merges chapters in order', async () => {
  const dir = tmp();
  const a = path.join(dir, 'GS010042.360'), b = path.join(dir, 'GS020042.360');
  fs.writeFileSync(a, makeMp4(payloads(5, T0, 3)));
  fs.writeFileSync(b, makeMp4(payloads(4, T0 + 5005, 0)));
  assert.deepStrictEqual(sortChapters([b, a]).paths, [a, b]);
  const g = await loadGoPro([b, a]);
  assert.strictEqual(g.chapters.length, 2);
  assert.strictEqual(g.chapters[0].file, 'GS010042.360');
  assert.ok(Math.abs(g.chapters[1].offsetS - g.chapters[0].durationS) < 1e-9);
  assert.strictEqual(g.gpsTime.t.length, 9);
  assert.ok(Math.abs(g.gpsTime.t[5] - g.chapters[1].offsetS) < 1e-6, 'chapter 2 GPS time starts at its offset');
  assert.strictEqual(g.gpsTime.utc[0], T0);
  assert.deepStrictEqual(g.chapters[0].gpsMeta.fixHistogram, { 3: 5 });
  assert.deepStrictEqual(g.chapters[1].gpsMeta.fixHistogram, { 0: 4 });
  assert.ok(g.accl.t.length >= 9 * 200 - 10, 'ACCL samples');
  const mag = Math.hypot(g.accl.x[10], g.accl.y[10], g.accl.z[10]);
  assert.ok(Math.abs(mag - Math.hypot(9.81, 0.5 * Math.sin(1), 0.25)) < 0.02);
  assert.ok(g.gps && g.gps.t.length >= 9 * 18 - 2);
  assert.ok(g.accl.t[g.accl.t.length - 1] > g.chapters[1].offsetS, 'chapter 2 ACCL is offset');
  for (let i = 1; i < g.accl.t.length; i++) assert.ok(g.accl.t[i] >= g.accl.t[i - 1] - 1e-9);
});
