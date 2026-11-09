'use strict';
const test = require('node:test');
const assert = require('assert');
const { buildHudSpec, tzOffsetMin, speedValueSize } = require('../core/hud/spec');
const { normalizeStyle } = require('../core/hud/style');
const { layoutWidgets, BOX } = require('../core/hud/layout');
const B = require('../core/hud/bake');
const { synthTimeline } = require('../tools/fixtures/synth-timeline');

const ALL = { speed: true, power: true, battery: true, vertical: true, gmeter: true, jerk: true, clock: true, stats: true, coords: true, map: true };

test('every preset and aspect keeps widgets inside the safe area without overlaps', () => {
  for (const aspect of ['16:9', '9:16']) for (const preset of ['focus', 'corner', 'strip', 'vertical']) for (const res of ['hd', '4k']) {
    const st = normalizeStyle({ aspect, preset, resolution: res, coords: true, widgets: ALL });
    const L = layoutWidgets(st);
    const boxes = Object.keys(L.widgets).map((id) => { const w = L.widgets[id]; return { id, x0: w.x, y0: w.y, x1: w.x + w.w * w.k, y1: w.y + w.h * w.k }; });
    assert.strictEqual(boxes.length, 10, aspect + ' ' + preset);
    const [sx0, sy0, sx1, sy1] = L.safe;
    for (const b of boxes) assert.ok(b.x0 >= sx0 - 0.5 && b.y0 >= sy0 - 0.5 && b.x1 <= sx1 + 0.5 && b.y1 <= sy1 + 0.5, `${aspect} ${st.preset} ${res}: ${b.id} outside safe area ${JSON.stringify(b)}`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
      assert.ok(!ov, `${aspect} ${st.preset} ${res}: ${a.id} overlaps ${b.id}`);
    }
  }
});

test('style normalization: 9:16 maps focus to vertical, coords default on with an off switch, bad values fall back', () => {
  assert.strictEqual(normalizeStyle({ aspect: '9:16', preset: 'focus' }).preset, 'vertical');
  assert.deepStrictEqual(normalizeStyle({ aspect: '9:16' }).comp, [1080, 1920]);
  assert.strictEqual(normalizeStyle({}).widgets.coords, true);
  assert.strictEqual(normalizeStyle({}).widgets.map, true);
  assert.strictEqual(normalizeStyle({}).coords, true);
  const off = normalizeStyle({ coords: false, widgets: { coords: true, map: true } });
  assert.strictEqual(off.coords, false); assert.strictEqual(off.widgets.coords, false); assert.strictEqual(off.widgets.map, false);
  const s = normalizeStyle({ accent: 'nope', scale: 9, plate: 5, units: 'imperial' });
  assert.strictEqual(s.accent, '#E32B2F'); assert.strictEqual(s.scale, 1.5); assert.strictEqual(s.plate, 0.7);
  assert.strictEqual(s.vertUnit, 'ft/min'); assert.strictEqual(s.clock24, false);
  assert.strictEqual(normalizeStyle({ plate: 0 }).plate, 0);
});

test('decimate stays within tolerance and holds through gaps', () => {
  const a = []; for (let i = 0; i < 2000; i++) a.push(i > 800 && i < 900 ? null : Math.sin(i / 37) * 20 + (i % 7) * 0.01);
  const k = B.decimate(a, 10, 0.05);
  assert.ok(k.t.length < 600, 'keys ' + k.t.length);
  const at = (t) => { let j = 0; while (j + 1 < k.t.length && k.t[j + 1] <= t) j++; if (j + 1 >= k.t.length || k.t[j] === t) return k.v[j]; return k.v[j] + ((k.v[j + 1] - k.v[j]) * (t - k.t[j])) / (k.t[j + 1] - k.t[j]); };
  for (let i = 0; i < a.length; i++) if (a[i] !== null) assert.ok(Math.abs(at(i / 10) - a[i]) <= 0.0501, 'sample ' + i);
  // the key at the first null sample holds the last value (no drift while "no data")
  const gi = k.t.indexOf(80.1); assert.ok(gi > 0 && Math.abs(k.v[gi] - a[800]) < 1e-9);
  assert.deepStrictEqual(B.okKeys(a, 10), { t: [0, 80.1, 90], v: [1, 0, 1] });
  assert.strictEqual(B.okKeys([1, 2, 3], 10), null);
});

