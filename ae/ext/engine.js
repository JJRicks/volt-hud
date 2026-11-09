// Volt HUD Assemble engine: an invisible CEP page that starts with After Effects. It waits for a job from
// the Mac app (Application Support/Volt HUD/assemble/pending.json), builds the AE project with core/,
// then drives Premiere over BridgeTalk (ae/jsx/assemble-ppro.jsx).
(function () {
  'use strict';
  var fs = require('fs'), os = require('os'), path = require('path');
  var extDir = path.dirname(decodeURIComponent(window.location.pathname));
  var P = require(path.join(extDir, 'core', 'pipeline'));
  var A = require(path.join(extDir, 'core', 'assemble'));
  var HOME = path.join(os.homedir(), 'Library', 'Application Support', 'Volt HUD');
  var QUEUE = path.join(HOME, 'assemble');
  var PENDING = path.join(QUEUE, 'pending.json');
  var LOOK = path.join(HOME, 'panel-look.json');
  var STALE_MS = 15 * 60 * 1000;
  var JSX = ['build-comp.jsx', 'assemble-ae.jsx'].map(function (f) { return path.join(extDir, 'jsx', f); });
  var running = false;

  function delay(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function writeJson(file, obj) {
    var tmp = file + '.tmp';
    P.writePrivate(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  }
  function evalAe(code) {
    return new Promise(function (ok) {
      var guard = JSX.map(function (f) { return '$.evalFile(' + JSON.stringify(f) + ');'; }).join('');
      window.__adobe_cep__.evalScript(guard + code, function (res) {
        var o;
        try { o = JSON.parse(res); } catch (e) { o = { ok: false, error: 'After Effects returned: ' + String(res).slice(0, 200) }; }
        ok(o);
      });
    });
  }
  function savedLook() {
    try { return JSON.parse(fs.readFileSync(LOOK, 'utf8')) || {}; } catch (e) { return {}; }
  }
  // The panel's saved look, with the size and shape picked for this assembly. GPS stays on unless switched off there.
  function styleFor(out, compName) {
    var s = Object.assign({}, savedLook());
    delete s.clockMode;
    var off = s.coordsSwitch === 'off';
    delete s.coordsSwitch;
    s.aspect = out.aspect; s.resolution = out.resolution; s.preset = out.preset; s.compName = compName; s.coords = !off;
    return s;
  }

  async function runJob(job, workDir) {
    var progressFile = path.join(workDir, 'progress.json');
    var report = { started: new Date().toISOString(), folder: job.folder, recordings: [], skipped: [], notes: [] };
    function step(text) { writeJson(progressFile, { done: false, text: text }); }
    function finish(error) {
      if (error) report.error = error;
      report.ok = !error;
      report.text = (error ? 'Stopped: ' + error + '\n' : '') + A.reportText(report);
      report.finished = new Date().toISOString();
      writeJson(path.join(workDir, 'report.json'), report);
      writeJson(progressFile, { done: true, text: report.ok ? 'Done' : 'Stopped' });
    }
    try {
      var out = A.outputFor(job.size, job.shape);
      step('Scanning the folder');
      var plan = await A.planFolder(job.folder, { onStep: step });
      report.skipped = plan.skipped.slice();
      report.notes = plan.problems.slice();
      plan.recordings.forEach(function (r) { report.notes = report.notes.concat(r.notes); });
      if (out.upscaled) report.notes.push('4K 9:16: GoPro Reframe has no 2160x3840 size, so the video is Social 9:16 scaled to 200%.');
      if (!plan.recordings.length) { finish('no recording in this folder has an MP4'); return; }

      var begin = await evalAe('VoltAssembleAE.begin()');
      if (!begin.ok) { finish(begin.error); return; }
      var stem = A.assemblyStem(job.folder);
      var aep = path.join(job.folder, stem + '.aep'), prproj = path.join(job.folder, stem + '.prproj');
      var pproRecs = [], comps = [];
      for (var i = 0; i < plan.recordings.length; i++) {
        var r = plan.recordings[i], entry = { name: r.name };
        report.recordings.push(entry);
        var ppro = { name: r.name, mp4s: r.mp4s, durationS: r.durationS };
        pproRecs.push(ppro);
        if (!r.pair) continue;
        step('Building the HUD for ' + r.name);
        var ride = { videos: r.videos, gopro: r.gopro, volt: r.pair.ride.volt, voltInfo: P.describeVolt(r.pair.ride.volt) };
        var style = styleFor(out, 'HUD ' + r.name);
        var tl = P.makeTimeline(ride, r.pair.sync, { coords: style.coords, style: style });
        var spec = P.buildHudSpec(tl, style);
        var specPath = path.join(workDir, r.name + '.hudspec.json');
        P.writePrivate(specPath, JSON.stringify(spec));
        var built = await evalAe('VoltHUD.build(' + JSON.stringify(specPath) + ')');
        if (!built.ok) { finish('the HUD for ' + r.name + ' did not build: ' + (built.error || 'unknown error')); return; }
        entry.comp = built.comp; entry.ride = path.basename(r.pair.ride.file).replace(/-everything\.json$/i, '');
        entry.confidence = r.pair.confidence; entry.rideStartVideoS = r.pair.rideStartVideoS; entry.overlapS = r.pair.overlapS;
        ppro.comp = built.comp; comps.push(built.comp);
        (built.warnings || []).forEach(function (w) { report.notes.push(r.name + ': ' + w); });
        if (built.exprErrors && built.exprErrors.length) report.notes.push(r.name + ': ' + built.exprErrors.length + ' expression errors in the comp');
        if (built.fontsMissing && built.fontsMissing.length) report.notes.push('Saira HUD font is not installed: install it from the panel.');
      }
      step('Saving the After Effects project');
      var saved = await evalAe('VoltAssembleAE.save(' + JSON.stringify(aep) + ')');
      if (!saved.ok) { finish('the After Effects project did not save: ' + saved.error); return; }
      report.aep = aep;

      step('Waiting for Premiere');
      var ready = false;
      for (var w = 0; w < 80 && !ready; w++) {
        var ping = await evalAe('VoltAssembleAE.pingPremiere()');
        ready = !!ping.ok;
        if (!ready) await delay(3000);
      }
      if (!ready) { finish('Premiere did not answer. Open it and try again.'); return; }

      step('Building the Premiere project');
      var pproJob = { prproj: prproj, aep: aep, sequence: stem, width: out.width, height: out.height, projection: out.projection, motionScale: out.motionScale,
        recordings: pproRecs, comps: comps, reportPath: path.join(workDir, 'ppro-report.json'), probe: job.probe || null };
      var jobPath = path.join(workDir, 'ppro-job.json');
      writeJson(jobPath, pproJob);
      try { fs.unlinkSync(pproJob.reportPath); } catch (e) {}
      var sent = await evalAe('VoltAssembleAE.sendPremiere(' + JSON.stringify(path.join(extDir, 'jsx', 'assemble-ppro.jsx')) + ',' + JSON.stringify(jobPath) + ')');
      if (!sent.ok) { finish('could not reach Premiere: ' + sent.error); return; }
      var t0 = Date.now(), res = null;
      while (Date.now() - t0 < 15 * 60 * 1000) {
        try { res = JSON.parse(fs.readFileSync(pproJob.reportPath, 'utf8')); break; } catch (e) { await delay(2000); }
      }
      if (!res) { finish('Premiere did not finish within 15 minutes.'); return; }
      report.premiere = res;
      if (!res.ok) { finish('Premiere could not finish: ' + res.error); return; }
      report.prproj = prproj;
      if (res.reframeFailures && res.reframeFailures.length) report.notes.push('GoPro Reframe could not be set on: ' + res.reframeFailures.join(', '));
      finish(null);
    } catch (e) {
      finish(String(e && e.message || e));
    }
  }

  function poll() {
    if (running) return;
    var job;
    try { job = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch (e) { return; }
    try { fs.unlinkSync(PENDING); } catch (e) { return; }
    if (!job || !job.folder || !job.workDir || Date.now() - job.createdMs > STALE_MS) return;
    running = true;
    runJob(job, job.workDir).then(function () { running = false; }, function () { running = false; });
  }
  setInterval(poll, 1500);
})();
