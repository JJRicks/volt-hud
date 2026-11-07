'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../core/parse/volt');
const D = require('../core/derive/derive');
const S = require('../core/util/signal');
const { parseCsv } = require('../core/util/csv');
const { buildTimeline, nullRuns } = require('../core/timeline');

const HDR = 'schema_version,event,recorded_utc,wall_ms,monotonic_ms,frame,key,numeric,text,unit,source_command,sensor_updated_monotonic_ms,sensor_age_ms,current_direction,details';
function sensors(rows) { return [HDR].concat(rows.map((r) => r.join(','))).join('\n') + '\n'; }
function frame(f, m, entries) {
  const out = [['1', 'BEGIN', '', 0, m, f, '', entries.length, '', '', '', '', '', '', '']];
  for (const e of entries) out.push(['1', 'SENSOR', '', 0, m, f, e[0], e[1], '', '', e[2], e[3], '', '', '']);
  out.push(['1', 'COMMIT', '', 0, m, f, '', '', '', '', '', '', '', '', '']);
  return out;
}

test('CSV parser handles quotes, commas and CRLF', () => {
  assert.deepStrictEqual(parseCsv('a,"b,c","d""e"\r\n1,,3\n'), [['a', 'b,c', 'd"e'], ['1', '', '3']]);
});

test('sensor journal: committed frames only, dedupe by update time, V*A power with direction', () => {
  const rows = [['1', 'START', '', 1000, 100, '', 'p', '', '"Label, with comma"', '', '', '', '', 'POSITIVE_IS_DRAW', '']]
    .concat(frame(1, 1000, [['speed_kmh', 10, '146', 990], ['voltage_v', 50, '144', 995], ['current_a', 2, '144', 995]]))
    .concat(frame(2, 2000, [['speed_kmh', 10, '146', 990], ['voltage_v', 50, '144', 1995], ['current_a', -4, '144', 1995]]))
    .concat([['1', 'DIRECTION', '', 0, 2500, '', '', '', '', '', '', '', '', 'NEGATIVE_IS_DRAW', '']])
    .concat(frame(3, 3000, [['speed_kmh', 12, '146', 2990], ['voltage_v', 51, '144', 2995], ['current_a', -3, '144', 2995], ['current_a_other', 1, '144', 2995]]))
    // an uncommitted frame must be ignored
    .concat([['1', 'BEGIN', '', 0, 4000, 4, '', 1, '', '', '', '', '', '', ''], ['1', 'SENSOR', '', 0, 4000, 4, 'speed_kmh', 99, '', '', '146', 3990, '', '', '']]);
  const s = V.parseSensors(sensors(rows));
  assert.strictEqual(s.start.label, 'Label, with comma');
  assert.deepStrictEqual(s.series.speed_kmh.v, [10, 12]);
  assert.deepStrictEqual(s.directions.map((d) => d[1]), ['POSITIVE_IS_DRAW', 'NEGATIVE_IS_DRAW']);
  const p = V.powerSeries(s.series, s.directions);
  assert.deepStrictEqual(p.rawW, [100, -200, -153]);
  assert.deepStrictEqual(p.w, [100, -200, 153]); // after the flip, negative current is draw
  assert.deepStrictEqual(p.dir, [1, -1, 1]);
  const u = V.powerSeries(s.series, [[0, 'UNCONFIRMED']]);
  assert.deepStrictEqual(u.dir, [0, 0, 0]);
  assert.deepStrictEqual(u.w, [100, 200, 153]);
});

test('clock fit maps mono to UTC with slope and offset', () => {
  const m = [], u = [];
  for (let i = 0; i < 50; i++) { m.push(1e6 + i * 1000); u.push(1.79e12 + i * 1000.02 + (i === 20 ? 900 : 0)); }
  const c = V.fitClock(m, u, [], []);
  assert.ok(Math.abs(c.driftPpm - 20) < 0.5, c.driftPpm);
  assert.ok(Math.abs(V.monoToUtc(c, 1e6 + 10000) - (1.79e12 + 10000.2)) < 1);
});

