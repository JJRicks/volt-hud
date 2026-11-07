'use strict';
// Synthetic ride.volthud.json (no owner data): the core's timeline format with every HUD
// channel, null gaps before/after the ride and mid-ride, and optional made-up coordinates
// (a loop around a fictional point). Usage:
//   node tools/fixtures/synth-timeline.js <minutes> <out.json> [--coords] [--seed N]

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function synthTimeline(o) {
  o = Object.assign({ minutes: 60, rateHz: 10, fps: 30000 / 1001, coords: false, seed: 11, startUtc: Date.UTC(2026, 10, 7, 0, 36, 22, 952) }, o);
  const r = rng(o.seed);
  const dur = Math.round(o.minutes * 60 * o.fps) / o.fps;
  const rate = o.rateHz, n = Math.max(1, Math.round(dur * rate));
  const rideStart = Math.min(11.3, dur * 0.05), rideEnd = dur - Math.min(45, dur * 0.2);
  const gap = [dur * 0.5, dur * 0.5 + Math.min(30, dur * 0.03)]; // scooter link dropout
  const ch = {}; const names = ['speedKmh', 'speedSrc', 'powerW', 'powerDir', 'batteryPct', 'altM', 'vertMps', 'gradePct', 'gLon', 'gLat', 'gTotal', 'jerk', 'utcMs'];
  if (o.coords) names.push('lat', 'lon');
  for (const k of names) ch[k] = new Array(n).fill(null);
  let v = 0, alt = 0, lat = 0.0, lon = 0.0, hdg = 0, bat = 92, prevA = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    ch.utcMs[i] = Math.round(o.startUtc + t * 1000);
    if (t < rideStart || t > rideEnd) continue;
    const rt = t - rideStart;
    const target = Math.max(0, 24 + 14 * Math.sin(rt / 41) + 8 * Math.sin(rt / 9.7) + (Math.sin(rt / 97) > 0.93 ? -40 : 0));
    const a = Math.max(-3, Math.min(2.2, (target / 3.6 - v) * 0.6)) + (r() - 0.5) * 0.05; // m/s^2
    v = Math.max(0, v + a / rate);
    const grade = 4 * Math.sin(rt / 63);
    const vert = (v * grade) / 100;
    alt += vert / rate;
    hdg += (0.12 * Math.sin(rt / 17)) / rate;
    lat += (v * Math.cos(hdg)) / rate / 110540; lon += (v * Math.sin(hdg)) / rate / 80000;
    const powerW = v > 0.3 ? 30 * v + 900 * a + 40 * grade : 0;
    bat = Math.max(3, bat - (Math.max(0, powerW) / rate / 3600) * 0.18 - 0.0004);
    const inGap = t >= gap[0] && t < gap[1];
    const gLon = a / 9.80665, gLat = (v * 0.12 * Math.sin(rt / 17) * 2) / 9.80665;
    if (!inGap) {
      ch.speedKmh[i] = Math.round(v * 3.6 * 100) / 100; ch.speedSrc[i] = 'scooter';
      ch.powerW[i] = Math.round(powerW * 10) / 10; ch.powerDir[i] = 1;
      ch.batteryPct[i] = Math.round(bat);
      ch.gLon[i] = Math.round(gLon * 1000) / 1000; ch.gLat[i] = Math.round(gLat * 1000) / 1000;
      ch.gTotal[i] = Math.round(Math.hypot(gLon, gLat) * 1000) / 1000;
      ch.jerk[i] = Math.round(Math.abs(a - prevA) * rate * 100) / 100;
    }
    prevA = a;
    ch.altM[i] = Math.round(alt * 100) / 100; ch.vertMps[i] = Math.round(vert * 1000) / 1000;
    if (v > 4) ch.gradePct[i] = Math.round(grade * 10) / 10;
    if (o.coords) { ch.lat[i] = Math.round((10 + lat) * 1e6) / 1e6; ch.lon[i] = Math.round((20 + lon) * 1e6) / 1e6; }
  }
  return {
    format: 'volthud-timeline', version: 1,
    video: { files: ['GS019999.360'], chapters: [{ file: 'GS019999.360', startS: 0, durationS: dur }], fps: o.fps, durationS: dur, device: 'Synthetic', startUtc: new Date(o.startUtc).toISOString() },
    sync: { model: 'linear', method: 'synthetic', confidence: 'high', score: 1, nudge_ms: 0, rideStartVideoS: rideStart },
    tz: 'America/Boise', rateHz: rate, samples: n,
    ride: { videoStartS: rideStart, videoEndS: rideEnd, direction: 'POSITIVE_IS_DRAW', files: {} },
    channels: ch, gaps: {}, stats: {},
    style: { preset: 'focus', units: 'metric', accent: '#E32B2F', coords: !!o.coords, safe: 0.05, comp: [1920, 1080] },
  };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const minutes = Number(a[0] || 60), out = a[1] || 'synth-' + minutes + '.volthud.json';
  const tl = synthTimeline({ minutes, coords: a.indexOf('--coords') >= 0, seed: a.indexOf('--seed') >= 0 ? Number(a[a.indexOf('--seed') + 1]) : undefined });
  require('fs').writeFileSync(out, JSON.stringify(tl));
  console.log(out, tl.samples, 'samples', tl.video.durationS.toFixed(3), 's');
}
module.exports = { synthTimeline };
