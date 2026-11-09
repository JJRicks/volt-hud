'use strict';
// HUD style: defaults, normalization and colour helpers (docs/hud-design.md).

const TOKENS = {
  bg: '#111211', surface: '#1F201E', raised: '#2A2B28', outline: '#3A3B37', text: '#F4F5F0', muted: '#9A9C95',
  dim: '#878982', accent: '#E32B2F', ok: '#5FCB7E', orange: '#E8A23A', danger: '#FF6B6E', blue: '#8FC2FF',
};

const WIDGETS = ['speed', 'power', 'battery', 'vertical', 'gmeter', 'jerk', 'clock', 'stats', 'coords', 'map'];
const DEFAULT_ON = { speed: true, power: true, battery: true, vertical: true, gmeter: true, jerk: true, clock: true, stats: true, coords: true, map: true };
const PRESETS = { '16:9': ['focus', 'corner', 'strip'], '9:16': ['vertical', 'corner', 'strip'] };
const SIZES = { '16:9': [[1920, 1080], [3840, 2160]], '9:16': [[1080, 1920], [2160, 3840]] };

function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex(c) { return '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function mix(a, b, k) { return a.map((x, i) => x + (b[i] - x) * k); }

// Draw gradient for the power bar, derived from the accent the way Volt's red pair relates:
// accentDeep #B81B22 is about 22 % darker than #E32B2F; the top of the bar is a lighter tint.
function accentRamp(accent) {
  const a = hexToRgb(accent) || hexToRgb(TOKENS.accent);
  return { accent: a, deep: mix(a, [0, 0, 0], 0.22), hi: mix(a, [1, 1, 1], 0.22) };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Normalize user/panel style. Unknown fields are ignored; every value gets a safe default.
function normalizeStyle(s) {
  s = s || {};
  const aspect = s.aspect === '9:16' || (Array.isArray(s.comp) && s.comp[1] > s.comp[0]) ? '9:16' : '16:9';
  let preset = String(s.preset || '').toLowerCase();
  if (preset === 'focus' && aspect === '9:16') preset = 'vertical';
  if (preset === 'vertical' && aspect === '16:9') preset = 'focus';
  if (PRESETS[aspect].indexOf(preset) < 0) preset = PRESETS[aspect][0];
  let comp = Array.isArray(s.comp) && s.comp.length === 2 ? s.comp.map(Number) : null;
  if (!comp || !(comp[0] > 0 && comp[1] > 0) || (comp[1] > comp[0]) !== (aspect === '9:16')) comp = SIZES[aspect][s.resolution === '4k' ? 1 : 0].slice();
  const units = s.units === 'imperial' ? 'imperial' : 'metric';
  const vertUnits = ['m/min', 'ft/min', 'grade'];
  const widgets = {};
  const w = s.widgets || {};
  for (const k of WIDGETS) widgets[k] = typeof w[k] === 'boolean' ? w[k] : DEFAULT_ON[k];
  if (s.coords === false) { widgets.coords = false; widgets.map = false; } // the panel's GPS off switch
  return {
    aspect, preset, comp, units,
    vertUnit: vertUnits.indexOf(s.vertUnit) >= 0 ? s.vertUnit : units === 'imperial' ? 'ft/min' : 'm/min',
    gUnit: s.gUnit === 'm/s2' ? 'm/s2' : 'g',
    speedDecimals: s.speedDecimals === 0 || s.speedDecimals === '0' ? 0 : 1, // owner, Nov 7: one decimal by default
    clock24: typeof s.clock24 === 'boolean' ? s.clock24 : units !== 'imperial',
    accent: hexToRgb(s.accent) ? rgbToHex(hexToRgb(s.accent)) : TOKENS.accent,
    plate: clamp(Number.isFinite(+s.plate) && s.plate !== null && s.plate !== '' ? +s.plate : 0.6, 0, 0.7),
    scale: clamp(Number.isFinite(+s.scale) && s.scale ? +s.scale : 1, 0.75, 1.5),
    safe: clamp(Number.isFinite(+s.safe) && s.safe !== null && s.safe !== '' ? +s.safe : 0.05, 0, 0.2),
    coords: s.coords !== false,
    widgets,
    tz: s.tz || null,
    compName: s.compName || null,
  };
}

module.exports = { TOKENS, WIDGETS, DEFAULT_ON, PRESETS, SIZES, hexToRgb, rgbToHex, accentRamp, normalizeStyle, clamp };
