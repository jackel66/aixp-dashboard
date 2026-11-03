'use strict';
// Daily Power BI pull (CONTRACT section 13). A minute tick without setInterval: each tick
// schedules the next one for the start of the following minute. Phoenix time has no DST (UTC-7).
const settings = require('./settings');
const time = require('./time');

const CATCH_UP_MINUTES = 15; // a pull still starts if the server was down at the exact minute
let timer = null;
let stopped = true;

function phoenixHm(d) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: time.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const [h, m] = f.split(':').map(Number);
  return h * 60 + m;
}

function schedMinutes(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function ranToday(d) {
  const at = settings.get('powerbi.last_pull_at', null);
  return !!at && time.todayPhoenix(new Date(at)) === time.todayPhoenix(d);
}

// ISO time of the next scheduled pull, or null when no schedule is set.
function nextRunAt(d) {
  const sm = schedMinutes(settings.get('powerbi.schedule', ''));
  if (sm === null) return null;
  const now = d || time.now();
  const [y, mo, da] = time.todayPhoenix(now).split('-').map(Number);
  let ms = Date.UTC(y, mo - 1, da, Math.floor(sm / 60) + 7, sm % 60);
  if (ms <= now.getTime() || ranToday(now)) ms = Date.UTC(y, mo - 1, da + 1, Math.floor(sm / 60) + 7, sm % 60);
  return new Date(ms).toISOString();
}

// True when a scheduled pull is due at d.
function due(d) {
  if (!settings.get('powerbi.enabled', false)) return false;
  const sm = schedMinutes(settings.get('powerbi.schedule', ''));
  if (sm === null) return false;
  const diff = phoenixHm(d) - sm;
  if (diff < 0 || diff >= CATCH_UP_MINUTES) return false;
  return !ranToday(d);
}

// One check. Returns the pull promise when a pull started, else null.
function tick(d) {
  const imp = require('./powerbiImport');
  const when = d || time.now();
  if (imp.isRunning() || !due(when)) return null;
  console.log('[powerbi] scheduled pull starting');
  return imp.pull().catch((e) => { console.warn(`[powerbi] scheduled pull failed: ${e.message}`); });
}

function arm() {
  if (stopped) return;
  const wait = 60000 - (Date.now() % 60000) + 50;
  timer = setTimeout(() => {
    try { tick(); } catch (e) { console.warn(`[powerbi] schedule check failed: ${e.message}`); }
    arm();
  }, wait);
  timer.unref();
}

function start() { stopped = false; if (timer) clearTimeout(timer); arm(); }
function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

module.exports = { start, stop, tick, due, nextRunAt };
