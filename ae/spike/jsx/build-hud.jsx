// M0 spike builder. Globals set by a run-*.jsx wrapper:
//   VH_MODE = "baked" | "sourceData", VH_DATA = timeline JSON path, VH_OUT = .aep path to create.
// Creates a NEW project (never touches an existing saved one), builds the HUD comp, saves it,
// reopens it (timed), probes expression values, closes it. Returns a JSON string of measurements.
(function () {
  function now() { return new Date().getTime(); }
  function ser(o) { // tiny JSON serializer (ExtendScript has no JSON)
    if (o === null || o === undefined) return 'null';
    if (typeof o === 'number') return isFinite(o) ? String(o) : 'null';
    if (typeof o === 'boolean') return String(o);
    if (typeof o === 'string') return '"' + o.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    if (o instanceof Array) { var a = []; for (var i = 0; i < o.length; i++) a.push(ser(o[i])); return '[' + a.join(',') + ']'; }
    var p = []; for (var k in o) if (o.hasOwnProperty(k)) p.push(ser(k) + ':' + ser(o[k])); return '{' + p.join(',') + '}';
  }
  var R = { mode: VH_MODE, data: VH_DATA, out: VH_OUT, ae: app.version };
  try {
    if (app.project && app.project.file !== null && app.project.file.fsName.indexOf('/volt-hud/ae/spike/out/') < 0) { R.error = 'a saved project is open; refusing to touch it'; return ser(R); }
    var t0 = now();
    app.beginSuppressDialogs();
    var f = new File(VH_DATA); f.encoding = 'UTF-8'; f.open('r'); var txt = f.read(); f.close();
    var D = eval('(' + txt + ')'); txt = null;
    R.readParseMs = now() - t0;
    if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); // untitled scratch project only
    app.newProject();
    var tb = now();
    var dur = D.durationS, rate = D.rateHz, n = D.n;
    var comp = app.project.items.addComp('VOLT HUD', 1920, 1080, 1.0, dur, 29.97);
    var names = []; for (var k in D.channels) if (D.channels.hasOwnProperty(k)) names.push(k);
    R.channels = names.length; R.samples = n; R.durationS = dur;

    var GET = {}; // channel -> expression snippet defining v and ok
    if (VH_MODE === 'baked') {
      var dl = comp.layers.addNull(dur); dl.name = 'VOLT DATA'; dl.enabled = false;
      var parade = dl.property('ADBE Effect Parade');
      var keys = 0, times = new Array(n);
      for (var i = 0; i < n; i++) times[i] = i / rate;
      for (var c = 0; c < names.length; c++) {
        var arr = D.channels[names[c]], vals = new Array(n), last = 0, hasNull = false, first = null;
        for (i = 0; i < n; i++) if (arr[i] !== null) { first = arr[i]; break; }
        last = first === null ? 0 : first;
        for (i = 0; i < n; i++) { if (arr[i] === null) { hasNull = true; vals[i] = last; } else { vals[i] = arr[i]; last = arr[i]; } }
        var fx = parade.addProperty('ADBE Slider Control'); fx.name = names[c];
        fx.property(1).setValuesAtTimes(times, vals); keys += n;
        var okExpr = 'true';
        if (hasNull) { // validity slider: keys only at transitions, HOLD
          var ot = [], ov = [], prev = -1;
          for (i = 0; i < n; i++) { var s = arr[i] === null ? 0 : 1; if (s !== prev) { ot.push(i / rate); ov.push(s); prev = s; } }
          var ofx = parade.addProperty('ADBE Slider Control'); ofx.name = names[c] + '_ok';
          var op = ofx.property(1); op.setValuesAtTimes(ot, ov); keys += ot.length;
          for (var q = 1; q <= op.numKeys; q++) op.setInterpolationTypeAtKey(q, KeyframeInterpolationType.HOLD);
          okExpr = 'thisComp.layer("VOLT DATA").effect("' + names[c] + '_ok")(1) > 0.5';
        }
        GET[names[c]] = 'var v = thisComp.layer("VOLT DATA").effect("' + names[c] + '")(1); var ok = ' + okExpr + ';';
      }
      R.keyframes = keys;
    } else {
      var io = new ImportOptions(new File(VH_DATA));
      var item = app.project.importFile(io);
      R.footageName = item.name;
      for (var c2 = 0; c2 < names.length; c2++) {
        GET[names[c2]] = 'var d = footage("' + item.name + '").sourceData; var c = d.channels.' + names[c2] + ';' +
          ' var x = time * d.rateHz, i = Math.floor(x); if (i > c.length - 1) i = c.length - 1; if (i < 0) i = 0;' +
          ' var a = c[i], b = (i + 1 < c.length) ? c[i + 1] : a; var ok = a !== null;' +
          ' var v = ok ? (b === null ? a : a + (b - a) * (x - i)) : 0;';
      }
    }
    var GREY = '[0.45,0.45,0.45,1]', WHITE = '[1,1,1,1]', RED = '[0.89,0.17,0.18,1]', GREEN = '[0.2,0.82,0.42,1]';

    function shapeLayer(name, pos) { var l = comp.layers.addShape(); l.name = name; l.property('ADBE Transform Group').property('ADBE Position').setValue(pos); return l; }
    // adds a group with [path, (trim), fill|stroke]; returns group contents (re-fetched to avoid invalid refs)
    function addGroup(layer, gname, pathType, size, paint, color, width, withTrim) {
      var root = layer.property('ADBE Root Vectors Group');
      var g = root.addProperty('ADBE Vector Group'); g.name = gname;
      var gc = g.property('ADBE Vectors Group');
      gc.addProperty(pathType === 'ellipse' ? 'ADBE Vector Shape - Ellipse' : 'ADBE Vector Shape - Rect');
      if (withTrim) gc.addProperty('ADBE Vector Filter - Trim');
      gc.addProperty(paint === 'stroke' ? 'ADBE Vector Graphic - Stroke' : 'ADBE Vector Graphic - Fill');
      gc = layer.property('ADBE Root Vectors Group').property(gname).property('ADBE Vectors Group');
      var path = gc.property(1);
      path.property(pathType === 'ellipse' ? 'ADBE Vector Ellipse Size' : 'ADBE Vector Rect Size').setValue(size);
      var pnt = gc.property(withTrim ? 3 : 2);
      pnt.property(paint === 'stroke' ? 'ADBE Vector Stroke Color' : 'ADBE Vector Fill Color').setValue(color);
      if (paint === 'stroke') pnt.property('ADBE Vector Stroke Width').setValue(width);
      return gc;
    }
    function textLayer(name, str, size, pos, just) {
      var l = comp.layers.addText(str); l.name = name;
      var sp = l.property('ADBE Text Properties').property('ADBE Text Document');
      var td = sp.value; td.fontSize = size; td.applyFill = true; td.fillColor = [1, 1, 1]; td.applyStroke = false;
      td.justification = just || ParagraphJustification.LEFT_JUSTIFY; sp.setValue(td);
      l.property('ADBE Transform Group').property('ADBE Position').setValue(pos);
      return l;
    }
    function fillFx(layer, colorExpr) { // Fill effect so text can go grey for [no data]
      var fx = layer.property('ADBE Effect Parade').addProperty('ADBE Fill');
      layer.property('ADBE Effect Parade').property(1).property('ADBE Fill-0002').expression = colorExpr;
    }
    var nExpr = 0;
    function ex(prop, code) { prop.expression = code; nExpr++; }

    // 1. speed arc + number
    var arc = shapeLayer('Speed Arc', [260, 820]);
    // first group in the contents list draws on top, so 'value' is added before 'track'
    addGroup(arc, 'value', 'ellipse', [280, 280], 'stroke', [0.89, 0.17, 0.18], 16, true);
    addGroup(arc, 'track', 'ellipse', [280, 280], 'stroke', [0.25, 0.25, 0.25], 16, true);
    var track = arc.property('ADBE Root Vectors Group').property('track').property('ADBE Vectors Group');
    track.property(2).property('ADBE Vector Trim End').setValue(75); track.property(2).property('ADBE Vector Trim Offset').setValue(-135);
    var val = arc.property('ADBE Root Vectors Group').property('value').property('ADBE Vectors Group');
    val.property(2).property('ADBE Vector Trim Offset').setValue(-135);
    ex(val.property(2).property('ADBE Vector Trim End'), GET.speedKmh + ' ok ? clamp(v / 60, 0, 1) * 75 : 0;');
    ex(val.property(3).property('ADBE Vector Stroke Color'), GET.speedKmh + ' ok ? ' + RED + ' : ' + GREY + ';');
    var spd = textLayer('Speed', '0', 110, [260, 850], ParagraphJustification.CENTER_JUSTIFY);
    ex(spd.property('ADBE Text Properties').property('ADBE Text Document'), GET.speedKmh + ' ok ? String(Math.round(v)) : "[no data]";');
    fillFx(spd, GET.speedKmh + ' ok ? ' + WHITE + ' : ' + GREY + ';'); nExpr++;
    textLayer('Speed Unit', 'km/h', 32, [260, 900], ParagraphJustification.CENTER_JUSTIFY);

    // 2. power bar (regen green, drive red)
    var pw = shapeLayer('Power Bar', [470, 980]);
    addGroup(pw, 'value', 'rect', [0, 22], 'fill', [0.89, 0.17, 0.18]);
    addGroup(pw, 'track', 'rect', [500, 22], 'fill', [0.2, 0.2, 0.2]);
    pw.property('ADBE Root Vectors Group').property('track').property('ADBE Vectors Group').property(1).property('ADBE Vector Rect Position').setValue([250, 0]);
    var pval = pw.property('ADBE Root Vectors Group').property('value').property('ADBE Vectors Group');
    ex(pval.property(1).property('ADBE Vector Rect Size'), GET.powerW + ' var w = ok ? clamp(Math.abs(v) / 2000, 0, 1) * 500 : 500; [w, 22];');
    ex(pval.property(1).property('ADBE Vector Rect Position'), GET.powerW + ' var w = ok ? clamp(Math.abs(v) / 2000, 0, 1) * 500 : 500; [w / 2, 0];');
    ex(pval.property(2).property('ADBE Vector Fill Color'), GET.powerW + ' !ok ? ' + GREY + ' : (v < 0 ? ' + GREEN + ' : ' + RED + ');');
    var ptxt = textLayer('Power', '0 W', 36, [470, 950]);
    ex(ptxt.property('ADBE Text Properties').property('ADBE Text Document'), GET.powerW + ' ok ? (v < 0 ? "REGEN " : "") + Math.round(Math.abs(v)) + " W" : "[no data]";');
    fillFx(ptxt, GET.powerW + ' !ok ? ' + GREY + ' : (v < 0 ? ' + GREEN + ' : ' + WHITE + ');'); nExpr++;

    // 3. battery
    var bat = shapeLayer('Battery', [1700, 120]);
    addGroup(bat, 'outline', 'rect', [170, 70], 'stroke', [1, 1, 1], 4);
    addGroup(bat, 'level', 'rect', [150, 52], 'fill', [0.2, 0.82, 0.42]);
    var blev = bat.property('ADBE Root Vectors Group').property('level').property('ADBE Vectors Group');
    ex(blev.property(1).property('ADBE Vector Rect Size'), GET.batteryPct + ' [ok ? clamp(v, 0, 100) * 1.5 : 150, 52];');
    ex(blev.property(1).property('ADBE Vector Rect Position'), GET.batteryPct + ' var w = ok ? clamp(v, 0, 100) * 1.5 : 150; [-75 + w / 2, 0];');
    ex(blev.property(2).property('ADBE Vector Fill Color'), GET.batteryPct + ' !ok ? ' + GREY + ' : (v < 20 ? ' + RED + ' : ' + GREEN + ');');
    var btxt = textLayer('Battery %', '0%', 40, [1700, 200], ParagraphJustification.CENTER_JUSTIFY);
    ex(btxt.property('ADBE Text Properties').property('ADBE Text Document'), GET.batteryPct + ' ok ? Math.round(v) + "%" : "[no data]";');
    fillFx(btxt, GET.batteryPct + ' ok ? ' + WHITE + ' : ' + GREY + ';'); nExpr++;

    // 4. clock
    var clk = textLayer('Clock', '00:00:00', 48, [80, 100]);
    ex(clk.property('ADBE Text Properties').property('ADBE Text Document'), GET.clockS +
      ' function p(x) { return (x < 10 ? "0" : "") + x; } var s = Math.floor(v); ok ? p(Math.floor(s / 3600)) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60) : "[no data]";');
    fillFx(clk, GET.clockS + ' ok ? ' + WHITE + ' : ' + GREY + ';'); nExpr++;
    R.expressions = nExpr;
    R.buildMs = now() - tb;

    // output module template names (for aerender), then drop the RQ item
    // Render queue items saved in OUR project (no template prefs touched): 3 single PNG frames
    // (start / middle / end, where data exists) + a 10 s ProRes 4444 alpha preview.
    // aerender then renders them one at a time with -rqindex.
    var base = VH_OUT.replace(/\.aep$/, '');
    var fd = comp.frameDuration;
    var frames = [[60, 'start'], [dur * 0.5 - 10, 'mid'], [dur - 40, 'end']];
    R.rq = [];
    for (var r = 0; r < frames.length; r++) {
      var it = app.project.renderQueue.items.add(comp);
      it.timeSpanStart = Math.round(frames[r][0] / fd) * fd; it.timeSpanDuration = fd;
      var om = it.outputModule(1);
      // 'Format' is read-only via setSettings and there is no PNG template; a new template would
      // change prefs. So render TIFF with alpha and convert to PNG with ffmpeg afterwards.
      om.applyTemplate('TIFF Sequence with Alpha');
      om.file = new File(base + '-' + frames[r][1] + '-[#####].tif');
      R.rq.push(frames[r][1] + '@' + it.timeSpanStart.toFixed(3) + 's');
    }
    if (dur >= 60) {
      var pv = app.project.renderQueue.items.add(comp);
      pv.timeSpanStart = Math.round(30 / fd) * fd; pv.timeSpanDuration = Math.round(10 / fd) * fd;
      pv.outputModule(1).applyTemplate('High Quality with Alpha');
      pv.outputModule(1).file = new File(base + '-preview10s.mov');
      R.rq.push('preview10s@30s');
      R.omTemplates = pv.outputModule(1).templates;
      try { R.previewOM = pv.outputModule(1).getSettings(GetSettingsFormat.STRING)['Video Output']; } catch (e4) {}
    }
    try { R.pngFormat = app.project.renderQueue.item(1).outputModule(1).getSettings(GetSettingsFormat.STRING)['Format']; } catch (e5) {}
    if (dur < 120) { while (app.project.renderQueue.numItems) app.project.renderQueue.item(1).remove(); R.rq = []; }

    var ts = now();
    app.project.save(new File(VH_OUT));
    R.saveMs = now() - ts;
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    var to = now();
    app.open(new File(VH_OUT));
    R.openMs = now() - to;
    // probe expression results at start / gap / mid / end (also catches expression errors)
    var comp2 = null;
    for (var j = 1; j <= app.project.numItems; j++) if (app.project.item(j).name === 'VOLT HUD') comp2 = app.project.item(j);
    var probes = {}, errs = [];
    var tlist = [1, 10, 25, dur * 0.25, dur * 0.5 + 5, dur * 0.75, dur - 30, dur - 5];
    var tp = now();
    for (j = 0; j < tlist.length; j++) {
      var tt = tlist[j];
      probes['t' + Math.round(tt)] = String(comp2.layer('Speed').property('ADBE Text Properties').property('ADBE Text Document').valueAtTime(tt, false)) +
        ' | ' + String(comp2.layer('Power').property('ADBE Text Properties').property('ADBE Text Document').valueAtTime(tt, false)) +
        ' | ' + String(comp2.layer('Battery %').property('ADBE Text Properties').property('ADBE Text Document').valueAtTime(tt, false)) +
        ' | ' + String(comp2.layer('Clock').property('ADBE Text Properties').property('ADBE Text Document').valueAtTime(tt, false));
    }
    R.probeMsPerTime4Texts = Math.round((now() - tp) / tlist.length);
    R.probes = probes;
    var L = ['Speed', 'Power', 'Battery %', 'Clock'];
    for (j = 0; j < L.length; j++) { var pr = comp2.layer(L[j]).property('ADBE Text Properties').property('ADBE Text Document'); if (pr.expressionError) errs.push(L[j] + ': ' + pr.expressionError); }
    R.exprErrors = errs;
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    R.totalMs = now() - t0;
  } catch (e) { R.error = String(e) + ' line ' + e.line; }
  // DoScript(File) returns "0" to osascript in AE 26.5, and File.write is blocked by the
  // "Allow Scripts to Write Files" pref (left off). So results go into a tiny XML project:
  // a folder item whose comment holds the JSON, saved as <out>-result.aepx.
  try {
    if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    app.newProject();
    var rf = app.project.items.addFolder('VH_RESULT'); rf.comment = ser(R);
    app.project.save(new File(VH_OUT.replace(/\.aep$/, '') + '-result.aepx'));
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  } catch (e2) {}
  app.endSuppressDialogs(false);
  return ser(R);
})();
