// Volt HUD panel (CEP 12, Node 17 via --enable-nodejs --mixed-context). Thin UI over core/pipeline.js:
// pick files -> load + sync -> strip + nudge -> timeline + HUD spec (private files) -> VoltHUD.build() in AE.
(function () {
  'use strict';
  var fs = require('fs'), os = require('os'), path = require('path');
  var extDir = path.dirname(decodeURIComponent(window.location.pathname));
  var P = require(path.join(extDir, 'core', 'pipeline'));
  var ST = require(path.join(extDir, 'core', 'sync', 'strip'));
  var STY = require(path.join(extDir, 'core', 'hud', 'style'));
  var MP4 = require(path.join(extDir, 'core', 'check-mp4'));
  var JSX = path.join(extDir, 'jsx', 'build-comp.jsx');
  var FONT_FILES = ['SairaHUD-Regular.ttf', 'SairaHUD-Medium.ttf', 'SairaHUD-SemiBold.ttf', 'SairaHUD-Bold.ttf'];
  var LABELS = { speed: 'Speed', power: 'Power', battery: 'Battery', vertical: 'Climb', gmeter: 'G-meter', jerk: 'Jerk', clock: 'Clock', stats: 'Trip stats', coords: 'Coordinates', map: 'Route map' };

  var $ = function (id) { return document.getElementById(id); };
  var state = { videos: [], volt: [], mp4: null, ride: null, sync: null, base: null, strip: null, nudgeMs: 0, compId: null, outDir: null };

  // ---------- settings ----------
  var KEY = 'volthud.panel.v1';
  function loadSettings() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(readStyle(true))); } catch (e) {} }

  function readStyle(raw) {
    var widgets = {};
    STY.WIDGETS.forEach(function (k) { var c = $('w_' + k); if (c) widgets[k] = c.checked; });
    var c24 = $('clock24').value;
    var s = {
      aspect: $('aspect').value, resolution: $('resolution').value, preset: $('preset').value, units: $('units').value,
      accent: $('accent').value, plate: +$('plate').value, scale: +$('scale').value, safe: +$('safe').value,
      coords: $('coords').checked, widgets: widgets,
    };
    if (c24 !== 'auto') s.clock24 = c24 === '24';
    if (raw) s.clockMode = c24;
    return s;
  }

  function fillPresets(sel) {
    var a = $('aspect').value, p = $('preset');
    p.innerHTML = '';
    STY.PRESETS[a].forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k.charAt(0).toUpperCase() + k.slice(1); p.appendChild(o); });
    if (sel && STY.PRESETS[a].indexOf(sel) >= 0) p.value = sel;
  }

  function initControls() {
    var s = loadSettings();
    var box = $('widgets');
    STY.WIDGETS.forEach(function (k) {
      var l = document.createElement('label'); l.className = 'check';
      l.innerHTML = '<input type="checkbox" id="w_' + k + '"> ' + LABELS[k];
      box.appendChild(l);
      var on = s.widgets && typeof s.widgets[k] === 'boolean' ? s.widgets[k] : STY.DEFAULT_ON[k];
      if (k === 'coords' || k === 'map') on = s.widgets && s.widgets[k] === true;
      l.firstChild.checked = on;
    });
    ['aspect', 'resolution', 'units', 'accent', 'plate', 'scale', 'safe'].forEach(function (k) { if (s[k] != null) $(k).value = s[k]; });
    if (s.clockMode) $('clock24').value = s.clockMode;
    $('coords').checked = false; // coordinates are opt-in every session
    fillPresets(s.preset);
    syncCoordBoxes();
    showSliders();
    $('aspect').onchange = function () { fillPresets($('preset').value); saveSettings(); };
    $('coords').onchange = syncCoordBoxes;
    document.querySelectorAll('section input, section select').forEach(function (el) {
      if (el.id === 'nudgeMs' || el.id === 'pvStart' || el.id === 'pvDur') return;
      el.addEventListener('change', function () { showSliders(); saveSettings(); });
      el.addEventListener('input', showSliders);
    });
  }
  function syncCoordBoxes() {
    var on = $('coords').checked;
    ['coords', 'map'].forEach(function (k) { var c = $('w_' + k); c.disabled = !on; if (!on) c.checked = false; else if (!c.dataset.touched) c.checked = true; });
  }
  function showSliders() {
    $('plateV').textContent = Math.round($('plate').value * 100) + ' %';
    $('scaleV').textContent = Math.round($('scale').value * 100) + ' %';
    $('safeV').textContent = Math.round($('safe').value * 100) + ' %';
  }

  // ---------- helpers ----------
  function msg(id, text, cls) { var e = $(id); e.textContent = text || ''; e.className = 'msg' + (cls ? ' ' + cls : ''); }
  function pick(multi, dir, title, types) {
    var r = window.cep.fs.showOpenDialogEx(multi, dir, title, state.lastDir || os.homedir(), types || []);
    if (r.err || !r.data || !r.data.length) return [];
    state.lastDir = path.dirname(r.data[0]);
    return r.data;
  }
  function names(list) { return list.map(function (f) { return path.basename(f); }).join(', '); }
  function mmss(s) {
    var neg = s < 0; s = Math.abs(s);
    var m = Math.floor(s / 60), r = s - m * 60;
    return (neg ? '−' : '') + m + ':' + (r < 10 ? '0' : '') + r.toFixed(3);
  }
  function later(fn) { setTimeout(fn, 30); } // let the busy message paint first
  function evalJsx(code, cb) {
    var cs = window.__adobe_cep__;
    var guard = 'if (typeof VoltHUD === "undefined") $.evalFile(' + JSON.stringify(JSX) + ');';
    cs.evalScript(guard + code, function (res) {
      var o;
      try { o = JSON.parse(res); } catch (e) { o = { ok: false, error: 'After Effects returned: ' + String(res).slice(0, 200) }; }
      cb(o);
    });
  }
  function updateButtons() {
    $('load').disabled = !(state.videos.length && state.volt.length);
    $('build').disabled = !state.sync;
    $('preview').disabled = !state.compId;
  }

  // ---------- files ----------
  $('pick360').onclick = function () {
    var f = pick(true, false, 'Choose the GoPro .360 (any chapter)', ['360', 'MP4', 'mp4']);
    if (!f.length) return;
    state.videos = P.expandVideos(f);
    $('f360').textContent = names(state.videos); $('f360').className = 'file';
    $('f360').title = state.videos.join('\n');
    updateButtons();
  };
  function setVolt(list) {
    if (!list.length) return;
    state.volt = list;
    $('fVolt').textContent = names(list); $('fVolt').className = 'file'; $('fVolt').title = list.join('\n');
    updateButtons();
  }
  $('pickVolt').onclick = function () { setVolt(pick(true, false, 'Choose the Volt export (combined JSON, or the CSVs)', ['json', 'csv'])); };
  $('pickVoltDir').onclick = function () { setVolt(pick(false, true, 'Choose the folder with the Volt export')); };
  $('pickMp4').onclick = function () {
    var f = pick(false, false, 'Choose the reframed MP4 (optional)', ['mp4', 'MP4', 'mov']);
    if (!f.length) return;
    state.mp4 = f[0];
    $('fMp4').textContent = path.basename(f[0]); $('fMp4').className = 'file';
    if (state.ride) checkMp4();
  };

  $('load').onclick = function () { doLoad(); };
  function doLoad() {
    msg('loadMsg', 'Reading telemetry…');
    $('load').disabled = true;
    return new Promise(function (res) { later(res); }).then(function () {
      var t0 = Date.now();
      return P.loadRide(state.videos, state.volt).then(function (ride) {
        state.ride = ride;
        state.base = P.rideBase(ride);
        var r = P.runSync(ride, { nudgeMs: 0 });
        state.sync = r.sync; state.strip = r.strip; state.nudgeMs = 0; state.compId = null;
        $('nudgeMs').value = 0;
        var vi = ride.voltInfo;
        msg('loadMsg', 'Loaded in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s · ' + ride.videos.length + ' chapter' + (ride.videos.length > 1 ? 's' : '') + ' · Volt: ' + (vi.kinds.join(', ') || 'nothing found') +
          (vi.missing.length ? ' · missing ' + vi.missing.join(', ') + ': widgets without data show [no data]' : ''), vi.missing.length ? 'warn' : 'ok');
        $('syncSec').className = '';
        state.outDir = path.join(os.homedir(), 'Documents', 'Volt HUD', state.base);
        $('outDir').textContent = 'Files go to ' + state.outDir.replace(os.homedir(), '~');
        $('pvStart').value = Math.max(0, Math.floor(state.sync.rideStartVideoS));
        showSync(); updateButtons();
        if (state.mp4) checkMp4();
        return { ok: true, loadMs: Date.now() - t0, sync: { rideStartVideoS: state.sync.rideStartVideoS, confidence: state.sync.confidence, decidedBy: state.sync.decidedBy } };
      }).catch(function (e) {
        msg('loadMsg', 'Could not load: ' + (e && e.message || e), 'bad');
        updateButtons();
        return { ok: false, error: String(e && e.message || e) };
      });
    });
  }

  function checkMp4() {
    msg('mp4Msg', 'Checking the MP4 against the .360…');
    later(function () {
      try {
        var info = MP4.probeFile(state.mp4);
        var dv = info.durationS - state.ride.gopro.durationS;
        var text = 'MP4 ' + info.durationS.toFixed(2) + ' s vs .360 ' + state.ride.gopro.durationS.toFixed(2) + ' s';
        var cls = Math.abs(dv) < 0.2 ? 'ok' : 'warn';
        try {
          process.env.PATH = (process.env.PATH || '/usr/bin:/bin') + ':/opt/homebrew/bin:/usr/local/bin';
          var r = MP4.checkMp4(state.ride.videos[0], state.mp4, { windowS: 8 });
          if (r.start) {
            var ms = r.start.lagS * 1000, fr = r.start.lagS / r.frameS;
            text += ' · audio at the start: ' + (ms >= 0 ? '+' : '') + ms.toFixed(1) + ' ms (' + fr.toFixed(2) + ' frames)';
            if (Math.abs(fr) >= 0.5) { cls = 'bad'; text += ' — the MP4 does not start at the .360’s first frame; trim or shift it in AE.'; }
            else text += ' — starts together.';
          }
        } catch (e) { text += ' · audio check skipped (needs ffmpeg).'; }
        msg('mp4Msg', text, cls);
      } catch (e) { msg('mp4Msg', 'Could not read the MP4: ' + e.message, 'bad'); }
    });
  }

  // ---------- sync strip ----------
  function frameMs() { return 1000 / (state.strip && state.strip.fps || 29.97); }
  function setNudge(ms) {
    ms = Math.round(ms * 10) / 10;
    state.nudgeMs = ms;
    state.sync = P.applyNudge(state.sync, ms);
    state.compId = null;
    $('nudgeMs').value = ms;
    showSync(); updateButtons();
  }
  document.querySelectorAll('.nudge button').forEach(function (b) {
    b.onclick = function () {
      var n = b.dataset.n, v = parseFloat(n), unit = n.slice(-1);
      setNudge(state.nudgeMs + (unit === 's' ? v * 1000 : v * frameMs()));
    };
  });
  $('nudgeMs').onchange = function () { var v = parseFloat($('nudgeMs').value); setNudge(Number.isFinite(v) ? v : 0); };
  $('nudgeReset').onclick = function () { setNudge(0); };

  function showSync() {
    var s = state.sync;
    var conf = s.confidence || 'none';
    $('syncSummary').innerHTML = 'Ride starts at <b>' + mmss(s.rideStartVideoS) + '</b> in the video · confidence <b class="conf-' + conf + '">' + conf + '</b> (' + (s.decidedBy || s.method) + ')' +
      (state.nudgeMs ? ' · nudged ' + (state.nudgeMs > 0 ? '+' : '') + state.nudgeMs + ' ms' : '');
    $('nudgeFr').textContent = '= ' + (state.nudgeMs / frameMs()).toFixed(2) + ' frames';
    var d = (state.nudgeMs - state.strip.nudgeMs) / 1000;
    var r = ST.stripMatch(state.strip, d);
    $('match').textContent = r == null ? '' : 'match ' + r.toFixed(2);
    $('lgVolt').textContent = state.strip.speed ? state.strip.speed.voltLabel : 'Volt';
    var gp = !!(state.strip.speed && state.strip.speed.gopro);
    $('lgGopro').style.display = $('lgGoproSw').style.display = gp ? '' : 'none';
    drawSpeed(d); drawImu(d);
  }

  function canvas(id) {
    var c = $(id), dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight || +c.getAttribute('height');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function line(g, t, v, sx, sy, colour, width) {
    g.strokeStyle = colour; g.lineWidth = width || 1.25; g.beginPath();
    var pen = false;
    for (var i = 0; i < t.length; i++) {
      if (v[i] === null || v[i] === undefined || !isFinite(v[i])) { pen = false; continue; }
      var x = sx(t[i]), y = sy(v[i]);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
  }
  function shifted(t, d) { return t.map(function (x) { return x + d; }); }
  function drawSpeed(d) {
    var C = canvas('cvSpeed'), g = C.g, sp = state.strip.speed, T = state.strip.durationS;
    if (!sp) { g.fillStyle = css('--muted'); g.fillText('No speed from the Volt export', 8, 16); return; }
    var max = 10;
    [sp.volt, sp.gopro].forEach(function (s) { if (s) s.v.forEach(function (x) { if (x > max) max = x; }); });
    var sx = function (t) { return (t / T) * C.w; }, sy = function (v) { return C.h - 4 - (v / max) * (C.h - 10); };
    g.fillStyle = 'rgba(255,255,255,0.06)';
    var r0 = sx(state.sync.rideStartVideoS); g.fillRect(r0, 0, 1, C.h);
    if (sp.gopro) line(g, sp.gopro.t, sp.gopro.v, sx, sy, css('--gopro'), 1);
    line(g, shifted(sp.volt.t, d), sp.volt.v, sx, sy, css('--accent'), 1.25);
    var im = state.strip.imu;
    if (im) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.strokeRect(sx(im.t0), 1, Math.max(2, sx(im.t1) - sx(im.t0)), C.h - 2); }
    g.fillStyle = css('--muted'); g.font = '10px -apple-system, sans-serif';
    g.fillText(Math.round(max) + ' km/h', 4, 11); g.fillText(mmss(T).replace(/\.\d+$/, ''), C.w - 34, C.h - 4);
  }
  function drawImu(d) {
    var C = canvas('cvImu'), g = C.g, im = state.strip.imu;
    if (!im) { g.fillStyle = css('--muted'); g.font = '10px -apple-system, sans-serif'; g.fillText('No phone motion data: speed decides the sync', 8, 16); return; }
    var lo = Infinity, hi = -Infinity;
    [im.a, im.b].forEach(function (a) { a.forEach(function (x) { if (x !== null) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }); });
    hi = Math.min(hi, 6); lo = Math.max(lo, -2);
    var sx = function (t) { return ((t - im.t0) / (im.t1 - im.t0)) * C.w; };
    var sy = function (v) { return C.h - 3 - ((Math.min(hi, v) - lo) / (hi - lo || 1)) * (C.h - 6); };
    line(g, im.t, im.a, sx, sy, css('--gopro'), 1);
    line(g, shifted(im.t, d), im.b, sx, sy, css('--accent'), 1.25);
    g.fillStyle = css('--muted'); g.font = '10px -apple-system, sans-serif';
    g.fillText(mmss(im.t0).replace(/\.\d+$/, '') + '–' + mmss(im.t1).replace(/\.\d+$/, ''), 4, 11);
  }
  window.addEventListener('resize', function () { if (state.strip) showSync(); });

  // ---------- build ----------
  $('build').onclick = function () { doBuild(); };
  function doBuild() { return new Promise(function (done) {
    msg('buildMsg', 'Writing the timeline…');
    $('build').disabled = true;
    later(function () {
      var style, specPath;
      try {
        style = readStyle(false);
        var tl = P.makeTimeline(state.ride, state.sync, { coords: style.coords, style: style });
        var spec = P.buildHudSpec(tl, style);
        var tag = spec.style.preset + '-' + spec.style.aspect.replace(':', 'x') + (spec.style.comp[0] > 2000 ? '-4k' : '');
        P.writePrivate(path.join(state.outDir, state.base + '.volthud.json'), JSON.stringify(tl));
        specPath = path.join(state.outDir, state.base + '-' + tag + '.hudspec.json');
        P.writePrivate(specPath, JSON.stringify(spec));
      } catch (e) { msg('buildMsg', 'Could not make the HUD data: ' + e.message, 'bad'); updateButtons(); done({ ok: false, error: e.message }); return; }
      msg('buildMsg', 'Building in After Effects…');
      evalJsx('VoltHUD.build(' + JSON.stringify(specPath) + ')', function (r) {
        updateButtons();
        if (!r.ok) { msg('buildMsg', 'Build failed: ' + (r.error || 'unknown error'), 'bad'); done(r); return; }
        state.compId = r.compId; updateButtons();
        var bits = ['Built “' + r.comp + '” · ' + r.width + '×' + r.height + ' · ' + mmss(r.durationS).replace(/\.\d+$/, '') + ' · ' + (r.buildMs / 1000).toFixed(1) + ' s'];
        var cls = 'ok';
        if (!r.durationOk) { bits.push('length differs from the video'); cls = 'warn'; }
        if (r.fontsMissing && r.fontsMissing.length) { bits.push('font missing: install Saira HUD below, then restart AE'); cls = 'warn'; }
        if (r.exprErrors && r.exprErrors.length) { bits.push(r.exprErrors.length + ' expression errors'); cls = 'bad'; }
        if (r.warnings && r.warnings.length) bits.push(r.warnings.join('; '));
        msg('buildMsg', bits.join(' · '), cls);
        fontStatus(r.fontsMissing);
        r.specPath = specPath; done(r);
      });
    });
  }); }

  $('preview').onclick = function () { doPreview(); };
  function doPreview() { return new Promise(function (done) {
    var st = Math.max(0, +$('pvStart').value || 0), du = Math.min(30, Math.max(1, +$('pvDur').value || 10));
    var out = path.join(state.outDir, state.base + '-preview-' + Math.round(st) + 's.mov');
    fs.mkdirSync(state.outDir, { recursive: true, mode: 0o700 });
    evalJsx('VoltHUD.addPreview(' + state.compId + ',' + st + ',' + du + ',' + JSON.stringify(out) + ')', function (r) {
      if (!r.ok) { msg('pvMsg', 'Could not add: ' + r.error, 'bad'); done(r); return; }
      msg('pvMsg', 'Queued ' + r.durationS.toFixed(1) + ' s from ' + mmss(r.startS).replace(/\.\d+$/, '') + (r.format ? ' · ' + r.format + ', ' + r.channels : '') + ' → ' + path.basename(r.file), 'ok');
      done(r);
    });
  }); }

  // ---------- font ----------
  function fontDirs() { return [path.join(os.homedir(), 'Library', 'Fonts'), '/Library/Fonts']; }
  function fontsOnDisk() { return FONT_FILES.every(function (f) { return fontDirs().some(function (d) { return fs.existsSync(path.join(d, f)); }); }); }
  function fontStatus(missingInAe) {
    var disk = fontsOnDisk();
    if (missingInAe && missingInAe.length) msg('fontMsg', disk ? 'Installed, but After Effects has not loaded it yet: restart After Effects.' : 'Saira HUD is not installed.', 'warn');
    else msg('fontMsg', disk ? 'Saira HUD is installed.' : 'Saira HUD is not installed.', disk ? 'ok' : 'warn');
    $('fontInstall').style.display = disk ? 'none' : '';
  }
  $('fontInstall').onclick = function () {
    try {
      var dst = fontDirs()[0];
      fs.mkdirSync(dst, { recursive: true });
      FONT_FILES.forEach(function (f) { fs.copyFileSync(path.join(extDir, 'fonts', f), path.join(dst, f)); });
      msg('fontMsg', 'Installed in ~/Library/Fonts. Restart After Effects to use it.', 'ok');
      $('fontInstall').style.display = 'none';
    } catch (e) { msg('fontMsg', 'Could not install: ' + e.message, 'bad'); }
  };

  // ---------- automation (tests) ----------
  // ExtendScript can drive the panel the way a user would: dispatch a CSXSEvent of type
  // com.jjricks.volthud.run with JSON {videos, volt, mp4?, nudgeMs?, style?, outDir, preview?: {startS, durS}}.
  // The panel loads, syncs, builds and writes a JSON report to <outDir>/panel-run.json (600).
  function automate(ev) {
    var job, rep = { started: new Date().toISOString() };
    try { job = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
    if (!job || !job.outDir || !job.videos || !job.volt) return;
    function finish() { rep.ui = { load: $('loadMsg').textContent, sync: $('syncSummary').textContent, match: $('match').textContent, mp4: $('mp4Msg').textContent, build: $('buildMsg').textContent, preview: $('pvMsg').textContent, font: $('fontMsg').textContent, nudgeFrames: $('nudgeFr').textContent };
      try { P.writePrivate(path.join(job.outDir, 'panel-run.json'), JSON.stringify(rep, null, 1)); } catch (e) {} }
    state.videos = P.expandVideos(job.videos); state.volt = job.volt; state.mp4 = job.mp4 || null;
    if (job.style) applyStyle(job.style);
    doLoad().then(function (r) {
      rep.load = r;
      if (!r.ok) throw new Error(r.error);
      state.outDir = job.outDir;
      $('outDir').textContent = 'Files go to ' + state.outDir;
      if (job.nudgeMs) setNudge(job.nudgeMs);
      return doBuild();
    }).then(function (r) {
      rep.build = r;
      if (!r.ok || !job.preview) return null;
      $('pvStart').value = job.preview.startS; $('pvDur').value = job.preview.durS;
      return doPreview();
    }).then(function (r) { rep.preview = r; finish(); }, function (e) { rep.error = String(e && e.message || e); finish(); });
  }
  function applyStyle(s) {
    ['aspect', 'resolution', 'units', 'accent', 'plate', 'scale', 'safe'].forEach(function (k) { if (s[k] != null) $(k).value = s[k]; });
    fillPresets(s.preset);
    if (s.coords != null) { $('coords').checked = !!s.coords; syncCoordBoxes(); }
    showSliders();
  }
  try { window.__adobe_cep__.addEventListener('com.jjricks.volthud.run', automate); } catch (e) {}

  // ---------- start ----------
  try { $('ver').textContent = JSON.parse(fs.readFileSync(path.join(extDir, 'version.json'), 'utf8')).version; } catch (e) {}
  initControls();
  document.querySelectorAll('.checks input').forEach(function (c) { c.addEventListener('change', function () { c.dataset.touched = '1'; }); });
  fontStatus(null);
  updateButtons();
})();
