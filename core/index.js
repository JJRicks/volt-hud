'use strict';
// volt-hud shared core (CommonJS; Node 17.7 / CEP 12 and Node 20).
module.exports = {
  mp4: require('./parse/mp4-moov'),
  gopro: require('./parse/gopro'),
  volt: require('./parse/volt'),
  sync: require('./sync/sync'),
  derive: require('./derive/derive'),
  timeline: require('./timeline'),
  report: require('./report'),
  signal: require('./util/signal'),
};
