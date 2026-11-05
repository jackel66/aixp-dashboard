'use strict';
// Daily Power BI pull (CONTRACT section 13), built on the shared daily schedule helper.
const { makeSchedule } = require('./dailySchedule');

module.exports = makeSchedule({
  name: 'powerbi',
  enabledKey: 'powerbi.enabled',
  scheduleKey: 'powerbi.schedule',
  lastKey: 'powerbi.last_pull_at',
  isBusy: () => require('./powerbiImport').isRunning(),
  run: () => require('./powerbiImport').pull(),
});
