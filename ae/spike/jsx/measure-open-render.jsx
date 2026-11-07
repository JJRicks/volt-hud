// M0: cold-open timing + in-GUI render-queue render of the mid frame, for each spike project.
// Global VH_PROJECTS (array of .aep paths, ours only), VH_RESULT (aepx path for the result).
(function () {
  function now() { return new Date().getTime(); }
  function ser(o) {
    if (o === null || o === undefined) return 'null';
    if (typeof o === 'number') return isFinite(o) ? String(o) : 'null';
    if (typeof o === 'boolean') return String(o);
    if (typeof o === 'string') return '"' + o.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    if (o instanceof Array) { var a = []; for (var i = 0; i < o.length; i++) a.push(ser(o[i])); return '[' + a.join(',') + ']'; }
    var p = []; for (var k in o) if (o.hasOwnProperty(k)) p.push(ser(k) + ':' + ser(o[k])); return '{' + p.join(',') + '}';
  }
  var R = { mode: 'open-render', runs: [] };
  app.beginSuppressDialogs();
  try {
    if (app.project && app.project.file !== null) { R.error = 'foreign project open'; }
    else {
      if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      for (var i = 0; i < VH_PROJECTS.length; i++) {
        var run = { project: VH_PROJECTS[i] };
        var t = now(); app.open(new File(VH_PROJECTS[i])); run.openMs = now() - t;
        var rq = app.project.renderQueue;
        for (var j = 1; j <= rq.numItems; j++) rq.item(j).render = (j === 2); // mid frame only
        t = now(); rq.render(); run.guiRenderMidFrameMs = now() - t;
        run.status = String(rq.item(2).status);
        // 150-frame (5 s) span at the middle, ProRes 4444 + alpha, rendered in the GUI render queue
        for (j = 1; j <= rq.numItems; j++) try { rq.item(j).render = false; } catch (e6) {} // DONE items throw
        var comp = rq.item(1).comp, fd = comp.frameDuration;
        var sp = rq.items.add(comp);
        sp.timeSpanStart = Math.round(1780 / fd) * fd; sp.timeSpanDuration = 150 * fd;
        sp.outputModule(1).applyTemplate('High Quality with Alpha');
        sp.outputModule(1).file = new File(VH_PROJECTS[i].replace(/\.aep$/, '') + '-gui-span150.mov');
        t = now(); rq.render(); run.guiRender150FramesMs = now() - t;
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        R.runs.push(run);
      }
    }
  } catch (e) { R.error = String(e) + ' line ' + e.line; }
  try {
    if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    app.newProject(); var f = app.project.items.addFolder('VH_RESULT'); f.comment = ser(R);
    app.project.save(new File(VH_RESULT)); app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  } catch (e2) {}
  app.endSuppressDialogs(false);
})();