test('derivations: vertical rate, longitudinal and lateral g, jerk on analytic curves', () => {
  const t = [], hPa = [];
  for (let i = 0; i <= 120; i++) { t.push(i * 1000); hPa.push(1013.25 * Math.pow(1 - (0.5 * i) / 44330.77, 1 / 0.190263)); } // climbs 0.5 m/s
  const grid = []; for (let m = 20000; m <= 100000; m += 100) grid.push(m);
  const vt = D.vertical({ phone: { pressure: { t, hPa }, gps: { t: [], alt: [], vAcc: [] } } }, grid);
  assert.strictEqual(vt.source, 'barometer');
  assert.ok(Math.abs(S.median(vt.vert) - 0.5) < 0.01, 'vert ' + S.median(vt.vert));

  // speed ramps at 2 m/s^2; yaw 0.2 rad/s about up => lat = v*0.2
  const mono = [], v = [];
  for (let i = 0; i < 300; i++) { mono.push(i * 100); v.push(5 + 0.2 * i * 0.1 * 10); }
  const q = [], mt = [];
  for (let i = 0; i < 600; i++) { const th = 0.2 * i * 0.05; mt.push(i * 50); q.push([0, 0, Math.sin(th / 2), Math.cos(th / 2)]); }
  const gf = D.gForces(Float64Array.from(v), Float64Array.from(mono), 10, { t: mt, quat: q });
  const k = 150;
  assert.ok(Math.abs(gf.lon[k] - 2 / D.G) < 0.005, 'lon ' + gf.lon[k]);
  assert.ok(Math.abs(gf.lat[k] - (v[k] * 0.2) / D.G) < 0.01, 'lat ' + gf.lat[k]);
  // jerk of a constant longitudinal accel + slowly growing lateral accel (v' * 0.2 = 0.4 m/s^3)
  assert.ok(Math.abs(gf.jerk[k] - 0.4) < 0.05, 'jerk ' + gf.jerk[k]);
});

test('nullRuns lists gaps in seconds', () => {
  assert.deepStrictEqual(nullRuns([null, null, 1, 2, null, 3], 10), [[0, 0.2], [0.4, 0.5]]);
});

test('timeline spans the whole .360 with nulls outside the ride', () => {
  const gopro = { durationS: 30, fps: 29.97, device: 'x', chapters: [{ file: 'GS010001.360', offsetS: 0, durationS: 30 }], gps: null };
  const sp = { t: [], v: [], cmd: [] }, vv = { t: [], v: [], cmd: [] }, aa = { t: [], v: [], cmd: [] }, bb = { t: [], v: [], cmd: [] };
  for (let i = 0; i <= 10; i++) { const m = 1e6 + i * 1000; sp.t.push(m); sp.v.push(18); vv.t.push(m); vv.v.push(50); aa.t.push(m); aa.v.push(2); bb.t.push(m); bb.v.push(80); }
  const series = { speed_kmh: sp, voltage_v: vv, current_a: aa, battery_percent: bb };
  const directions = [[1e6, 'POSITIVE_IS_DRAW']];
  const volt = { files: {}, start: { mono: 1e6, direction: 'POSITIVE_IS_DRAW' }, stop: { mono: 1e6 + 10000 }, scooter: { series, directions }, power: V.powerSeries(series, directions), clock: { utc0: 1.79e12, mono0: 1e6, slope: 1 } };
  const sync = { monoRefMs: 1e6, videoAtRefS: 5, slope: 1, stats: {}, notes: [], coarse: {} };
  const tl = buildTimeline(gopro, volt, sync, { rateHz: 10 });
  assert.strictEqual(tl.samples, 300);
  assert.strictEqual(tl.channels.speedKmh.length, 300);
  assert.strictEqual(tl.channels.speedKmh[0], null);
  assert.strictEqual(tl.channels.speedSrc[100], 'scooter');
  assert.ok(Math.abs(tl.channels.speedKmh[100] - 18) < 1e-6);
  assert.strictEqual(tl.channels.powerW[100], 100);
  assert.strictEqual(tl.channels.powerDir[100], 1);
  assert.strictEqual(tl.channels.powerW[200], null);
  assert.deepStrictEqual(tl.gaps.powerW, [[0, 5], [15.1, 30]]);
  assert.ok(!('lat' in tl.channels), 'coordinates are off by default');
});
