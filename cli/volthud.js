#!/usr/bin/env node
'use strict';
// volthud CLI. Commands:
//   volthud probe <360...>                         streams, rates, GPS time/fix (JSON)
//   volthud sync <360...> --volt <dir|files> --out <dir> [--nudge-ms N] [--rate 10] [--coords] [--no-imu]
// Output files are written with mode 600 into a mode-700 directory (ride data is private).

const fs = require('fs');
const path = require('path');
const core = require('../core');

function parseArgs(argv) {
  const a = { _: [], volt: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--volt') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) a.volt.push(argv[++i]); }
    else if (x === '--out') a.out = argv[++i];
    else if (x === '--nudge-ms') a.nudgeMs = Number(argv[++i]);
    else if (x === '--rate') a.rate = Number(argv[++i]);
    else if (x === '--coords') a.coords = true;
    else if (x === '--no-imu') a.noImu = true;
    else if (x === '--tz') a.tz = argv[++i];
    else if (x === '-h' || x === '--help') a.help = true;
    else a._.push(x);
  }
  return a;
}

const USAGE = 'usage:\n  volthud probe <360...>\n  volthud sync <360...> --volt <dir|files> --out <dir> [--nudge-ms N] [--rate 10] [--coords] [--no-imu] [--tz Area/City]\n';

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function probe(files) {
  const g = await core.gopro.loadGoPro(files);
  const out = {
    device: g.device, durationS: g.durationS, fps: g.fps, gpsSource: g.gps ? g.gps.src : null,
    chapters: g.chapters.map((c) => ({ file: c.file, startS: c.offsetS, durationS: c.durationS, fps: c.fps, creationTime: c.info.creationTime, gpmdTrackIndex: c.info.gpmdTrackIndex,
      gpmdSamples: c.info.gpmdSamples, gpmdBytes: c.info.gpmdBytes, tracks: c.info.tracks,
      streams: Object.keys(c.streams).reduce((o, k) => { o[k] = Object.assign({}, c.streams[k], { rateHz: Math.round((c.streams[k].samples / c.durationS) * 10) / 10 }); return o; }, {}),
      gps: c.gpsMeta })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

async function sync(a) {
  if (!a._.length || !a.volt.length || !a.out) { process.stderr.write(USAGE); process.exit(2); }
  fs.mkdirSync(a.out, { recursive: true, mode: 0o700 });
  const gopro = await core.gopro.loadGoPro(a._);
  const volt = core.volt.loadVolt(a.volt);
  const base = volt.summary && volt.summary.id ? 'ride-' + String(volt.summary.id).slice(0, 8) : path.basename(a._[0]).replace(/\.[^.]+$/, '');
  const tlPath = path.join(a.out, base + '.volthud.json');
  let nudgeMs = a.nudgeMs;
  if (nudgeMs == null && fs.existsSync(tlPath)) {
    try { nudgeMs = JSON.parse(fs.readFileSync(tlPath, 'utf8')).sync.nudge_ms || 0; } catch (e) { nudgeMs = 0; }
  }
  const s = core.sync.syncRide(gopro, volt, { nudgeMs: nudgeMs || 0, imu: !a.noImu });
  const tl = core.timeline.buildTimeline(gopro, volt, s, { rateHz: a.rate || 10, coords: !!a.coords, tz: a.tz });
  writePrivate(tlPath, JSON.stringify(tl));
  const syncOut = Object.assign({}, s);
  if (syncOut.speed) syncOut.speed = Object.assign({}, syncOut.speed, { curve: undefined });
  if (syncOut.imu && syncOut.imu.global) syncOut.imu = Object.assign({}, syncOut.imu, { global: Object.assign({}, syncOut.imu.global, { curve: undefined }) });
  writePrivate(path.join(a.out, base + '.sync.json'), JSON.stringify(syncOut, null, 2));
  writePrivate(path.join(a.out, base + '.sync.html'), core.report.buildReport(gopro, volt, s, tl));
  const line = (k, v) => process.stdout.write(k.padEnd(22) + v + '\n');
  line('ride start in video', s.rideStartVideoS.toFixed(3) + ' s');
  line('coarse (GPS time)', s.coarse.rideStartVideoS.toFixed(3) + ' s');
  line('correction', s.correctionFromCoarseMs + ' ms');
  line('method', s.method);
  line('confidence', s.confidence + ' (score ' + s.score + ')');
  if (s.peak) line('peak / 2nd', s.peak.value.toFixed(3) + ' / ' + (s.peak.secondBest ? s.peak.secondBest.peak.toFixed(3) + ' at ' + s.peak.secondBest.deltaS.toFixed(2) + ' s' : '-') + ', PSR ' + s.peak.psr.toFixed(1));
  if (s.imu && s.imu.fit) line('imu residual', s.imu.fit.residualMs.toFixed(1) + ' ms over ' + s.imu.fit.windowsUsed + ' windows');
  s.notes.forEach((n) => line('note', n));
  line('wrote', tlPath + ' (+ .sync.json, .sync.html)');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (!cmd || a.help) { process.stdout.write(USAGE); return; }
  if (cmd === 'probe') return probe(a._);
  if (cmd === 'sync') return sync(a);
  process.stderr.write('unknown command ' + cmd + '\n' + USAGE);
  process.exit(2);
}

main().catch((e) => { process.stderr.write((e && e.stack) || String(e)); process.stderr.write('\n'); process.exit(1); });
