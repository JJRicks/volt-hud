// Assemble project, Premiere side (ExtendScript, ES3). Sent by BridgeTalk from After Effects; reads a job
// file and writes a JSON report. Run from a fresh Premiere with no project open.
var VoltAssemblePPro = (function () {
  function ser(o) {
    if (o === null || o === undefined) return 'null';
    if (typeof o === 'number') return isFinite(o) ? String(o) : 'null';
    if (typeof o === 'boolean') return String(o);
    if (typeof o === 'string') return '"' + o.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
    var i, a = [];
    if (o instanceof Array) { for (i = 0; i < o.length; i++) a.push(ser(o[i])); return '[' + a.join(',') + ']'; }
    for (var k in o) if (o.hasOwnProperty(k)) a.push(ser(k) + ':' + ser(o[k]));
    return '{' + a.join(',') + '}';
  }
  function readJob(p) {
    var f = new File(p); f.encoding = 'UTF-8'; f.open('r'); var t = f.read(); f.close();
    return eval('(' + t + ')'); // our own file, written by the engine
  }
  function writeReport(p, r) {
    var f = new File(p); f.encoding = 'UTF-8'; f.open('w'); f.write(ser(r)); f.close();
  }
  function findItem(pred) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) if (pred(root.children[i])) return root.children[i];
    return null;
  }
  function baseName(p) { return String(p).replace(/^.*\//, ''); }
  function findComponent(clip, re) {
    for (var i = 0; i < clip.components.numItems; i++) { var c = clip.components[i]; if (re.test(c.displayName + '|' + c.matchName)) return c; }
    return null;
  }
  function findProp(comp, name) {
    if (!comp) return null;
    for (var i = 0; i < comp.properties.numItems; i++) { var p = comp.properties[i]; if (p.displayName === name) return p; }
    return null;
  }

  function run(jobPath) {
    var R = { ok: false, steps: [] };
    var job;
    function note(n, d) { R.steps.push(n + ': ' + d); }
    try {
      job = readJob(jobPath);
      if (!app.newProject(job.prproj)) throw new Error('app.newProject failed');
      var paths = [], i, j;
      for (i = 0; i < job.recordings.length; i++) for (j = 0; j < job.recordings[i].mp4s.length; j++) paths.push(job.recordings[i].mp4s[j]);
      if (!app.project.importFiles(paths, true, app.project.getInsertionBin(), false)) throw new Error('could not import the MP4s');
      var clips = [];
      for (i = 0; i < paths.length; i++) {
        var name = baseName(paths[i]);
        var item = findItem(function (c) { return c.name === name; });
        if (!item) throw new Error('imported MP4 not found: ' + name);
        clips.push(item);
      }
      var seq = app.project.createNewSequenceFromClips(job.sequence, clips, app.project.rootItem);
      if (!seq) throw new Error('could not make the sequence');
      var st = seq.getSettings();
      st.videoFrameWidth = job.width; st.videoFrameHeight = job.height;
      seq.setSettings(st);
      var got = seq.getSettings();
      R.sequence = { name: seq.name, width: got.videoFrameWidth, height: got.videoFrameHeight, frameSeconds: got.videoFrameRate.seconds };
      app.project.openSequence(seq.sequenceID);

      // V1: Reframe on each clip.
      var v1 = seq.videoTracks[0];
      R.v1 = [];
      for (i = 0; i < v1.clips.numItems; i++) R.v1.push({ name: v1.clips[i].name, startS: v1.clips[i].start.seconds, endS: v1.clips[i].end.seconds });
      if (R.v1.length !== paths.length) throw new Error('expected ' + paths.length + ' clips on V1, found ' + R.v1.length);
      R.reframeFailures = [];
      R.reframe = [];
      if (!app.enableQE()) throw new Error('could not enable the QE DOM');
      var fx = qe.project.getVideoEffectByName('GoPro Reframe');
      if (!fx) throw new Error('GoPro Reframe not found in Premiere');
      var qt = qe.project.getActiveSequence().getVideoTrackAt(0);
      var idx = 0;
      for (i = 0; i < qt.numItems; i++) {
        var qi = qt.getItemAt(i);
        if (qi.type !== 'Clip') continue;
        qi.addVideoEffect(fx);
        idx++;
      }
      for (i = 0; i < v1.clips.numItems; i++) {
        var clip = v1.clips[i];
        var rf = findComponent(clip, /GoPro Reframe/);
        var pr = findProp(rf, 'Projection');
        var entry = { clip: clip.name, projection: null };
        try {
          if (!pr) throw new Error('no Projection control');
          pr.setValue(job.projection, true);
          entry.projection = pr.getValue();
          if (Number(entry.projection) !== job.projection) throw new Error('read back ' + entry.projection);
          var view = job.reframeView || {};
          for (var vn in view) {
            var vp = findProp(rf, vn);
            if (!vp) throw new Error('no ' + vn + ' control');
            vp.setValue(view[vn], true);
            entry[vn] = vp.getValue();
            if (Math.abs(Number(entry[vn]) - view[vn]) > 0.01) throw new Error(vn + ' read back ' + entry[vn]);
          }
        } catch (e1) { R.reframeFailures.push(clip.name); entry.error = String(e1); }
        if (job.motionScale) {
          var sc = findProp(findComponent(clip, /Motion/), 'Scale');
          if (sc) { sc.setValue(job.motionScale, true); entry.scale = sc.getValue(); }
        }
        R.reframe.push(entry);
      }

      // V2: one comp per paired recording, from Dynamic Link, at the recording's first frame.
      R.v2 = [];
      if (job.comps.length) {
        if (!app.project.importAEComps(job.aep, job.comps, app.project.rootItem)) throw new Error('importAEComps failed');
        var v2 = seq.videoTracks[1], offset = 0;
        for (i = 0; i < job.recordings.length; i++) {
          var rec = job.recordings[i];
          if (rec.comp) {
            var t0 = new Date().getTime(), compItem = null;
            while (!compItem && new Date().getTime() - t0 < 60000) {
              compItem = findItem(function (c) { return c.name === rec.comp || c.name.indexOf(rec.comp + '/') === 0; });
              if (!compItem) $.sleep(500);
            }
            if (!compItem) throw new Error('comp not imported: ' + rec.comp);
            v2.overwriteClip(compItem, R.v1[offset].startS);
          }
          offset += rec.mp4s.length;
        }
        for (i = 0; i < v2.clips.numItems; i++) R.v2.push({ name: v2.clips[i].name, startS: v2.clips[i].start.seconds, endS: v2.clips[i].end.seconds });
        if (R.v2.length !== job.comps.length) throw new Error('expected ' + job.comps.length + ' comps on V2, found ' + R.v2.length);
      }
      if (!app.project.save()) note('save', 'returned false');
      if (job.probe && job.probe.frames) {
        // Test probe only: PNG frames of the sequence.
        var qs = qe.project.getActiveSequence();
        for (i = 0; i < job.probe.frames.length; i++) {
          var fr = job.probe.frames[i];
          try { qs.exportFramePNG(fr.tc, fr.path); note('probe ' + fr.tc, 'sent'); } catch (e2) { note('probe ' + fr.tc, String(e2)); }
        }
      }
      R.ok = true;
    } catch (e) {
      R.error = String(e) + (e.line ? ' (line ' + e.line + ')' : '');
    }
    if (job) writeReport(job.reportPath, R);
    return R.ok;
  }
  return { run: run };
})();
