'use strict';
// Refreshes every known AD user (groups, OU, attributes, disabled state) through the service account.
// Runs on demand (POST /api/access/directory/sync) and from a minute tick every ad.sync_minutes.
const { getDb } = require('../db');
const settings = require('./settings');
const directory = require('./directory');
const authService = require('./authService');
const { broadcast } = require('./events');

let running = false;
let timer = null;
let stopped = true;

const log = (m) => console.log(`[directory] ${m}`);

async function runSync(opts) {
  const o = opts || {};
  if (running) return { users: 0, updated: 0, deactivated: 0, errors: ['A sync is already running.'] };
  running = true;
  const out = { users: 0, updated: 0, deactivated: 0, errors: [] };
  try {
    const cfg = directory.getConfig();
    const db = getDb();
    const rows = db.prepare("SELECT * FROM users WHERE source = 'ad'").all();
    out.users = rows.length;
    if (!rows.length) return out;
    if (!directory.isReady()) { out.errors.push('Directory is not configured.'); return out; }
    let found;
    try {
      found = await directory.lookupUsers(rows.map((r) => ({ key: r.id, sam: r.username.includes('\\') ? r.username.split('\\').pop() : r.username, dn: r.ad_dn })));
    } catch (err) {
      out.errors.push(err.message);
      log(`sync failed: ${err.code || 'error'}`);
      return out;
    }
    for (const row of rows) {
      const rec = found.get(row.id);
      if (!rec) {
        // Gone from the directory.
        if (cfg.deactivateRemoved && row.active) {
          db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(authService.iso(), row.id);
          authService.dropUserSessions(row.id);
          out.deactivated++;
          authService.logEvent({ kind: 'user_updated', username: row.username, userId: row.id, source: 'ad', detail: 'deactivated: not found in the directory' });
        }
        continue;
      }
      authService.applyAdRecord(row, rec, rec.groups);
      out.updated++;
      if (rec.user.disabled && cfg.deactivateRemoved && row.active) {
        db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(authService.iso(), row.id);
        authService.dropUserSessions(row.id);
        out.deactivated++;
        authService.logEvent({ kind: 'user_updated', username: row.username, userId: row.id, source: 'ad', detail: 'deactivated: disabled in the directory' });
      }
    }
    authService.refreshPersonKeys(db, null);
    return out;
  } finally {
    running = false;
    const at = new Date().toISOString();
    const summary = { users: out.users, updated: out.updated, deactivated: out.deactivated, errors: out.errors.slice(0, 5) };
    try {
      directory.patchStatus({ last_sync_at: at, last_sync: summary });
      authService.logEvent({ kind: 'ad_sync', detail: `${summary.users} user(s), ${summary.updated} updated, ${summary.deactivated} deactivated, ${out.errors.length} error(s)${o.manual ? ' (manual)' : ''}`, actor: o.actor || null });
      broadcast('access.changed', { what: 'directory' });
    } catch (e) { /* the database may be closing */ }
  }
}

function dueNow() {
  if (!directory.isReady()) return false;
  const cfg = directory.getConfig();
  const st = settings.get('ad.status', null) || {};
  const last = st.last_sync_at ? Date.parse(st.last_sync_at) : 0;
  return Date.now() - last >= cfg.syncMinutes * 60000;
}

async function tick() {
  try {
    if (running || !dueNow()) return;
    log('scheduled sync starting');
    await runSync();
  } catch (e) {
    console.warn(`[directory] scheduled sync failed: ${e.message}`);
  }
}

function arm() {
  if (stopped) return;
  timer = setTimeout(() => { tick().finally(arm); }, 60000 - (Date.now() % 60000) + 50);
  timer.unref();
}

function start() { stopped = false; if (timer) clearTimeout(timer); arm(); }
function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

module.exports = { runSync, start, stop, tick, dueNow };
