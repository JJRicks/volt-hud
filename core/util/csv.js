'use strict';
// Small RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF. Returns rows of strings.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse into objects keyed by the header row.
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const a = rows[r];
    if (a.length === 1 && a[0] === '') continue;
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = a[k] === undefined ? '' : a[k];
    out.push(o);
  }
  return { header, rows: out };
}

function num(s) {
  if (s === undefined || s === null || s === '') return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

module.exports = { parseCsv, parseCsvObjects, num };
