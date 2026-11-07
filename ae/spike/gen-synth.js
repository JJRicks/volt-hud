#!/usr/bin/env node
// M0 spike: synthetic ride timeline (no owner data). 10 Hz, 12 channels, null gaps.
// Usage: node ae/spike/gen-synth.js <minutes> <out.json>
'use strict';
const fs = require('fs');
const minutes = Number(process.argv[2] || 60);
const out = process.argv[3] || `ae/spike/out/synth-${minutes}.json`;
const rateHz = 10, n = Math.round(minutes * 60 * rateHz), dur = minutes * 60;
const names = ['speedKmh', 'powerW', 'batteryPct', 'vertMps', 'gradePct', 'gLon', 'gLat',
  'jerk', 'lat', 'lon', 'clockS', 'tempC'];
// gap ranges in seconds per channel group (scaled to ride length)
const scooterGaps = [[0, 20], [dur * 0.5, dur * 0.5 + 30], [dur - 25, dur]];
const gpsGaps = [[dur * 0.33, dur * 0.33 + 15]];
const scooter = new Set(['speedKmh', 'powerW', 'batteryPct', 'tempC', 'gradePct']);
const gps = new Set(['lat', 'lon']);
const inGap = (t, g) => g.some(([a, b]) => t >= a && t < b);
const r2 = (x) => Math.round(x * 100) / 100;
const ch = {}; for (const k of names) ch[k] = new Array(n);
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let i = 0; i < n; i++) {
  const t = i / rateHz;
  const speed = Math.max(0, 22 + 10 * Math.sin(t / 37) + 5 * Math.sin(t / 7.3) + (rnd() - 0.5));
  const accel = 10 * Math.cos(t / 37) / 37 + 5 * Math.cos(t / 7.3) / 7.3;
  const power = accel * 2500 + speed * 12; // negative when braking = regen
  const v = {
    speedKmh: speed, powerW: power, batteryPct: 95 - 70 * (t / dur), vertMps: 0.4 * Math.sin(t / 19),
    gradePct: 3 * Math.sin(t / 61), gLon: accel / 9.81, gLat: 0.1 * Math.sin(t / 5),
    jerk: 0.2 * Math.cos(t / 3), lat: 43.6 + 0.01 * Math.sin(t / 400), lon: -116.2 + 0.01 * Math.cos(t / 400),
    clockS: (17 * 3600 + 4 * 60 + 12 + t) % 86400, tempC: 31 + 6 * (t / dur),
  };
  for (const k of names) {
    const gap = (scooter.has(k) && inGap(t, scooterGaps)) || (gps.has(k) && inGap(t, gpsGaps));
    ch[k][i] = gap ? null : (k === 'lat' || k === 'lon' ? Math.round(v[k] * 1e6) / 1e6 : r2(v[k]));
  }
}
const gaps = [...scooterGaps.map((g) => [...g, 'scooter']), ...gpsGaps.map((g) => [...g, 'gps'])];
fs.writeFileSync(out, JSON.stringify({ format: 'volthud-synth', rateHz, n, durationS: dur, fps: 29.97, gaps, channels: ch }));
console.log(out, n, 'samples', fs.statSync(out).size, 'bytes');
