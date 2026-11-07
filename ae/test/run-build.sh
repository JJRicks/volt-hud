#!/bin/sh
# run-build.sh <spec.json> <out.aep> [t1 t2 ...] : in the running AE 2026, make a NEW project, build the
# HUD comp from the spec with ae/jsx/build-comp.jsx, add one TIFF+alpha render-queue item per time (seconds),
# save <out.aep>, and print the builder's JSON result. Never touches a saved project outside test/out dirs.
set -e
here="$(cd "$(dirname "$0")" && pwd)"; jsx="$(cd "$here/../jsx" && pwd)/build-comp.jsx"
abs() { case "$1" in /*) echo "$1";; *) echo "$(pwd)/$1";; esac; }
spec="$(abs "$1")"; out="$(abs "$2")"; shift 2
times="$*"; base="${out%.aep}"; res="$base-result.aepx"; wrap="$base-run.jsx"
cat > "$wrap" <<J
(function () {
  var R = {}; var T = [$(echo $times | sed 's/ /,/g')];
  try {
    \$.evalFile("$jsx");
    app.beginSuppressDialogs();
    if (app.project && app.project.file !== null && !/\/(volt-hud\/ae|hud-samples\/out)\//.test(app.project.file.fsName)) throw new Error('a saved project is open; refusing to touch it');
    if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    app.newProject();
    var t0 = new Date().getTime();
    R.build = eval('(' + VoltHUD.build("$spec") + ')');
    R.wallBuildMs = new Date().getTime() - t0;
    var comp = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).id === R.build.compId) comp = app.project.item(i);
    if (comp) for (var k = 0; k < T.length; k++) {
      var it = app.project.renderQueue.items.add(comp); var fd = comp.frameDuration;
      it.timeSpanStart = Math.round(T[k] / fd) * fd; it.timeSpanDuration = fd;
      it.outputModule(1).applyTemplate('TIFF Sequence with Alpha');
      it.outputModule(1).file = new File("$base-f" + k + "-[#####].tif");
    }
    var ts = new Date().getTime(); app.project.save(new File("$out")); R.saveMs = new Date().getTime() - ts;
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  } catch (e) { R.error = String(e) + ' line ' + e.line; }
  try { if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); var rf = app.project.items.addFolder('VH_RESULT'); rf.comment = VoltHUD.ser(R);
    app.project.save(new File("$res")); app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e2) {}
  app.endSuppressDialogs(false);
})();
J
"$here/run-jsx.sh" "$wrap" "$res" 3000
