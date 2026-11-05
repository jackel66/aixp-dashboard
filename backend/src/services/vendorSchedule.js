'use strict';
// Daily vendor pull (CONTRACT section 16.1): the Power BI schedule generalised. Due when any
// connector is enabled and vendors.schedule is set.
const { makeSchedule } = require('./dailySchedule');

module.exports = makeSchedule({
  name: 'vendors',
  enabled: () => require('./connectors').enabledIds().length > 0,
  scheduleKey: 'vendors.schedule',
  lastKey: 'vendors.last_pull_at',
  isBusy: () => require('./importLock').isBusy(),
  run: () => require('./vendorImport').pull(),
});
