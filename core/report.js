'use strict';
// Self-contained HTML sync report: speed (and IMU) curves before and after
// alignment, correlation curves with the best and second-best peaks, IMU
// windows and the drift/residual. Never includes coordinates.

const S = require('./util/signal');
const Y = require('./sync/sync');

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function f(x, d) { return Number.isFinite(x) ? x.toFixed(d == null ? 2 : d) : '–'; }

// Line chart as inline SVG. series: [{name, cls, x, y}]. marks: [{x, label}].
function lineChart(id, title, series, opts) {
  const W = 760, H = opts.height || 190, L = 48, R = 12, T = 10, B = 26;
  let x0 = opts.x0, x1 = opts.x1, y0 = opts.y0, y1 = opts.y1;
  if (x0 == null || x1 == null) { x0 = Infinity; x1 = -Infinity; series.forEach((s) => s.x.forEach((v) => { if (v < x0) x0 = v; if (v > x1) x1 = v; })); }
  if (y0 == null || y1 == null) {
    let a = Infinity, b = -Infinity;
    series.forEach((s) => s.y.forEach((v) => { if (Number.isFinite(v)) { if (v < a) a = v; if (v > b) b = v; } }));
    if (!(b > a)) { a = 0; b = 1; }
    y0 = y0 == null ? a : y0; y1 = y1 == null ? b + (b - a) * 0.05 : y1;
  }
  const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = (a, b, k) => { const step = niceStep((b - a) / k); const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6); return out; };
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="' + esc(title) + '" data-x0="' + x0 + '" data-x1="' + x1 + '" data-l="' + L + '" data-r="' + R + '">';
  ticks(y0, y1, 4).forEach((v) => { svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/><text class="tick" x="' + (L - 6) + '" y="' + (sy(v) + 4) + '" text-anchor="end">' + v + '</text>'; });
  ticks(x0, x1, 8).forEach((v) => { svg += '<text class="tick" x="' + sx(v) + '" y="' + (H - 8) + '" text-anchor="middle">' + v + '</text>'; });
  (opts.bands || []).forEach((b) => { svg += '<rect class="band" x="' + sx(b[0]) + '" width="' + Math.max(1, sx(b[1]) - sx(b[0])) + '" y="' + T + '" height="' + (H - T - B) + '"/>'; });
  series.forEach((s) => {
    if (s.dots) { s.x.forEach((x, i) => { if (Number.isFinite(s.y[i])) svg += '<circle class="' + s.cls + (s.hollow && s.hollow[i] ? ' hollow' : '') + '" cx="' + sx(x).toFixed(1) + '" cy="' + sy(s.y[i]).toFixed(1) + '" r="4"/>'; }); return; }
    let d = '', pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const v = s.y[i];
      if (!Number.isFinite(v) || s.x[i] < x0 || s.x[i] > x1) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + sx(s.x[i]).toFixed(1) + ' ' + sy(Math.max(y0, Math.min(y1, v))).toFixed(1);
      pen = true;
    }
    svg += '<path class="line ' + s.cls + '" d="' + d + '"/>';
  });
  (opts.marks || []).forEach((m) => { svg += '<line class="mark" x1="' + sx(m.x) + '" x2="' + sx(m.x) + '" y1="' + T + '" y2="' + (H - B) + '"/><text class="marklabel" x="' + (sx(m.x) + 4) + '" y="' + (T + 12) + '">' + esc(m.label) + '</text>'; });
  svg += '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/></svg>';
  const legend = series.length > 1 ? '<div class="legend">' + series.map((s) => '<span><i class="sw ' + s.cls + '"></i>' + esc(s.name) + '</span>').join('') + '</div>' : '';
  const data = JSON.stringify(series.filter((s) => !s.dots).map((s) => ({ n: s.name, x: decim(s.x), y: decim(s.y) })));
  return '<figure id="' + id + '"><figcaption>' + esc(title) + (opts.xlabel ? ' <span class="muted">(' + esc(opts.xlabel) + ')</span>' : '') + '</figcaption>' + legend +
    '<div class="plot">' + svg + '<div class="tip" hidden></div></div><script type="application/json" class="series">' + data.replace(/</g, '\\u003c') + '</script></figure>';
}
function decim(a) { return Array.from(a, (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)); }
function niceStep(r) { const p = Math.pow(10, Math.floor(Math.log10(r))); const m = r / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }

