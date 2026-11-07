'use strict';
// Widget boxes and layout presets. Design units are pixels of a 1080-px short side
// (1920x1080 or 1080x1920) at 100 % scale; everything is relative to the safe area,
// so 4K comps and other scales follow.
//
// A placement is {at:[ax,ay], pivot:[px,py], off:[dx,dy], s}: the point `at` (0..1 of the
// safe rect) plus `off` (design px x user scale) is where the widget box's `pivot` (0..1 of
// the box) lands. `s` is the widget's own size factor within the preset.

const BOX = {
  speed: [400, 345], power: [300, 420], battery: [420, 30], vertical: [280, 96], gmeter: [240, 266],
  jerk: [220, 50], clock: [316, 112], stats: [640, 48], coords: [520, 48], map: [300, 300],
};

const P = (at, pivot, off, s) => ({ at, pivot, off: off || [0, 0], s: s || 1 });
// coords, map (and the stats strip in the Strip preset) stack down from the top-left corner
const TL = () => Object.assign(P([0, 0], [0, 0]), { stack: true });
const TOP = { clock: P([1, 0], [1, 0]), coords: TL(), map: TL() };
const STACK_ORDER = ['coords', 'map', 'stats'], STACK_GAP = 16;

const PRESET = {
  focus: Object.assign({}, TOP, {
    stats: P([0, 1], [0, 1]),
    power: P([0, 1], [0, 1], [24, -72]),
    speed: P([0.5, 1], [0.5, 1], [0, -56]),
    battery: P([0.5, 1], [0.5, 1], [0, -8]),
    vertical: P([0.5, 1], [0, 1], [250, -150]),
    gmeter: P([1, 1], [1, 1], [-40, -70]),
    jerk: P([1, 1], [1, 1], [-50, 0]),
  }),
  corner: Object.assign({}, TOP, {
    stats: P([0, 1], [0, 1], [0, 0], 0.8),
    power: P([0, 1], [0, 1], [0, -70], 0.6),
    speed: P([0, 1], [0, 1], [190, -70], 0.7),
    battery: P([0, 1], [0, 1], [204, -46], 0.6),
    vertical: P([0, 1], [0, 1], [580, -266], 0.7),
    gmeter: P([0, 1], [0, 1], [580, -70], 0.7),
    jerk: P([0, 1], [0, 1], [588, -30], 0.7),
  }),
  vertical: Object.assign({}, TOP, {
    stats: P([0.5, 1], [0.5, 1], [0, 0], 0.9),
    battery: P([0.5, 1], [0.5, 1], [0, -64]),
    speed: P([0.5, 1], [0.5, 1], [0, -110]),
    power: P([0, 1], [0, 1], [0, -110], 0.75),
    gmeter: P([1, 1], [1, 1], [0, -110], 0.85),
    jerk: P([1, 1], [1, 1], [-9, -350], 0.85),
    vertical: P([1, 1], [1, 1], [0, -410], 0.9),
  }),
};
// Strip: one bottom row, laid out by flow (see layoutWidgets).
const STRIP_ORDER = ['power', 'speed', 'battery', 'vertical', 'gmeter', 'jerk'];
const STRIP_ROW = 200, STRIP_GAP = 40;

// Returns {safe:[x0,y0,x1,y1], u, widgets:{id:{x,y,k,w,h}}} in comp pixels.
// (x,y) = top-left of the widget box; k = scale of design px -> comp px.
function layoutWidgets(style) {
  const W = style.comp[0], H = style.comp[1];
  const u = (Math.min(W, H) / 1080) * style.scale;
  const sx0 = W * style.safe, sy0 = H * style.safe, sx1 = W - sx0, sy1 = H - sy0;
  const on = Object.keys(BOX).filter((k) => style.widgets[k]);
  const place = {};
  if (style.preset === 'strip') {
    Object.assign(place, TOP, { stats: TL() });
    const row = STRIP_ORDER.filter((k) => on.indexOf(k) >= 0);
    const sOf = (k) => Math.min(1, STRIP_ROW / BOX[k][1]);
    let width = row.reduce((a, k) => a + BOX[k][0] * sOf(k), 0) + STRIP_GAP * Math.max(0, row.length - 1);
    const fit = Math.min(1, (sx1 - sx0) / u / width);
    width *= fit;
    let x = ((sx1 - sx0) / u - width) / 2;
    for (const k of row) {
      const s = sOf(k) * fit;
      place[k] = P([0, 1], [0, 1], [x, 0], s);
      x += BOX[k][0] * s + STRIP_GAP * fit;
    }
  } else Object.assign(place, PRESET[style.preset] || PRESET.focus);

  const out = {};
  let stackY = 0;
  const ordered = on.slice().sort((a, b) => STACK_ORDER.indexOf(a) - STACK_ORDER.indexOf(b));
  for (const k of ordered) {
    const p = place[k];
    if (!p) continue;
    const kk = u * p.s;
    let offY = p.off[1];
    if (p.stack) { offY += stackY; stackY += BOX[k][1] * p.s + STACK_GAP; }
    const x = sx0 + p.at[0] * (sx1 - sx0) + p.off[0] * u - p.pivot[0] * BOX[k][0] * kk;
    const y = sy0 + p.at[1] * (sy1 - sy0) + offY * u - p.pivot[1] * BOX[k][1] * kk;
    out[k] = { x: r2(x), y: r2(y), k: Math.round(kk * 1e5) / 1e5, w: BOX[k][0], h: BOX[k][1], align: p.pivot[0] === 0.5 ? 'c' : p.pivot[0] === 1 ? 'r' : 'l' };
  }
  return { safe: [sx0, sy0, sx1, sy1].map(r2), u, widgets: out };
}
function r2(x) { return Math.round(x * 100) / 100; }

module.exports = { BOX, PRESET, layoutWidgets };
