// Volt HUD comp builder (ExtendScript, ES3). Loaded by the panel (manifest ScriptPath) or by
// ae/test/run-build.sh. It reads a HUD spec written by core/hud/spec.js and builds the comp
// in the CURRENT project: baked keyframes on a hidden "VOLT DATA" null, widgets as shape and
// text layers whose expressions only read those sliders and format them (docs/m0-results.md:
// baked keys render correctly in aerender; sourceData expressions do not).
//
//   VoltHUD.build(specPath)                 -> JSON string {ok, comp, ...} or {ok:false, error}
//   VoltHUD.addPreview(compId, startS, durS, outPath) -> JSON string (ProRes 4444 + alpha RQ item)
//   VoltHUD.ping()                          -> JSON string {ok, ae}
var VoltHUD = (function () {
  var DATA = 'VOLT DATA';
  var MAX_PREVIEW_S = 30;

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
  function readSpec(p) {
    var f = new File(p);
    if (!f.exists) throw new Error('spec not found: ' + p);
    f.encoding = 'UTF-8'; f.open('r'); var txt = f.read(); f.close();
    var s = eval('(' + txt + ')'); // our own file, written by core/hud/spec.js
    if (!s || s.format !== 'volthud-hudspec') throw new Error('not a Volt HUD spec');
    return s;
  }
  function now() { return new Date().getTime(); }
  function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function arr(c) { return '[' + c[0] + ',' + c[1] + ',' + c[2] + ',1]'; }

  // ---------- builder state ----------
  var S, comp, nExpr, warn;

  function V(name) { return 'thisComp.layer(' + q(DATA) + ').effect(' + q(name) + ')(1).value'; }
  function OK(name) {
    var c = S.channels[name];
    if (!c || !c.valid) return 'false';
    return c.ok ? '(' + V(name + '_ok') + ' > 0.5)' : 'true';
  }
  function ex(prop, code) { prop.expression = code; nExpr++; }

  // ---------- data null ----------
  function bakeData() {
    var dl = comp.layers.addNull(comp.duration);
    dl.name = DATA; dl.enabled = false; dl.shy = true; dl.label = 0;
    dl.comment = 'Volt HUD data: baked keyframes from the ride timeline (10 Hz, decimated). Widgets read these sliders.';
    var parade = dl.property('ADBE Effect Parade');
    var keys = 0;
    for (var name in S.channels) {
      if (!S.channels.hasOwnProperty(name)) continue;
      var c = S.channels[name];
      keys += addSlider(parade, name, c.keys.t, c.keys.v, c.hold);
      if (c.ok) keys += addSlider(parade, name + '_ok', c.ok.t, c.ok.v, true);
    }
    return keys;
  }
  function addSlider(parade, name, t, v, hold) {
    var fx = parade.addProperty('ADBE Slider Control'); fx.name = name;
    var p = fx.property(1);
    if (t.length === 1) { p.setValue(v[0]); return 1; }
    p.setValuesAtTimes(t, v);
    if (hold) for (var k = 1; k <= p.numKeys; k++) p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    return t.length;
  }

  // ---------- layer helpers (local widget coordinates, parented to the widget null) ----------
  function widgetNull(w, label) {
    var n = comp.layers.addNull(comp.duration);
    n.name = 'HUD ' + label;
    var tr = n.property('ADBE Transform Group');
    tr.property('ADBE Anchor Point').setValue([0, 0]);
    tr.property('ADBE Position').setValue([w.x, w.y]);
    tr.property('ADBE Scale').setValue([w.k * 100, w.k * 100]);
    n.comment = 'Move or scale this null to move the whole ' + label + ' widget.';
    return n;
  }
  function attach(layer, parent, pos) {
    var tr = layer.property('ADBE Transform Group');
    tr.property('ADBE Anchor Point').setValue([0, 0]);
    tr.property('ADBE Position').setValue(pos || [0, 0]);
    layer.setParentWithJump(parent); // children are added above their null, later ones on top
    return layer;
  }
  function shape(parent, name, pos) { var l = comp.layers.addShape(); l.name = name; return attach(l, parent, pos); }
  // Adds a group; items: list of {t:'rect'|'ellipse'|'path', ...} then paint {fill|stroke}. Returns group name.
  function group(layer, gname, geo, paint) {
    var root = layer.property('ADBE Root Vectors Group');
    var g = root.addProperty('ADBE Vector Group'); g.name = gname;
    var gc = g.property('ADBE Vectors Group');
    if (geo.t === 'rect') gc.addProperty('ADBE Vector Shape - Rect');
    else if (geo.t === 'ellipse') gc.addProperty('ADBE Vector Shape - Ellipse');
    else gc.addProperty('ADBE Vector Shape - Group');
    if (paint.trim) gc.addProperty('ADBE Vector Filter - Trim');
    gc.addProperty(paint.stroke ? 'ADBE Vector Graphic - Stroke' : 'ADBE Vector Graphic - Fill');
    gc = layer.property('ADBE Root Vectors Group').property(gname).property('ADBE Vectors Group'); // re-fetch (stale refs)
    var shp = gc.property(1);
    if (geo.t === 'rect') {
      shp.property('ADBE Vector Rect Size').setValue(geo.size);
      shp.property('ADBE Vector Rect Position').setValue(geo.pos);
      if (geo.r) shp.property('ADBE Vector Rect Roundness').setValue(geo.r);
    } else if (geo.t === 'ellipse') {
      shp.property('ADBE Vector Ellipse Size').setValue(geo.size);
      shp.property('ADBE Vector Ellipse Position').setValue(geo.pos);
    } else {
      var sh = new Shape(); sh.vertices = geo.pts; sh.closed = !!geo.closed; shp.property('ADBE Vector Shape').setValue(sh);
    }
    var pn = gc.property(paint.trim ? 3 : 2);
    if (paint.stroke) {
      pn.property('ADBE Vector Stroke Color').setValue(paint.color);
      pn.property('ADBE Vector Stroke Width').setValue(paint.width || 2);
      if (paint.round) pn.property('ADBE Vector Stroke Line Cap').setValue(2);
      if (paint.opacity != null) pn.property('ADBE Vector Stroke Opacity').setValue(paint.opacity * 100);
    } else {
      pn.property('ADBE Vector Fill Color').setValue(paint.color);
      if (paint.opacity != null) pn.property('ADBE Vector Fill Opacity').setValue(paint.opacity * 100);
    }
    return { shape: shp, trim: paint.trim ? gc.property(2) : null, paint: pn, name: gname };
  }
  function G(layer, gname) { return layer.property('ADBE Root Vectors Group').property(gname).property('ADBE Vectors Group'); }

  var JUST = null;
  function text(parent, name, str, font, size, color, just, pos) {
    if (!JUST) JUST = { l: ParagraphJustification.LEFT_JUSTIFY, c: ParagraphJustification.CENTER_JUSTIFY, r: ParagraphJustification.RIGHT_JUSTIFY };
    var l = comp.layers.addText(str); l.name = name;
    var sp = l.property('ADBE Text Properties').property('ADBE Text Document');
    var td = sp.value;
    try { td.resetCharStyle(); } catch (e) {}
    try { td.resetParagraphStyle(); } catch (e2) {}
    td.font = S.fonts[font] || font; td.fontSize = size;
    td.applyFill = true; td.fillColor = [color[0], color[1], color[2]]; td.applyStroke = false;
    td.justification = JUST[just || 'l'];
    try { td.firstLineIndent = 0; td.spaceBefore = 0; td.spaceAfter = 0; td.baselineShift = 0; td.tracking = 0; } catch (e3) {}
    try { td.allCaps = false; td.smallCaps = false; td.fauxBold = false; td.fauxItalic = false; td.horizontalScale = 1; td.verticalScale = 1; } catch (e4) {}
    sp.setValue(td);
    return attach(l, parent, pos);
  }
  function source(l) { return l.property('ADBE Text Properties').property('ADBE Text Document'); }
  function fillFx(l, code) {
    var par = l.property('ADBE Effect Parade');
    par.addProperty('ADBE Fill');
    ex(par.property(par.numProperties).property('ADBE Fill-0002'), code);
  }
  function opacity(l, code) { ex(l.property('ADBE Transform Group').property('ADBE Opacity'), code); }
  function plate(parent, name, size, pos, r) {
    if (!(S.plate > 0)) return null;
    var l = shape(parent, name);
    group(l, 'plate', { t: 'rect', size: size, pos: pos, r: r }, { color: S.colors.bg, opacity: S.plate });
    return l;
  }
  var C;
  // A plate that follows the width of one or more text layers. align: l | c | r within boxW.
  function fitPlate(pl, names, align, boxW, h, minW, pad) {
    if (!pl) return;
    var w = 'var w = ' + minW + '; ' ;
    for (var i = 0; i < names.length; i++) w += 'w = Math.max(w, thisComp.layer(' + q(names[i]) + ').sourceRectAtTime(time, false).width + ' + 2 * pad + '); ';
    var x = align === 'c' ? boxW / 2 + '' : align === 'r' ? boxW + ' - w / 2' : 'w / 2';
    ex(G(pl, 'plate').property(1).property('ADBE Vector Rect Size'), w + '[w, ' + h + '];');
    ex(G(pl, 'plate').property(1).property('ADBE Vector Rect Position'), w + '[' + x + ', ' + h / 2 + '];');
  }
  function alignX(align, boxW, pad) { return align === 'c' ? boxW / 2 : align === 'r' ? boxW - pad : pad; }
  // expression snippets
  var DASH = '"\\u2014"', NODATA = '"[no data]"';
  var SEP = 'function sep(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");} ';

  // ---------- widgets ----------
  function wSpeed(w) {
    var p = w.p, nl = widgetNull(w, 'Speed');
    var ring = shape(nl, 'Speed ring');
    var val = group(ring, 'value', { t: 'ellipse', size: [368, 368], pos: [200, 200] }, { stroke: true, color: C.accent, width: 18, round: true, trim: true });
    var trk = group(ring, 'track', { t: 'ellipse', size: [368, 368], pos: [200, 200] }, { stroke: true, color: C.surface, width: 18, round: true, trim: true, opacity: 0.85 });
    var tg = G(ring, 'track');
    tg.property(2).property('ADBE Vector Trim End').setValue(75); tg.property(2).property('ADBE Vector Trim Offset').setValue(-135);
    var vg = G(ring, 'value');
    vg.property(2).property('ADBE Vector Trim Offset').setValue(-135);
    ex(vg.property(2).property('ADBE Vector Trim End'), 'var ok = ' + OK('ring') + '; ok ? clamp(' + V('ring') + ' / ' + p.ringMax + ', 0, 1) * 75 : 0;');
    ex(vg.property(3).property('ADBE Vector Stroke Opacity'), OK('ring') + ' && ' + V('ring') + ' > 0.3 ? 100 : 0;');
    var num = text(nl, 'Speed value', '0', 'bold', 150, C.text, 'c', [200, 240]);
    ex(source(num), 'var ok = ' + OK('spd') + '; ok ? String(Math.round(' + V('spd') + ')) : ' + DASH + ';');
    fillFx(num, OK('spd') + ' ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
    var u = text(nl, 'Speed unit', p.unit, 'regular', 30, C.label, 'c', [200, 288]);
    ex(source(u), OK('spd') + ' ? ' + q(p.unit) + ' : ' + NODATA + ';');
    fillFx(u, OK('spd') + ' ? ' + arr(C.label) + ' : ' + arr(C.dim) + ';');
  }

  function wPower(w) {
    var p = w.p, nl = widgetNull(w, 'Power');
    var H = 420, y0 = Math.round(0.89 * H * 10) / 10, top = 3, drawPx = y0 - top, regenPx = H - top - y0;
    var tr = shape(nl, 'Power track');
    // first group draws on top: ticks + zero line, then the pill
    var i, y;
    for (i = 0; i < p.ticksDraw.length; i++) { y = y0 - (p.ticksDraw[i] / p.scaleDraw) * drawPx; group(tr, 'tick d' + p.ticksDraw[i], { t: 'rect', size: [36, 2], pos: [32, y] }, { color: C.outline }); }
    for (i = 0; i < p.ticksRegen.length; i++) { y = y0 + (p.ticksRegen[i] / p.scaleRegen) * regenPx; group(tr, 'tick r' + p.ticksRegen[i], { t: 'rect', size: [36, 2], pos: [32, y] }, { color: C.outline }); }
    group(tr, 'zero', { t: 'rect', size: [64, 2], pos: [32, y0] }, { color: C.muted });
    group(tr, 'pill', { t: 'rect', size: [64, H], pos: [32, H / 2], r: 32 }, { color: C.surface, opacity: 0.85 });

    var pw = V('pw'), ok = OK('pw'), dir = V('pwdir');
    var pre = 'var ok = ' + ok + '; var v = ' + pw + '; var d = Math.round(' + dir + '); ';
    var dr = shape(nl, 'Power draw');
    group(dr, 'bar', { t: 'rect', size: [58, 10], pos: [32, y0 - 5], r: 29 }, { color: C.accent });
    var bg = G(dr, 'bar');
    ex(bg.property(1).property('ADBE Vector Rect Size'), pre + 'var h = Math.max(8, clamp(Math.abs(v) / ' + p.scaleDraw + ', 0, 1) * ' + drawPx + '); [58, h];');
    ex(bg.property(1).property('ADBE Vector Rect Position'), pre + 'var h = Math.max(8, clamp(Math.abs(v) / ' + p.scaleDraw + ', 0, 1) * ' + drawPx + '); [32, ' + y0 + ' - h / 2];');
    opacity(dr, pre + '(ok && (d == 0 || v > 1)) ? 100 : 0;');
    // red gradient up (accentDeep at the zero line -> lighter accent at the top); muted when the direction is unknown
    var ramp = dr.property('ADBE Effect Parade').addProperty('ADBE Ramp');
    ramp = dr.property('ADBE Effect Parade').property(1);
    var off = [comp.width / 2, comp.height / 2]; // shape-layer contents (0,0) sits at the centre of layer space
    ramp.property('ADBE Ramp-0001').setValue([32 + off[0], y0 + off[1]]);
    ramp.property('ADBE Ramp-0003').setValue([32 + off[0], top + off[1]]);
    ex(ramp.property('ADBE Ramp-0002'), 'Math.round(' + dir + ') == 0 ? ' + arr(C.muted) + ' : ' + arr(C.accentDeep) + ';');
    ex(ramp.property('ADBE Ramp-0004'), 'Math.round(' + dir + ') == 0 ? ' + arr(C.muted) + ' : ' + arr(C.accentHi) + ';');

    var rg = shape(nl, 'Power regen');
    group(rg, 'bar', { t: 'rect', size: [58, 8], pos: [32, y0 + 4], r: 29 }, { color: C.ok });
    var rgg = G(rg, 'bar');
    ex(rgg.property(1).property('ADBE Vector Rect Size'), pre + 'var h = Math.max(8, clamp(-v / ' + p.scaleRegen + ', 0, 1) * ' + regenPx + '); [58, h];');
    ex(rgg.property(1).property('ADBE Vector Rect Position'), pre + 'var h = Math.max(8, clamp(-v / ' + p.scaleRegen + ', 0, 1) * ' + regenPx + '); [32, ' + y0 + ' + h / 2];');
    opacity(rg, pre + '(ok && d != 0 && v < -1) ? 100 : 0;');

    var pk = shape(nl, 'Power peak');
    group(pk, 'tick', { t: 'rect', size: [68, 4], pos: [32, y0], r: 2 }, { color: C.text });
    ex(G(pk, 'tick').property(1).property('ADBE Vector Rect Position'), '[32, ' + y0 + ' - clamp(' + V('pwpk') + ' / ' + p.scaleDraw + ', 0, 1) * ' + drawPx + '];');
    opacity(pk, OK('pwpk') + ' && ' + OK('pw') + ' && ' + V('pwpk') + ' > 50 ? 100 : 0;');

    var num = text(nl, 'Power value', '0', 'bold', 56, C.text, 'l', [88, 384]);
    ex(source(num), SEP + pre + 'ok ? sep(Math.round(Math.abs(v))) : ' + DASH + ';');
    fillFx(num, pre + '!ok ? ' + arr(C.dim) + ' : (d != 0 && v < -1 ? ' + arr(C.ok) + ' : ' + arr(C.text) + ');');
    var u = text(nl, 'Power unit', 'W draw', 'regular', 24, C.label, 'l', [88, 418]);
    ex(source(u), pre + '!ok ? ' + NODATA + ' : (d == 0 ? "W" : (v < -1 ? "W regen" : "W draw"));');
    fillFx(u, ok + ' ? ' + arr(C.label) + ' : ' + arr(C.dim) + ';');
  }

  function wBattery(w) {
    var nl = widgetNull(w, 'Battery');
    var seg = shape(nl, 'Battery segments');
    var pre = 'var ok = ' + OK('bat') + '; var v = ' + V('bat') + '; ';
    var band = '(v < 15 ? ' + arr(C.danger) + ' : (v < 30 ? ' + arr(C.orange) + ' : ' + arr(C.ok) + '))';
    for (var i = 9; i >= 0; i--) {
      var g = group(seg, 's' + i, { t: 'rect', size: [29, 18], pos: [i * 34 + 14.5, 15], r: 6 }, { color: C.raised });
      var lit = 'Math.max(v > 0 ? 1 : 0, Math.round(v / 10))';
      ex(G(seg, 's' + i).property(2).property('ADBE Vector Fill Color'), pre + '(ok && ' + lit + ' > ' + i + ') ? ' + band + ' : ' + arr(C.raised) + ';');
    }
    var t = text(nl, 'Battery value', '0 %', 'semibold', 26, C.text, 'l', [350, 24]);
    ex(source(t), pre + 'ok ? Math.round(v) + " %" : ' + NODATA + ';');
    fillFx(t, OK('bat') + ' ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
  }

  function wVertical(w) {
    var p = w.p, nl = widgetNull(w, 'Vertical rate');
    plate(nl, 'Vertical plate', [280, 96], [140, 48], 20);
    var ar = shape(nl, 'Vertical arrow', [48, 51]);
    group(ar, 'arrow', { t: 'path', pts: [[0, -37], [22, 3], [8, 3], [8, 37], [-8, 37], [-8, 3], [-22, 3]], closed: true }, { color: C.blue });
    var ok = OK('vrt'), v = V('vrt');
    // climbing points up (fully at 0.3 m/s), level (under 0.1 m/s, see core) points right, descending points down
    ex(ar.property('ADBE Transform Group').property('ADBE Rotate Z'), '90 - clamp(' + v + ' / 0.3, -1, 1) * 90;');
    opacity(ar, ok + ' ? 100 : 0;');
    var k = p.unit === 'ft/min' ? 196.850394 : 60;
    var grd = 'var gok = ' + OK('grd') + '; var g = ' + V('grd') + '; ';
    var sign = 'function sg(x){return (x > 0 ? "+" : "") + x;} ';
    var main = text(nl, 'Vertical value', '0', 'semibold', 40, C.text, 'l', [92, 50]);
    var sub = text(nl, 'Vertical unit', '', 'regular', 22, C.muted, 'l', [92, 80]);
    if (p.unit === 'grade') {
      ex(source(main), sign + grd + 'gok ? sg(Math.round(g)) + " %" : (' + ok + ' ? "level" : ' + DASH + ');');
      ex(source(sub), grd + 'var ok = ' + ok + '; ok ? "grade" + (gok ? "" : " (slow)") : ' + NODATA + ';');
      fillFx(main, '(' + OK('grd') + ' || ' + ok + ') ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
    } else {
      ex(source(main), sign + 'var ok = ' + ok + '; ok ? sg(Math.round(' + v + ' * ' + k + ')) : ' + DASH + ';');
      ex(source(sub), grd + 'var ok = ' + ok + '; ok ? ' + q(p.unit) + ' + (gok ? " \\u00b7 " + Math.round(g) + " %" : "") : ' + NODATA + ';');
      fillFx(main, ok + ' ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
    }
    fillFx(sub, ok + ' ? ' + arr(C.muted) + ' : ' + arr(C.dim) + ';');
  }

  function wGmeter(w) {
    var p = w.p, nl = widgetNull(w, 'G-meter');
    var dial = shape(nl, 'G dial');
    group(dial, 'cross', { t: 'path', pts: [[10, 110], [230, 110]] }, { stroke: true, color: C.muted, width: 1.5, opacity: 0.35 });
    group(dial, 'cross2', { t: 'path', pts: [[120, 0], [120, 220]] }, { stroke: true, color: C.muted, width: 1.5, opacity: 0.35 });
    group(dial, 'ring 0.25 g', { t: 'ellipse', size: [110, 110], pos: [120, 110] }, { stroke: true, color: C.muted, width: 1.5, opacity: 0.35 });
    group(dial, 'ring 0.5 g', { t: 'ellipse', size: [220, 220], pos: [120, 110] }, { stroke: true, color: C.muted, width: 2, opacity: 0.5 });
    if (S.plate > 0) group(dial, 'plate', { t: 'ellipse', size: [220, 220], pos: [120, 110] }, { color: C.bg, opacity: S.plate });
    var gx = V('glat'), gy = V('glon');
    var fn = 'function P(t){ var x = -thisComp.layer(' + q(DATA) + ').effect("glat")(1).valueAtTime(t) * ' + p.pxPerG + '; var y = -thisComp.layer(' + q(DATA) + ').effect("glon")(1).valueAtTime(t) * ' + p.pxPerG + '; var r = Math.sqrt(x * x + y * y); if (r > 110) { x = x * 110 / r; y = y * 110 / r; } return [120 + x, 110 + y]; } ';
    var trail = shape(nl, 'G trail');
    group(trail, 'trail', { t: 'path', pts: [[120, 110], [121, 110]] }, { stroke: true, color: C.accent, width: 4, round: true, opacity: 0.5 });
    ex(G(trail, 'trail').property(1).property('ADBE Vector Shape'), fn + 'var pts = []; for (var i = 8; i >= 0; i--) pts.push(P(time - i * ' + (p.trailS / 8) + ')); createPath(pts, [], [], false);');
    opacity(trail, OK('glon') + ' ? 100 : 0;');
    var dot = shape(nl, 'G dot');
    group(dot, 'dot', { t: 'ellipse', size: [20, 20], pos: [0, 0] }, { color: C.text });
    ex(dot.property('ADBE Transform Group').property('ADBE Position'), fn + 'P(time);');
    opacity(dot, OK('glon') + ' ? 100 : 0;');
    var t = text(nl, 'G value', '0.00 g', 'regular', 24, C.label, 'c', [120, 254]);
    var fmt = p.unit === 'm/s2' ? '(v * 9.80665).toFixed(1) + " m/s\\u00b2"' : 'v.toFixed(2) + " g"';
    ex(source(t), 'var ok = ' + OK('gtot') + '; var v = ' + V('gtot') + '; ok ? ' + fmt + ' : ' + NODATA + ';');
    fillFx(t, OK('gtot') + ' ? ' + arr(C.label) + ' : ' + arr(C.dim) + ';');
    void gx; void gy;
  }

  function wJerk(w) {
    var p = w.p, nl = widgetNull(w, 'Jerk');
    var b = shape(nl, 'Jerk bar');
    group(b, 'fill', { t: 'rect', size: [10, 10], pos: [5, 5], r: 5 }, { color: C.orange });
    group(b, 'track', { t: 'rect', size: [220, 10], pos: [110, 5], r: 5 }, { color: C.surface, opacity: 0.85 });
    var pre = 'var ok = ' + OK('jrk') + '; var w = Math.max(10, clamp(' + V('jrk') + ' / ' + p.max + ', 0, 1) * 220); ';
    var fg = G(b, 'fill');
    ex(fg.property(1).property('ADBE Vector Rect Size'), pre + '[w, 10];');
    ex(fg.property(1).property('ADBE Vector Rect Position'), pre + '[w / 2, 5];');
    ex(fg.property(2).property('ADBE Vector Fill Opacity'), pre + 'ok ? 100 : 0;');
    var t = text(nl, 'Jerk label', 'jerk', 'regular', 20, C.label, 'c', [110, 44]);
    ex(source(t), OK('jrk') + ' ? "jerk" : "jerk " + ' + NODATA + ';');
    fillFx(t, OK('jrk') + ' ? ' + arr(C.label) + ' : ' + arr(C.dim) + ';');
  }

  function wClock(w) {
    var p = w.p, nl = widgetNull(w, 'Clock');
    var cpl = plate(nl, 'Clock plate', [316, 112], [158, 56], 26);
    var pre = 'var ok = ' + OK('clk') + '; var v = ' + V('clk') + '; var s = Math.floor(v + 1e-6); var day = Math.floor(s / 86400); var r = s - day * 86400; ' +
      'function z(x){return (x < 10 ? "0" : "") + x;} var h = Math.floor(r / 3600), m = Math.floor(r / 60) % 60, sec = r % 60; ';
    var tm = text(nl, 'Clock time', '00:00:00', 'semibold', 54, C.text, 'r', [300, 62]);
    var body = p.clock24 ? 'z(h) + ":" + z(m) + ":" + z(sec)' : '((h % 12) || 12) + ":" + z(m) + ":" + z(sec) + (h < 12 ? " AM" : " PM")';
    ex(source(tm), pre + 'ok ? ' + body + ' : ' + DASH + ';');
    fillFx(tm, OK('clk') + ' ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
    var dt = text(nl, 'Clock date', '', 'regular', 26, C.muted, 'r', [300, 98]);
    var dfmt = p.clock24 ? 'W[D.getUTCDay()] + " " + D.getUTCDate() + " " + M[D.getUTCMonth()] + " " + D.getUTCFullYear()' : 'W[D.getUTCDay()] + " " + M[D.getUTCMonth()] + " " + D.getUTCDate() + " " + D.getUTCFullYear()';
    ex(source(dt), pre + 'var W = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; var D = new Date(' + p.baseDayMs + ' + day * 86400000); ok ? ' + dfmt + ' : ' + NODATA + ';');
    fillFx(dt, OK('clk') + ' ? ' + arr(C.muted) + ' : ' + arr(C.dim) + ';');
    fitPlate(cpl, ['Clock time', 'Clock date'], 'r', 316, 112, 200, 16);
  }

  function wStats(w) {
    var p = w.p, nl = widgetNull(w, 'Ride stats');
    var pl = plate(nl, 'Stats plate', [640, 48], [320, 24], 16);
    var t = text(nl, 'Stats text', 'Trip', 'regular', 26, C.text, w.align, [alignX(w.align, 640, 20), 33]);
    var dur = 'function z(x){return (x < 10 ? "0" : "") + x;} function hms(x){ x = Math.floor(x); var h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, s = x % 60; return (h > 0 ? h + ":" + z(m) : m) + ":" + z(s); } ';
    ex(source(t), dur + 'var ok = ' + OK('trip') + '; var el = clamp(time - ' + p.rideStart + ', 0, ' + (p.rideEnd - p.rideStart) + '); ' +
      'ok ? "Trip " + ' + V('trip') + '.toFixed(1) + " ' + p.distUnit + ' \\u00b7 " + hms(el) + " \\u00b7 max " + Math.round(' + V('vmax') + ') + " ' + p.speedUnit + '" : "Trip ' + NODATA.slice(1, -1) + '";');
    fillFx(t, OK('trip') + ' ? ' + arr(C.text) + ' : ' + arr(C.dim) + ';');
    t.property('ADBE Transform Group').property('ADBE Opacity').setValue(90);
    fitPlate(pl, [t.name], w.align, 640, 48, 120, 20);
  }

  function wCoords(w) {
    var nl = widgetNull(w, 'Coordinates');
    var pl = plate(nl, 'Coords plate', [520, 48], [260, 24], 16);
    var t = text(nl, 'Coords text', '', 'regular', 26, C.muted, w.align, [alignX(w.align, 520, 20), 33]);
    ex(source(t), 'var ok = ' + OK('lat') + '; var a = ' + V('lat') + ', b = ' + V('lon') + '; ok ? Math.abs(a).toFixed(5) + "\\u00b0 " + (a >= 0 ? "N" : "S") + "   " + Math.abs(b).toFixed(5) + "\\u00b0 " + (b >= 0 ? "E" : "W") : ' + NODATA + ';');
    fillFx(t, OK('lat') + ' ? ' + arr(C.muted) + ' : ' + arr(C.dim) + ';');
    fitPlate(pl, [t.name], w.align, 520, 48, 120, 20);
  }

  function wMap(w) {
    var p = w.p, nl = widgetNull(w, 'Mini-map');
    plate(nl, 'Map plate', [300, 300], [150, 150], 26);
    if (p.path && p.path.length >= 2) {
      var rt = shape(nl, 'Map route');
      group(rt, 'travelled', { t: 'path', pts: p.path }, { stroke: true, color: C.accent, width: 5, round: true, trim: true });
      group(rt, 'route', { t: 'path', pts: p.path }, { stroke: true, color: C.muted, width: 4, round: true, opacity: 0.45 });
      ex(G(rt, 'travelled').property(2).property('ADBE Vector Trim End'), OK('mapp') + ' ? ' + V('mapp') + ' : 0;');
    }
    var dot = shape(nl, 'Map dot');
    group(dot, 'dot', { t: 'ellipse', size: [16, 16], pos: [0, 0] }, { color: C.text });
    ex(dot.property('ADBE Transform Group').property('ADBE Position'), '[' + V('mapx') + ', ' + V('mapy') + '];');
    opacity(dot, OK('mapx') + ' ? 100 : 0;');
    if (!p.path) { var t = text(nl, 'Map no data', '[no data]', 'regular', 24, C.dim, 'c', [150, 158]); void t; }
  }

  // Soft dark shadow under every text layer, so muted labels stay legible over bright video.
  function shadows() {
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (!(l instanceof TextLayer)) continue;
      var par = l.property('ADBE Effect Parade');
      par.addProperty('ADBE Drop Shadow');
      var d = par.property(par.numProperties);
      d.property('ADBE Drop Shadow-0001').setValue([0, 0, 0]);
      var op = d.property('ADBE Drop Shadow-0002');
      op.setValue(op.hasMax ? op.maxValue * 0.7 : 180);
      d.property('ADBE Drop Shadow-0004').setValue(2);
      d.property('ADBE Drop Shadow-0005').setValue(8);
    }
  }

  var BUILDERS = { speed: wSpeed, power: wPower, battery: wBattery, vertical: wVertical, gmeter: wGmeter, jerk: wJerk, clock: wClock, stats: wStats, coords: wCoords, map: wMap };

  function fontsMissing() {
    var miss = [];
    try {
      if (!app.fonts || !app.fonts.getFontsByPostScriptName) return null;
      for (var k in S.fonts) if (S.fonts.hasOwnProperty(k)) { var l = app.fonts.getFontsByPostScriptName(S.fonts[k]); if (!l || !l.length) miss.push(S.fonts[k]); }
    } catch (e) { return null; }
    return miss;
  }

  // Evaluate every expression at a few times and collect errors (cheap: a few dozen layers).
  function exprErrors(c, times) {
    var out = [];
    function walk(g, lname) {
      for (var i = 1; i <= g.numProperties; i++) {
        var p = g.property(i);
        if (p.propertyType === PropertyType.PROPERTY) {
          if (p.canSetExpression && p.expression !== '' && p.expressionEnabled) {
            for (var k = 0; k < times.length; k++) { try { p.valueAtTime(times[k], false); } catch (e) {} }
            if (p.expressionError) out.push(lname + ' / ' + p.name + ': ' + p.expressionError);
          }
        } else walk(p, lname);
      }
    }
    for (var j = 1; j <= c.numLayers; j++) walk(c.layer(j), c.layer(j).name);
    return out;
  }

  function uniqueName(base) {
    var names = {};
    for (var i = 1; i <= app.project.numItems; i++) names[app.project.item(i).name] = 1;
    if (!names[base]) return base;
    for (var n = 2; ; n++) if (!names[base + ' ' + n]) return base + ' ' + n;
  }

  function build(specPath) {
    var R = { ok: false };
    var t0 = now();
    app.beginUndoGroup('Build Volt HUD');
    try {
      S = readSpec(specPath); C = S.colors; nExpr = 0; warn = [];
      R.readMs = now() - t0;
      if (!app.project) app.newProject();
      var tb = now();
      var frameDur = 1 / S.comp.fps;
      var dur = S.comp.frames * frameDur;
      var folder = null;
      for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i) instanceof FolderItem && app.project.item(i).name === 'Volt HUD') folder = app.project.item(i);
      if (!folder) folder = app.project.items.addFolder('Volt HUD');
      comp = app.project.items.addComp(uniqueName(S.comp.name), S.comp.width, S.comp.height, 1, dur, S.comp.fps);
      comp.parentFolder = folder;
      comp.bgColor = [0, 0, 0];
      comp.comment = 'Volt HUD overlay (alpha). Built from ' + (S.source.files || []).join(', ') + '. t=0 = first frame of the .360. Sync: ' +
        (S.source.sync ? S.source.sync.method + ', ' + S.source.sync.confidence + ', nudge ' + S.source.sync.nudge_ms + ' ms' : 'n/a');
      R.keys = bakeData();
      R.bakeMs = now() - tb;
      for (var w = 0; w < S.widgets.length; w++) BUILDERS[S.widgets[w].id](S.widgets[w]);
      shadows();
      comp.hideShyLayers = true;
      R.ok = true;
      R.comp = comp.name; R.compId = comp.id;
      R.width = comp.width; R.height = comp.height; R.fps = comp.frameRate;
      R.durationS = comp.duration; R.frames = Math.round(comp.duration * comp.frameRate);
      R.durationOk = R.frames === S.comp.frames && Math.abs(comp.duration - S.comp.durationS) < frameDur;
      R.layers = comp.numLayers; R.expressions = nExpr; R.widgets = S.widgets.length;
      R.fontsMissing = fontsMissing();
      R.exprErrors = exprErrors(comp, [0, comp.duration / 2, comp.duration - comp.frameDuration]);
      R.warnings = S.warnings.concat(warn);
      R.buildMs = now() - t0;
      comp.openInViewer();
    } catch (e) {
      R.error = String(e) + (e.line ? ' (line ' + e.line + ')' : '');
    }
    app.endUndoGroup();
    S = null;
    return ser(R);
  }

  function findComp(id) {
    for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it.id === id && it instanceof CompItem) return it; }
    return null;
  }

  // Short ProRes 4444 (+ alpha) preview: a render-queue item only; the user presses Render.
  function addPreview(compId, startS, durS, outPath) {
    var R = { ok: false };
    try {
      var c = findComp(compId);
      if (!c) throw new Error('Volt HUD comp not found (build it first)');
      durS = Math.min(Math.max(1, durS), MAX_PREVIEW_S);
      var fd = c.frameDuration;
      var st = Math.max(0, Math.min(Math.round(startS / fd) * fd, c.duration - fd));
      var du = Math.min(Math.round(durS / fd) * fd, c.duration - st);
      var it = app.project.renderQueue.items.add(c);
      it.timeSpanStart = st; it.timeSpanDuration = du;
      var om = it.outputModule(1);
      om.applyTemplate('High Quality with Alpha');
      om.file = new File(outPath);
      R.ok = true; R.startS = st; R.durationS = du; R.file = om.file.fsName;
      try { R.video = om.getSettings(GetSettingsFormat.STRING)['Video Output']; } catch (e2) {}
    } catch (e) { R.error = String(e); }
    return ser(R);
  }

  function ping() { return ser({ ok: true, ae: app.version, project: app.project && app.project.file ? app.project.file.name : null }); }

  return { build: build, addPreview: addPreview, ping: ping, ser: ser };
})();