test('smoothing helpers keep nulls and settle', () => {
  assert.deepStrictEqual(B.maN([1, null, 3, 5], 1), [1, null, 4, 4]);
  const sp = B.springN(new Array(50).fill(10).concat(new Array(50).fill(20)), 8, 10);
  assert.ok(Math.abs(sp[99] - 20) < 0.01 && sp[51] < 20 && sp[51] > 10);
  assert.deepStrictEqual(B.runningMax([null, 2, 1, 5, null, 3]), [null, 2, 2, 5, 5, 5]);
});

test('stopped scooter: reads exactly 0 with no flicker, real low speeds still show', () => {
  // the owner's stop pattern: a ramp down, parked with stray dash blips smeared to 0.02-0.25 km/h, then rolling
  const park = []; for (let i = 0; i < 200; i++) park.push(i % 31 < 12 ? 0.14 : i % 17 < 4 ? 0.3 : 0);
  const ramp = []; for (let i = 0; i < 20; i++) ramp.push(5 - i * 0.25);
  const roll = []; for (let i = 0; i < 40; i++) roll.push(0.9 + 0.2 * Math.sin(i / 3)); // walking pace
  const kmh = [].concat(ramp, park, roll, new Array(10).fill(null));
  const m = B.stoppedMask(kmh, 10);
  for (let i = 22; i < 215; i++) assert.ok(m[i], 'parked sample ' + i);
  for (let i = 225; i < 260; i++) assert.ok(!m[i], 'rolling sample ' + i);
  for (let i = 260; i < 270; i++) assert.ok(!m[i], 'null sample ' + i);
  // a momentary dip while moving stays moving (dwell) and the slow crawl keeps its value
  const dip = new Array(60).fill(3); dip[30] = dip[31] = 0.2;
  assert.ok(B.stoppedMask(dip, 10).every((x) => !x));
  // GPS sources: the same 0.9 km/h wobble counts as parked noise
  const gps = new Array(100).fill(0.9), gm = B.stoppedMask(gps, 10, new Array(100).fill('phone-gps'));
  assert.ok(gm.every(Boolean));

  // through the spec and the baked keys, as AE reads them (linear between keys), in mph and km/h
  const tl = synthTimeline({ minutes: 1 });
  const n = tl.samples, ch = tl.channels;
  const K = new Array(n).fill(null);
  for (let i = 100; i < 100 + kmh.length && i < n; i++) K[i] = kmh[i - 100];
  ch.speedKmh = K; ch.speedSrc = K.map((x) => (x == null ? null : 'scooter'));
  for (const units of ['imperial', 'metric']) {
    const sp = buildHudSpec(tl, { units, speedDecimals: 1 });
    const ks = sp.channels.spd.keys;
    const at = (t) => { let j = 0; while (j + 1 < ks.t.length && ks.t[j + 1] <= t) j++; if (j + 1 >= ks.t.length || ks.t[j] === t) return ks.v[j]; return ks.v[j] + ((ks.v[j + 1] - ks.v[j]) * (t - ks.t[j])) / (ks.t[j + 1] - ks.t[j]); };
    // every frame of the parked stretch (samples 122..315, at 30 fps) formats as 0.0
    for (let f = Math.ceil(12.2 * 30); f <= Math.floor(31.5 * 30); f++) assert.strictEqual(at(f / 30).toFixed(1), '0.0', units + ' frame ' + f);
    // walking pace after the stop still shows (mph 0.3+, km/h 0.6+)
    assert.ok(at(34) >= (units === 'imperial' ? 0.3 : 0.6), units + ' rolling ' + at(34));
  }
});

test('time zone offsets', () => {
  assert.strictEqual(tzOffsetMin('America/Boise', Date.UTC(2026, 10, 7, 0, 36)), -420);
  assert.strictEqual(tzOffsetMin('America/Boise', Date.UTC(2026, 6, 7, 0, 36)), -360);
  assert.strictEqual(tzOffsetMin('Asia/Kolkata', Date.UTC(2026, 0, 1)), 330);
});

