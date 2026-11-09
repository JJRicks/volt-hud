// Assemble project, After Effects side (ExtendScript, ES3). Called by ae/ext/engine.js.
var VoltAssembleAE = (function () {
  function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function ok() { return '{"ok":true}'; }
  function fail(m) { return '{"ok":false,"error":' + q(m) + '}'; }

  // Only an empty, unsaved project: Assemble never disturbs a project someone has open.
  function begin() {
    try {
      if (app.project && (app.project.file !== null || app.project.numItems > 0)) return fail('After Effects already has a project open. Close it and try again.');
      if (!app.project) app.newProject();
      return ok();
    } catch (e) { return fail(String(e)); }
  }
  function save(path) {
    try {
      var f = new File(path);
      if (f.exists) return fail('a file with that name already exists: ' + path);
      app.project.save(f);
      return f.exists ? ok() : fail('saved, but the file was not found');
    } catch (e) { return fail(String(e)); }
  }
  function waitReply(bt, seconds) {
    var state = { done: false, error: null };
    bt.onResult = function () { state.done = true; };
    bt.onReceived = function () { state.done = true; };
    bt.onError = function (m) { state.done = true; state.error = String(m.body); };
    bt.send(seconds);
    var t0 = new Date().getTime();
    while (!state.done && new Date().getTime() - t0 < seconds * 1000) { BridgeTalk.pump(); $.sleep(200); }
    return state.error ? { error: state.error } : state.done ? {} : { error: 'no reply' };
  }
  function pingPremiere() {
    try {
      var bt = new BridgeTalk();
      bt.target = 'premierepro';
      bt.body = '1+1';
      var r = waitReply(bt, 4);
      return r.error ? fail(r.error) : ok();
    } catch (e) { return fail(String(e)); }
  }
  function sendPremiere(jsxPath, jobPath) {
    try {
      var bt = new BridgeTalk();
      bt.target = 'premierepro';
      bt.body = '$.evalFile(' + q(jsxPath) + '); VoltAssemblePPro.run(' + q(jobPath) + ');';
      var r = waitReply(bt, 20);
      return r.error ? fail(r.error) : ok();
    } catch (e) { return fail(String(e)); }
  }
  return { begin: begin, save: save, pingPremiere: pingPremiere, sendPremiere: sendPremiere };
})();
