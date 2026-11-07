// M0 spike: runs in CEP 12's CEF with --enable-nodejs --mixed-context. Writes one JSON result file
// to <os.tmpdir()>/volt-hud-cep-spike.json; no UI, no host scripting, no prefs.
(function () {
  var r = { when: new Date().toISOString(), href: String(window.location.href) };
  try {
    r.hasRequire = typeof require === 'function';
    var os = require('os'), fs = require('fs'), path = require('path');
    r.node = process.version; r.versions = process.versions; r.arch = process.arch;
    try { r.host = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appVersion; } catch (e) { r.hostErr = String(e); }
    var extDir = path.dirname(decodeURIComponent(window.location.pathname));
    r.extDir = extDir;
    function tryReq(label, id) {
      try {
        var t = Date.now(); var m = require(id);
        r[label] = { ok: true, type: typeof m, ms: Date.now() - t };
        return m;
      } catch (e) { r[label] = { ok: false, err: String(e && e.stack || e).slice(0, 600) }; }
    }
    var gt = tryReq('goproTelemetryBundled', path.join(extDir, 'node_modules', 'gopro-telemetry'));
    tryReq('goproTelemetryBare', 'gopro-telemetry');
    if (gt) { // smoke call: empty input must reject/throw cleanly (proves the module executes, not just loads)
      try {
        var p = gt({ rawData: Buffer.alloc(0), timing: { frameDuration: 1 / 30, start: new Date(0), samples: [] } }, {});
        r.smoke = p && typeof p.then === 'function' ? 'promise' : typeof p;
        if (p && p.then) p.then(function () { r.smokeResult = 'resolved'; write(); }, function (e) { r.smokeResult = 'rejected: ' + String(e).slice(0, 200); write(); });
      } catch (e) { r.smoke = 'threw: ' + String(e).slice(0, 200); }
    }
  } catch (e) { r.error = String(e && e.stack || e); }
  function write() {
    try { require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'volt-hud-cep-spike.json'), JSON.stringify(r, null, 1)); } catch (e) {}
  }
  write();
})();
