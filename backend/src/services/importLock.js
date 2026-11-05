'use strict';
// One import at a time (Power BI pull or vendor pull). Both importers take this lock so a second
// pull answers 409 whichever kind is already running (CONTRACT section 16.1).
let holder = null;

function tryAcquire(who) {
  if (holder) return false;
  holder = who;
  return true;
}
function release(who) {
  if (!who || holder === who) holder = null;
}
const isBusy = () => holder !== null;
const current = () => holder;

module.exports = { tryAcquire, release, isBusy, current };