test('spec from a 60-minute synthetic timeline: comp length = .360, units, no-data flags, key budget', () => {
  const tl = synthTimeline({ minutes: 60 });
  const sp = buildHudSpec(tl, {});
  assert.strictEqual(sp.comp.frames, Math.round(tl.video.durationS * tl.video.fps));
  assert.ok(Math.abs(sp.comp.frames / sp.comp.fps - tl.video.durationS) < 1 / sp.comp.fps);
  assert.ok(sp.keyCount < 120000, 'keys ' + sp.keyCount);
  assert.ok(sp.channels.spd.ok && sp.channels.spd.ok.v[0] === 0, 'speed starts with no data');
  assert.strictEqual(sp.channels.clk.ok, null, 'clock always valid');
  assert.ok(sp.channels.clk.keys.t.length <= 3);
  // clock is local Boise time: 00:36:22.952Z = 17:36:22.952 MST
  assert.ok(Math.abs(sp.channels.clk.keys.v[0] - (17 * 3600 + 36 * 60 + 22.952)) < 0.01);
  const w = Object.fromEntries(sp.widgets.map((x) => [x.id, x]));
  assert.strictEqual(w.speed.p.unit, 'km/h');
  assert.ok(!w.coords && !w.map, 'a timeline built without coordinates stays off');
  const im = buildHudSpec(tl, { units: 'imperial' });
  const maxK = Math.max(...sp.channels.spd.keys.v), maxM = Math.max(...im.channels.spd.keys.v);
  assert.ok(Math.abs(maxM / maxK - 0.621371) < 0.01);
  assert.strictEqual(im.widgets.find((x) => x.id === 'stats').p.distUnit, 'mi');
  const p = w.power.p;
  assert.ok(p.scaleDraw >= 1000 && p.scaleDraw <= 6000 && p.scaleDraw % 250 === 0);
});

test('coords and mini-map only with coordinates, path inside its box', () => {
  const tl = synthTimeline({ minutes: 5, coords: true });
  const sp = buildHudSpec(tl, { coords: true, widgets: { map: true } });
  const map = sp.widgets.find((x) => x.id === 'map');
  assert.ok(map && map.p.path.length >= 2);
  for (const [x, y] of map.p.path) assert.ok(x >= 0 && x <= 300 && y >= 0 && y <= 300);
  assert.ok(sp.channels.lat && sp.channels.mapp);
  const tl2 = synthTimeline({ minutes: 5 });
  const sp2 = buildHudSpec(tl2, { coords: true, widgets: { map: true } });
  assert.ok(sp2.warnings.length === 1 && sp2.widgets.find((x) => x.id === 'map').p.path === null);
});

test('all-null channel bakes as permanent no data', () => {
  const tl = synthTimeline({ minutes: 1 });
  tl.channels.batteryPct = tl.channels.batteryPct.map(() => null);
  const sp = buildHudSpec(tl, {});
  assert.strictEqual(sp.channels.bat.valid, false);
  void BOX;
});

test('speed readout: one decimal by default, whole numbers on request, and the number fits the ring', () => {
  assert.strictEqual(normalizeStyle({}).speedDecimals, 1);
  assert.strictEqual(normalizeStyle({ speedDecimals: 0 }).speedDecimals, 0);
  assert.strictEqual(normalizeStyle({ speedDecimals: '0' }).speedDecimals, 0);
  assert.strictEqual(normalizeStyle({ speedDecimals: 'x' }).speedDecimals, 1);
  // Saira HUD Bold: digits 0.62 em, the point 0.30 em. The widest number must stay under 280 px,
  // well inside the ring's inner edge (about 325 px wide where the digits' tops meet it).
  const width = (str, size) => [...str].reduce((a, c) => a + (c === '.' ? 0.30 : 0.62), 0) * size;
  for (const [max, dec] of [[0, 1], [8, 1], [45, 1], [99.4, 1], [99.96, 1], [120, 1], [45, 0], [188, 0]]) {
    const size = speedValueSize(max, dec);
    assert.ok(size >= 95 && size <= 150, max + ' ' + dec + ' size ' + size);
    assert.ok(width(Math.max(max, 10).toFixed(dec), size) <= 280, max + ' ' + dec + ' too wide at ' + size);
  }
  assert.strictEqual(speedValueSize(45, 0), 150, 'whole numbers keep the 0.1.2 size');
  assert.strictEqual(speedValueSize(45, 1), 125);
  assert.strictEqual(speedValueSize(120, 1), 100);
  const tl = synthTimeline({ minutes: 5 });
  const sp = buildHudSpec(tl, {}).widgets.find((x) => x.id === 'speed').p;
  assert.strictEqual(sp.decimals, 1); assert.strictEqual(sp.valueSize, 125);
  const whole = buildHudSpec(tl, { speedDecimals: 0 }).widgets.find((x) => x.id === 'speed').p;
  assert.strictEqual(whole.decimals, 0); assert.strictEqual(whole.valueSize, 150);
});