function zs(a) { const m = S.mean(a), s = S.std(a) || 1; return Array.from(a, (v) => (v - m) / s); }

function imuTraces(gopro, volt, model, t0, t1) {
  const rate = 50;
  const g = Y.grid(t0, t1, rate);
  const ga = { t: gopro.accl.t, v: Array.from(gopro.accl.t, (_, i) => Math.hypot(gopro.accl.x[i], gopro.accl.y[i], gopro.accl.z[i])) };
  const pa = { t: volt.motion.t, v: volt.motion.raw.map((r) => Math.hypot(r[0], r[1], r[2])) };
  const env = (x) => S.movingAverage(Array.from(x, Math.abs), 12);
  const a = env(Y.accelFeature(ga.t, ga.v, null, g, rate));
  const b = env(Y.accelFeature(pa.t, pa.v, model, g, rate));
  const pick = (x) => x.filter((_, i) => i % 5 === 0);
  return { x: pick(Array.from(g)), a: zs(pick(a)), b: zs(pick(b)) };
}

function buildReport(gopro, volt, sync, timeline) {
  const coarse = Y.makeModel(sync.monoRefMs, sync.coarse.videoAtRefS, sync.coarse.slope);
  const final = Y.modelOf(sync);
  const dur = gopro.durationS;
  const vs = Y.voltSpeeds(volt);
  const gs = Y.goproSpeed(gopro);
  const kmh = (v) => v.map((x) => x * 3.6);
  const speedSeries = (m) => {
    const out = [];
    if (gs) out.push({ name: 'GoPro GPS', cls: 's1', x: gs.t, y: kmh(gs.v) });
    if (vs.scooter) out.push({ name: 'Scooter dash', cls: 's2', x: vs.scooter.t.map((t) => Y.monoToVideo(m, t)), y: kmh(vs.scooter.v) });
    if (vs.phone) out.push({ name: 'Phone GPS', cls: 's3', x: vs.phone.t.map((t) => Y.monoToVideo(m, t)), y: kmh(vs.phone.v) });
    return out;
  };
  const yMax = Math.max(10, ...[].concat(...speedSeries(final).map((s) => s.y)).filter(Number.isFinite)) * 1.05;
  const sec = [];
  const tiles = [
    ['Ride start in video', f(sync.rideStartVideoS, 3) + ' s'],
    ['Confidence', sync.confidence + ' (' + f(sync.score, 2) + ')'],
    ['Signals that agree', esc((sync.agreed || []).join(', ') || '–')],
    [sync.mode && sync.mode !== 'gnss' ? 'Coarse (' + esc(sync.mode) + ')' : 'Coarse (GPS time)', f(sync.coarse.rideStartVideoS, 3) + ' s'],
    ['Correction', (sync.correctionFromCoarseMs >= 0 ? '+' : '') + sync.correctionFromCoarseMs + ' ms'],
    ['IMU residual', sync.imu && sync.imu.fit ? f(sync.imu.fit.residualMs, 1) + ' ms (' + sync.imu.fit.windowsUsed + ' windows)' : '–'],
    ['Drift', f(sync.d1_ppm, 1) + ' ppm'],
  ];
  sec.push('<div class="tiles">' + tiles.map((t) => '<div class="tile"><div class="k">' + esc(t[0]) + '</div><div class="v">' + esc(t[1]) + '</div></div>').join('') + '</div>');
  if (sync.summary) sec.push('<p class="method"><b>' + esc(sync.summary) + '</b></p>');
  if (sync.search && sync.search.best) sec.push('<p class="method">Whole-ride search: best ' + f(sync.search.best.startS, 1) + ' s' + (sync.search.second ? ', next best ' + f(sync.search.second.startS, 1) + ' s at ' + Math.round(sync.search.ratio * 100) + ' % of the best score' : '') + ' (overlap at least ' + f(sync.search.minOverlapS, 0) + ' s). ' +
    Object.keys(sync.search.methods).map((k) => esc(sync.search.methods[k].label) + (sync.search.methods[k].agrees ? ' agrees' : ' does not agree')).join('; ') + '.</p>');
  sec.push('<p class="method">Method <b>' + esc(sync.method) + '</b>, decided by <b>' + esc(sync.decidedBy) + '</b>.' +
    (sync.peak && sync.peak.value != null ? ' Peak NCC ' + f(sync.peak.value, 3) + ', PSR ' + f(sync.peak.psr, 1) + (sync.peak.secondBest ? '; second-best peak at ' + f(sync.peak.secondBest.deltaS, 2) + ' s (NCC ' + f(sync.peak.secondBest.peak, 3) + ', ratio ' + f(sync.peak.secondToBestRatio, 2) + ')' : '') + '.' : '') + '</p>');
  if (sync.notes.length) sec.push('<ul class="notes">' + sync.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>');

  const ride = [timeline.ride.videoStartS, timeline.ride.videoEndS];
  const noData = [];
  if (ride[0] > 0) noData.push([0, ride[0]]);
  if (ride[1] < dur) noData.push([ride[1], dur]);
  sec.push('<h2>Speed</h2>');
  sec.push(lineChart('sp-before', 'Before alignment: coarse map from GPS time', speedSeries(coarse), { x0: 0, x1: dur, y0: 0, y1: yMax, xlabel: 'km/h vs video seconds' }));
  sec.push(lineChart('sp-after', 'After alignment', speedSeries(final), { x0: 0, x1: dur, y0: 0, y1: yMax, xlabel: 'km/h vs video seconds; shaded = no Volt data', bands: noData }));
  if (!gs) sec.push('<p class="muted">The GoPro has no GPS speed with a fix in this clip, so only the Volt curves are shown; the IMU panels below carry the alignment.</p>');

  if (sync.speed && sync.speed.curve) {
    sec.push(lineChart('sp-xc', 'Speed cross-correlation (GoPro GPS vs ' + sync.speed.against + ')', [{ name: 'NCC', cls: 's1', x: sync.speed.curve.deltaS, y: sync.speed.curve.ncc }],
      { xlabel: 'correction, s', marks: [{ x: sync.speed.deltaS, label: 'best' }].concat(sync.speed.second ? [{ x: sync.speed.second.deltaS, label: '2nd' }] : []) }));
  }
  if (sync.imu && sync.imu.global && gopro.accl && volt.motion) {
    sec.push('<h2>IMU (|accel| shock envelope)</h2>');
    const p0 = Math.max(0, ride[0] - 5), p1 = Math.min(dur, ride[1] + 5);
    const tb = imuTraces(gopro, volt, coarse, p0, p1), ta = imuTraces(gopro, volt, final, p0, p1);
    sec.push(lineChart('imu-before', 'Before: coarse map', [{ name: 'GoPro ACCL', cls: 's1', x: tb.x, y: tb.a }, { name: 'Phone accel', cls: 's2', x: tb.x, y: tb.b }], { y0: -2, y1: 5, xlabel: 'z-score vs video seconds' }));
    sec.push(lineChart('imu-after', 'After alignment', [{ name: 'GoPro ACCL', cls: 's1', x: ta.x, y: ta.a }, { name: 'Phone accel', cls: 's2', x: ta.x, y: ta.b }], { y0: -2, y1: 5, xlabel: 'z-score vs video seconds' }));
    const gl = sync.imu.global;
    sec.push(lineChart('imu-xc', 'IMU cross-correlation over the whole ride', [{ name: 'NCC', cls: 's1', x: gl.curve.deltaS, y: gl.curve.ncc }],
      { xlabel: 'correction from coarse, s', marks: [{ x: gl.deltaS, label: 'best ' + f(gl.deltaS, 2) }].concat(gl.second ? [{ x: gl.second.deltaS, label: '2nd' }] : []) }));
    if (sync.imu.windows && sync.imu.windows.length) {
      const w = sync.imu.windows;
      const fit = sync.imu.fit;
      const series = [{ name: 'Window lag (filled = used)', cls: 's1', dots: true, x: w.map((x) => x.tS), y: w.map((x) => x.deltaS * 1000), hollow: w.map((x) => !x.inlier) }];
      if (fit) {
        const xs = [w[0].tS, w[w.length - 1].tS];
        series.push({ name: 'Fit', cls: 's2', x: xs, y: xs.map((t) => (fit.deltaAtRefS + fit.driftPerS * (t - fit.tRefS)) * 1000) });
      }
      const ys = w.map((x) => x.deltaS * 1000);
      sec.push(lineChart('imu-win', 'Windowed IMU lags (' + f(sync.imu.windowS, 0) + ' s windows)', series, { y0: Math.min.apply(null, ys) - 100, y1: Math.max.apply(null, ys) + 100, xlabel: 'ms correction vs video seconds' }));
      sec.push(table(['Centre (s)', 'Lag (ms)', 'NCC', 'PSR', 'Weight', 'Used'], w.map((x) => [f(x.tS, 1), f(x.deltaS * 1000, 0), f(x.peak, 2), f(x.psr, 1), f(x.conf, 2), x.inlier ? 'yes' : 'no'])));
      if (fit && fit.driftNote) sec.push('<p class="muted">' + esc(fit.driftNote) + (Number.isFinite(fit.unconstrainedDriftPpm) ? ' (unconstrained fit: ' + f(fit.unconstrainedDriftPpm, 0) + ' ppm)' : '') + '</p>');
    }
  }

  sec.push('<h2>Inputs</h2>');
  sec.push(table(['Chapter', 'Start (s)', 'Duration (s)', 'fps', 'gpmd samples', 'GPS UTC span', 'GPS fix (count)'], gopro.chapters.map((c) => [c.file, f(c.offsetS, 3), f(c.durationS, 3), f(c.fps, 3), c.info.gpmdSamples, (c.gpsMeta.utcStart || '–') + ' → ' + (c.gpsMeta.utcEnd || '–'), JSON.stringify(c.gpsMeta.fixHistogram)])));
  const st = {};
  gopro.chapters.forEach((c) => { for (const k in c.streams) { st[k] = st[k] || { n: 0, name: c.streams[k].name }; st[k].n += c.streams[k].samples; } });
  sec.push(table(['Stream', 'Name', 'Samples', 'Rate (Hz)'], Object.keys(st).map((k) => [k, st[k].name, st[k].n, f(st[k].n / dur, 1)])));
  const sclock = sync.stats.phoneClock || {}, gclock = sync.stats.goproClock || {};
  sec.push(table(['Clock fit', 'Source', 'Samples', 'RMS (ms)', 'Drift (ppm)', 'Note'], [
    ['Phone mono → UTC', sclock.source || '–', sclock.n || '–', f(sclock.rmsMs, 1), f(sclock.driftPpm, 1), Number.isFinite(sclock.wallMinusGnssMs) ? 'phone wall clock − GNSS = ' + sclock.wallMinusGnssMs + ' ms' : ''],
    ['GoPro video → UTC', gclock.withFix ? 'GPS (fix)' : 'GPSU (no fix)', gclock.n || '–', f(gclock.rmsMs, 1), f(gclock.driftPpm, 1), 'median |residual| ' + f(gclock.madMs, 1) + ' ms'],
  ]));
  if (sync.stats.scooterLag) sec.push('<p>Scooter speed vs phone GPS: lag ' + sync.stats.scooterLag.lagMs + ' ms (NCC ' + f(sync.stats.scooterLag.peak, 3) + ', PSR ' + f(sync.stats.scooterLag.psr, 1) + '; positive = scooter value arrives later).</p>');
  const ts = timeline.stats;
  sec.push(table(['Trip (km)', 'Max (km/h)', 'Avg moving (km/h)', 'Max power (W)', 'Min power (W)', 'Draw / regen (Wh)', 'Battery (%)', 'Ascent / descent (m)'],
    [[f(ts.tripKm, 2), f(ts.maxKmh, 1), f(ts.avgMovingKmh, 1), ts.maxPowerW, ts.minPowerW, f(ts.drawWh, 1) + ' / ' + f(ts.regenWh, 1), ts.batteryStartPct + ' → ' + ts.batteryEndPct, f(ts.ascentM, 1) + ' / ' + f(ts.descentM, 1)]]));
  sec.push('<p class="muted">Speed sources (samples at ' + timeline.rateHz + ' Hz): ' + esc(JSON.stringify(ts.speedSourceSamples)) + '. Coordinates are never included in this report.</p>');

  return page('Volt HUD sync', sec.join('\n'));
}

function table(head, rows) {
  return '<div class="tw"><table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}

function page(title, bodyHtml) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><main><h1>' + esc(title) + '</h1>' + bodyHtml + '</main><script>' + JS + '</script></body></html>';
}

const CSS = `
:root{color-scheme:light;--bg:#fcfcfb;--fg:#0b0b0b;--fg2:#52514e;--grid:#e4e3df;--band:rgba(120,120,120,.12);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--card:#f3f2ef}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--grid:#34332f;--band:rgba(200,200,200,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--card:#242422}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--grid:#34332f;--band:rgba(200,200,200,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--card:#242422}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:800px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0 12px}h2{font-size:17px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tile{background:var(--card);border-radius:8px;padding:10px}.tile .k{color:var(--fg2);font-size:12px}.tile .v{font-size:18px;font-variant-numeric:tabular-nums}
.muted,.notes{color:var(--fg2)}figure{margin:12px 0}figcaption{font-weight:600;margin-bottom:4px}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--fg2);font-size:12px;margin-bottom:2px}.sw{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
.plot{position:relative}.chart{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--fg2);font-size:11px;font-variant-numeric:tabular-nums}
.line{fill:none;stroke-width:2;stroke-linejoin:round}.band{fill:var(--band)}
.s1{stroke:var(--s1)}.s2{stroke:var(--s2)}.s3{stroke:var(--s3)}
.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}.sw.s3{background:var(--s3)}
circle.s1{fill:var(--s1);stroke:var(--bg);stroke-width:2}circle.hollow{fill:var(--bg);stroke:var(--s1)}
.mark{stroke:var(--fg2);stroke-dasharray:3 3}.marklabel{fill:var(--fg2);font-size:11px}.cross{stroke:var(--fg2)}
.tip{position:absolute;top:4px;pointer-events:none;background:var(--card);color:var(--fg);border-radius:6px;padding:4px 8px;font-size:12px;font-variant-numeric:tabular-nums;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.tw{overflow-x:auto}table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;margin:8px 0}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--grid)}th{color:var(--fg2);font-weight:600}
`;

const JS = `
document.querySelectorAll('figure').forEach(function(fig){
  var svg=fig.querySelector('svg'),tip=fig.querySelector('.tip'),js=fig.querySelector('script.series');if(!svg||!js)return;
  var data=JSON.parse(js.textContent);if(!data.length)return;var cross=svg.querySelector('.cross');
  var x0=+svg.dataset.x0,x1=+svg.dataset.x1,L=+svg.dataset.l,R=+svg.dataset.r,W=760;
  svg.addEventListener('mousemove',function(e){var r=svg.getBoundingClientRect();var px=(e.clientX-r.left)/r.width*W;var x=x0+(px-L)/(W-L-R)*(x1-x0);if(x<x0||x>x1){tip.hidden=true;cross.setAttribute('visibility','hidden');return;}
    cross.setAttribute('x1',px);cross.setAttribute('x2',px);cross.setAttribute('visibility','visible');
    var parts=['t '+x.toFixed(2)];data.forEach(function(s){var b=-1,bd=Infinity;for(var i=0;i<s.x.length;i++){var d=Math.abs(s.x[i]-x);if(d<bd){bd=d;b=i;}}if(b>=0&&s.y[b]!=null&&bd<2)parts.push(s.n+' '+s.y[b].toFixed(2));});
    tip.textContent=parts.join(' · ');tip.hidden=false;var left=(e.clientX-r.left)+12;tip.style.left=Math.min(left,r.width-tip.offsetWidth-4)+'px';});
  svg.addEventListener('mouseleave',function(){tip.hidden=true;cross.setAttribute('visibility','hidden');});
});
`;

module.exports = { buildReport };
