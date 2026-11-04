'use strict';
// Active Directory over LDAPS (CONTRACT section 14.5). Ported from the ICC dashboard service.
//
// The admin supplies a domain and one account that may read the directory; the rest is worked out:
// domain controllers from DNS SRV, base DN from the domain confirmed by the RootDSE, LDAPS 636 first
// and StartTLS 389 second. Everything that touches the wire goes through createClient() so the tests
// can swap in a fake client. Passwords are never logged.

const dns = require('dns').promises;
const settings = require('./settings');
const time = require('./time');

const TLS_MODES = new Set(['auto', 'ldaps', 'starttls']);
const CONNECT_TIMEOUT_MS = 8000;
const OP_TIMEOUT_MS = 30000;
const PAGE_SIZE = 500;
const SEARCH_LIMIT = 50;
// AD matching rule: transitive membership (nested groups resolved by the domain controller).
const IN_CHAIN = '1.2.840.113556.1.4.1941';
const UAC_ACCOUNTDISABLE = 0x0002;

const log = (m) => console.log(`[directory] ${m}`);

/* ----------------------------------------------------------------------- */
/* Config                                                                  */
/* ----------------------------------------------------------------------- */

function parseServers(raw) {
  return String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function getConfig() {
  const tlsMode = String(settings.get('ad.tls_mode', 'auto') || 'auto');
  const sync = Number(settings.get('ad.sync_minutes', 60)) || 60;
  return {
    enabled: settings.get('ad.enabled', false) === true,
    domain: String(settings.get('ad.domain', '') || '').trim().toLowerCase(),
    bindUser: String(settings.get('ad.bind_user', '') || ''),
    hasPassword: !!settings.getSecret('ad.bind_password'),
    servers: parseServers(settings.get('ad.servers', '')),
    baseDn: String(settings.get('ad.base_dn', '') || ''),
    tlsMode: TLS_MODES.has(tlsMode) ? tlsMode : 'auto',
    tlsVerify: settings.get('ad.tls_verify', true) !== false,
    caCert: String(settings.get('ad.ca_cert', '') || ''),
    syncMinutes: Math.min(1440, Math.max(5, sync)),
    deactivateRemoved: settings.get('ad.deactivate_removed', true) !== false,
  };
}

// Enabled and complete enough to use.
function isReady() {
  const c = getConfig();
  return c.enabled && !!c.domain && !!c.bindUser && c.hasPassword;
}

function isEnabled() {
  return getConfig().enabled;
}

function coded(code, message, attempts) {
  const e = new Error(message);
  e.code = code;
  e.attempts = attempts || [];
  return e;
}

/* ----------------------------------------------------------------------- */
/* Pure helpers                                                            */
/* ----------------------------------------------------------------------- */

function domainToBaseDn(domain) {
  return String(domain || '').trim().toLowerCase().split('.').filter(Boolean).map((p) => `dc=${p}`).join(',');
}

/** "user" | "DOMAIN\user" | "user@domain" -> "user@domain" (the UPN form AD binds accept). */
function toUpn(username, domain) {
  let u = String(username || '').trim();
  if (!u) return '';
  if (/^[a-z]+=[^,]+,/i.test(u)) return u; // a DN binds as it is
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) return u;
  return domain ? `${u}@${domain}` : u;
}

/** The bare account name, for sAMAccountName lookups. */
function toSam(username) {
  let u = String(username || '').trim();
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) u = u.split('@')[0];
  return u;
}

/** Does this login look like it targets the domain (DOMAIN\x or x@domain)? */
function isDomainQualified(username) {
  const u = String(username || '');
  return u.includes('\\') || u.includes('@');
}

function guidToString(buf) {
  if (typeof buf === 'string') return buf || null;
  if (!buf || buf.length !== 16) return null;
  const b = Buffer.from(buf);
  const hex = (i) => b[i].toString(16).padStart(2, '0');
  return [
    hex(3) + hex(2) + hex(1) + hex(0),
    hex(5) + hex(4),
    hex(7) + hex(6),
    hex(8) + hex(9),
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15),
  ].join('-');
}

function sidToString(buf) {
  if (typeof buf === 'string') return /^S-\d/.test(buf) ? buf : null;
  if (!buf || buf.length < 8) return null;
  const b = Buffer.from(buf);
  const revision = b[0];
  const count = b[1];
  const authority = b.readUIntBE(2, 6);
  const parts = [];
  for (let i = 0; i < count && 8 + i * 4 + 4 <= b.length; i++) parts.push(b.readUInt32LE(8 + i * 4));
  return `S-${revision}-${authority}${parts.length ? '-' + parts.join('-') : ''}`;
}

/** Escape a value for use inside an LDAP filter (RFC 4515). */
function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function attr(entry, name) {
  const v = entry && entry[name];
  if (Array.isArray(v)) return v[0] === undefined ? null : v[0];
  return v === undefined ? null : v;
}

/** Split a DN into its RDNs at unescaped commas. */
function splitDn(dn) {
  const out = [];
  let cur = '';
  const s = String(dn || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The OU part of a DN: everything after the first RDN. */
function dnOu(dn) {
  const parts = splitDn(dn);
  return parts.length > 1 ? parts.slice(1).join(',') : '';
}

/** OU names from the root down joined with " / ". */
function ouPath(dn) {
  const names = splitDn(dn)
    .filter((p) => /^ou=/i.test(p.trim()))
    .map((p) => p.trim().slice(3).replace(/\\(.)/g, '$1'));
  return names.reverse().join(' / ');
}

function userAttrs(e) {
  const out = {
    department: attr(e, 'department'),
    company: attr(e, 'company'),
    division: attr(e, 'division'),
    title: attr(e, 'title'),
    office: attr(e, 'physicalDeliveryOfficeName'),
    manager: attr(e, 'manager'),
    employee_id: attr(e, 'employeeID'),
    country: attr(e, 'co'),
  };
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === '') delete out[k]; else out[k] = String(out[k]);
  }
  return out;
}

function entryToUser(e) {
  const uac = Number(attr(e, 'userAccountControl')) || 0;
  const sid = sidToString(attr(e, 'objectSid'));
  const pg = Number(attr(e, 'primaryGroupID')) || null;
  return {
    dn: e.dn,
    sid,
    primaryGroupId: pg,
    // AD keeps the primary group in primaryGroupID, not in member/memberOf, so it has to be
    // resolved by RID against the user's own SID.
    primaryGroupSid: sid && pg ? `${sid.slice(0, sid.lastIndexOf('-'))}-${pg}` : null,
    sam: String(attr(e, 'sAMAccountName') || ''),
    upn: String(attr(e, 'userPrincipalName') || ''),
    displayName: String(attr(e, 'displayName') || attr(e, 'cn') || attr(e, 'sAMAccountName') || ''),
    email: String(attr(e, 'mail') || ''),
    guid: guidToString(attr(e, 'objectGUID')),
    disabled: (uac & UAC_ACCOUNTDISABLE) !== 0,
    ou: dnOu(e.dn),
    attrs: userAttrs(e),
  };
}

function entryToGroup(e) {
  return {
    dn: e.dn,
    name: String(attr(e, 'sAMAccountName') || attr(e, 'cn') || ''),
    description: attr(e, 'description') ? String(attr(e, 'description')) : null,
    guid: guidToString(attr(e, 'objectGUID')),
    sid: sidToString(attr(e, 'objectSid')),
  };
}

/* ----------------------------------------------------------------------- */
/* Errors                                                                  */
/* ----------------------------------------------------------------------- */

function errText(err) {
  return `${err && err.message ? err.message : err} ${err && typeof err.code === 'string' ? err.code : ''}`;
}

function isStrongAuthRequired(err) {
  return (err && err.constructor && err.constructor.name === 'StrongAuthRequiredError') || (err && err.code === 8)
    || /integrity checking|strongerAuthRequired/i.test(String(err && err.message));
}

function isInvalidCredentials(err) {
  const name = (err && err.constructor && err.constructor.name) || '';
  const msg = String((err && err.message) || '');
  return name === 'InvalidCredentialsError' || /invalid credentials|data 52e|data 533|AcceptSecurityContext/i.test(msg) || (err && err.code === 49);
}

/** Turn ldapts and socket errors into something an admin can act on. */
function describeError(err, attempt) {
  const msg = errText(err);
  const a = attempt || {};
  const url = a.url || '';
  if (/ECONNRESET/.test(msg) && url.startsWith('ldaps://')) return 'TLS handshake failed (the domain controller offered no certificate on 636?)';
  if (/ECONNRESET/.test(msg) && a.startTls) return 'StartTLS failed (the domain controller offered no certificate?)';
  if (/Error initializing SSL\/TLS|Code: 0x34|code 52|LDAP error 52/i.test(msg) && a.startTls) return 'StartTLS refused: the domain controller has no server certificate (LDAP error 52)';
  if (/ECONNREFUSED/.test(msg)) return 'connection refused';
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) return 'connection timed out';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'hostname did not resolve';
  if (/self.signed|unable to verify|certificate has expired|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|ERR_TLS_CERT|altnames/i.test(msg)) {
    return 'the TLS certificate was not trusted (add the CA certificate or turn off certificate verification)';
  }
  if (isStrongAuthRequired(err)) return 'DC requires signing/TLS for authenticated binds (LDAP error 8)';
  if (isInvalidCredentials(err)) return 'invalid credentials';
  return String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 160);
}

/* ----------------------------------------------------------------------- */
/* Discovery and connections                                               */
/* ----------------------------------------------------------------------- */

let resolveSrv = (name) => dns.resolveSrv(name);
function setSrvResolver(fn) { resolveSrv = fn || ((name) => dns.resolveSrv(name)); }

// Returns {servers, record}: record is the SRV name that answered.
async function discoverServersDetailed(domain) {
  const names = [`_ldap._tcp.dc._msdcs.${domain}`, `_ldap._tcp.${domain}`];
  for (const name of names) {
    try {
      const recs = await resolveSrv(name);
      if (recs && recs.length) {
        const servers = recs.slice()
          .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
          .map((r) => String(r.name).replace(/\.$/, ''));
        return { servers, record: name };
      }
    } catch (e) { /* try the next record name */ }
  }
  return { servers: [], record: null };
}

async function discoverServers(domain) {
  return (await discoverServersDetailed(domain)).servers;
}

let clientFactory = null;
/** Tests inject fn(url, tlsOptions) returning an object with bind, unbind, startTLS and search. */
function setClientFactory(fn) { clientFactory = fn || null; }

function createClient(url, tlsOptions) {
  if (clientFactory) return clientFactory(url, tlsOptions);
  const { Client } = require('ldapts');
  return new Client({ url, tlsOptions, connectTimeout: CONNECT_TIMEOUT_MS, timeout: OP_TIMEOUT_MS, strictDN: false });
}

function tlsOptionsFor(cfg, host) {
  const opts = { rejectUnauthorized: cfg.tlsVerify, servername: host };
  if (cfg.caCert) opts.ca = cfg.caCert;
  return opts;
}

/** Candidate (url, startTls) attempts in order, honoring the pinned TLS mode. */
function attemptsFor(cfg, host) {
  // An explicit scheme pins the transport for that server: ldaps://host (TLS), starttls://host
  // (StartTLS on 389), ldap://host (plain, lab use only; passwords cross the wire unencrypted).
  const m = /^(ldaps|ldap|starttls):\/\/(.+)$/i.exec(host);
  if (m) {
    const scheme = m[1].toLowerCase();
    const rest = m[2];
    const hp = /:\d+$/.test(rest) ? rest : `${rest}:${scheme === 'ldaps' ? 636 : 389}`;
    const h = hp.split(':')[0];
    if (scheme === 'ldaps') return [{ url: `ldaps://${hp}`, startTls: false, host: h }];
    if (scheme === 'starttls') return [{ url: `ldap://${hp}`, startTls: true, host: h }];
    return [{ url: `ldap://${hp}`, startTls: false, host: h, plain: true }];
  }
  const hasPort = /:\d+$/.test(host);
  const h = host.split(':')[0];
  const out = [];
  if (cfg.tlsMode !== 'starttls') out.push({ url: `ldaps://${hasPort ? host : `${host}:636`}`, startTls: false, host: h });
  if (cfg.tlsMode !== 'ldaps') out.push({ url: `ldap://${hasPort ? host : `${host}:389`}`, startTls: true, host: h });
  return out;
}

/**
 * Open a connection to the first reachable DC and bind. Returns {client, server, url, startTls, plain}.
 * Caller unbinds. Error codes: NO_SERVERS, TLS_REQUIRED, INVALID_CREDENTIALS, UNREACHABLE.
 */
async function connect(cfg, bindDn, bindPassword) {
  const servers = cfg.servers.length ? cfg.servers : await discoverServers(cfg.domain);
  if (!servers.length) {
    throw coded('NO_SERVERS', `No domain controllers found for ${cfg.domain}. Add DNS SRV records or list servers explicitly.`);
  }
  const errors = [];
  for (const server of servers) {
    for (const a of attemptsFor(cfg, server)) {
      // tlsOptions go ONLY on an ldaps:// client: a plain client given them negotiates TLS on 389
      // and the DC resets the socket.
      const client = createClient(a.url, a.url.startsWith('ldaps://') ? tlsOptionsFor(cfg, a.host) : undefined);
      try {
        if (a.startTls) await client.startTLS(tlsOptionsFor(cfg, a.host));
        await client.bind(bindDn, bindPassword);
        return { client, server, url: a.url, startTls: a.startTls, plain: !!a.plain };
      } catch (err) {
        errors.push(`${a.url}: ${describeError(err, a)}`);
        try { await client.unbind(); } catch (e) { /* ignore */ }
        if (isStrongAuthRequired(err)) {
          throw coded('TLS_REQUIRED', `${server} requires LDAP signing: authenticated binds must use LDAPS or StartTLS, and neither could be established (${errors.join(' | ')}). Install a server certificate on the domain controller.`, errors);
        }
        // Wrong credentials are the same on every DC: stop so the account is not locked out.
        if (isInvalidCredentials(err)) {
          const e = coded('INVALID_CREDENTIALS', 'Invalid credentials.', errors);
          const d = /data ([0-9a-f]{3})/i.exec(String(err && err.message));
          e.ldapData = d ? d[1].toLowerCase() : null;
          e.url = a.url;
          e.startTls = a.startTls;
          e.plain = !!a.plain;
          throw e;
        }
      }
    }
  }
  throw coded('UNREACHABLE', `Could not connect to any domain controller: ${errors.join(' | ')}`, errors);
}

async function readDefaultNamingContext(client) {
  try {
    const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext', 'dnsHostName'] });
    return attr(searchEntries && searchEntries[0], 'defaultNamingContext') || null;
  } catch (e) {
    return null;
  }
}

async function searchAll(client, baseDn, filter, attributes) {
  const opts = { scope: 'sub', filter, attributes, paged: { pageSize: PAGE_SIZE }, explicitBufferAttributes: ['objectGUID', 'objectSid'] };
  const { searchEntries } = await client.search(baseDn, opts);
  return searchEntries || [];
}

/** Bind with the service account, run fn(client, ctx), always unbind. */
async function withServiceClient(fn) {
  const cfg = getConfig();
  if (!cfg.domain) throw coded('NOT_CONFIGURED', 'Directory is not configured: the domain is missing.');
  const password = settings.getSecret('ad.bind_password');
  if (!cfg.bindUser || !password) throw coded('NOT_CONFIGURED', 'Directory is not configured: the service account or its password is missing.');
  const conn = await connect(cfg, toUpn(cfg.bindUser, cfg.domain), password);
  try {
    const baseDn = cfg.baseDn || (await readDefaultNamingContext(conn.client)) || domainToBaseDn(cfg.domain);
    return await fn(conn.client, { ...conn, cfg, baseDn });
  } finally {
    try { await conn.client.unbind(); } catch (e) { /* ignore */ }
  }
}

/* ----------------------------------------------------------------------- */
/* Reads                                                                   */
/* ----------------------------------------------------------------------- */

const USER_ATTRS = ['sAMAccountName', 'userPrincipalName', 'displayName', 'cn', 'mail', 'objectGUID', 'objectSid',
  'userAccountControl', 'primaryGroupID', 'distinguishedName', 'department', 'company', 'division', 'title',
  'physicalDeliveryOfficeName', 'manager', 'employeeID', 'co'];
const GROUP_ATTRS = ['sAMAccountName', 'cn', 'description', 'objectGUID', 'objectSid'];
const USERS_FILTER = '(&(objectCategory=person)(objectClass=user))';

/** Group {dn, sid} a user belongs to, transitively, including the primary group and its parents. */
async function getUserGroups(client, baseDn, user) {
  const out = [];
  const seen = new Set();
  const add = (e) => {
    const k = e.dn.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ dn: e.dn, sid: sidToString(attr(e, 'objectSid')) });
  };
  const chain = (dn) => searchAll(client, baseDn, `(&(objectClass=group)(member:${IN_CHAIN}:=${escapeFilter(dn)}))`, ['distinguishedName', 'objectSid']);
  for (const e of await chain(user.dn)) add(e);
  if (user.primaryGroupSid) {
    const pg = await searchAll(client, baseDn, `(&(objectClass=group)(objectSid=${escapeFilter(user.primaryGroupSid)}))`, ['distinguishedName', 'objectSid']);
    for (const g of pg) add(g);
    for (const g of pg) for (const p of await chain(g.dn)) add(p);
  }
  return out;
}

async function findUser(client, baseDn, username, domain) {
  const sam = escapeFilter(toSam(username));
  const upn = escapeFilter(toUpn(username, domain));
  const filter = `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${sam})(userPrincipalName=${upn})))`;
  const entries = await searchAll(client, baseDn, filter, USER_ATTRS);
  return entries[0] ? entryToUser(entries[0]) : null;
}

async function findUserByDn(client, dn) {
  const { searchEntries } = await client.search(dn, { scope: 'base', filter: '(objectClass=user)', attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID', 'objectSid'] });
  return searchEntries && searchEntries[0] ? entryToUser(searchEntries[0]) : null;
}

/** Search for the picker. types: array of 'user' | 'group' | 'ou'. Returns rows with a type field. */
async function search(types, query) {
  const q = escapeFilter(String(query || '').trim());
  const want = new Set(types);
  return withServiceClient(async (client, ctx) => {
    const rows = [];
    if (want.has('user')) {
      const filter = q
        ? `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=*${q}*)(userPrincipalName=*${q}*)(displayName=*${q}*)(cn=*${q}*)))`
        : USERS_FILTER;
      const list = (await searchAll(client, ctx.baseDn, filter, USER_ATTRS)).map(entryToUser)
        .sort((a, b) => a.sam.localeCompare(b.sam)).slice(0, SEARCH_LIMIT);
      for (const u of list) rows.push({ type: 'user', dn: u.dn, sam: u.sam, upn: u.upn, display_name: u.displayName, email: u.email, disabled: u.disabled, ou: u.ou });
    }
    if (want.has('group')) {
      const filter = q ? `(&(objectClass=group)(|(cn=*${q}*)(sAMAccountName=*${q}*)))` : '(objectClass=group)';
      const list = (await searchAll(client, ctx.baseDn, filter, GROUP_ATTRS)).map(entryToGroup)
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, SEARCH_LIMIT);
      for (const g of list) rows.push({ type: 'group', dn: g.dn, name: g.name, sid: g.sid, description: g.description });
    }
    if (want.has('ou')) {
      const filter = q ? `(&(objectClass=organizationalUnit)(ou=*${q}*))` : '(objectClass=organizationalUnit)';
      const list = (await searchAll(client, ctx.baseDn, filter, ['ou', 'distinguishedName'])).map((e) => ({
        dn: e.dn, name: String(attr(e, 'ou') || splitDn(e.dn)[0].replace(/^ou=/i, '')), path: ouPath(e.dn),
      })).sort((a, b) => a.path.localeCompare(b.path)).slice(0, SEARCH_LIMIT);
      for (const o of list) rows.push({ type: 'ou', dn: o.dn, name: o.name, path: o.path });
    }
    return rows;
  });
}

/** Read one user record and its groups with the service account. ref: {dn} or {sam}. Null when absent. */
async function lookupUser(ref) {
  return withServiceClient(async (client, ctx) => {
    const user = ref.dn ? await findUserByDn(client, ref.dn).catch(() => null) : await findUser(client, ctx.baseDn, ref.sam, ctx.cfg.domain);
    if (!user) return null;
    return { user, groups: await getUserGroups(client, ctx.baseDn, user) };
  });
}

/** Re-read many users in one connection (used by the sync). refs: [{key, dn, sam}] -> Map key -> result|null. */
async function lookupUsers(refs) {
  return withServiceClient(async (client, ctx) => {
    const out = new Map();
    for (const r of refs) {
      let user = null;
      if (r.sam) user = await findUser(client, ctx.baseDn, r.sam, ctx.cfg.domain);
      if (!user && r.dn) user = await findUserByDn(client, r.dn).catch(() => null);
      out.set(r.key, user ? { user, groups: await getUserGroups(client, ctx.baseDn, user) } : null);
    }
    return out;
  });
}

/**
 * Verify a domain login. Binds AS THE USER on a fresh connection (the password check), then the
 * service account reads the record and transitive groups.
 * Returns {status: 'ok', user, groups} | {status: 'bad_credentials'} | {status: 'disabled'}.
 * Throws a coded error on outage (UNREACHABLE, TLS_REQUIRED, NO_SERVERS, SERVICE_ACCOUNT).
 */
async function authenticate(username, password) {
  const cfg = getConfig();
  if (!password) return { status: 'bad_credentials' };
  let userConn;
  try {
    userConn = await connect(cfg, toUpn(username, cfg.domain), password);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') {
      // data 533 = the account is disabled and the password was right.
      return err.ldapData === '533' ? { status: 'disabled' } : { status: 'bad_credentials' };
    }
    throw err;
  }
  try { await userConn.client.unbind(); } catch (e) { /* ignore */ }
  try {
    return await withServiceClient(async (client, ctx) => {
      const user = await findUser(client, ctx.baseDn, username, cfg.domain);
      if (!user) return { status: 'bad_credentials' };
      if (user.disabled) return { status: 'disabled' };
      return { status: 'ok', user, groups: await getUserGroups(client, ctx.baseDn, user) };
    });
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') {
      throw coded('SERVICE_ACCOUNT', 'The service account was rejected by the domain controller (Invalid credentials). Check it under Settings > Active Directory.', err.attempts);
    }
    throw err;
  }
}

/* ----------------------------------------------------------------------- */
/* Discovery record and the test checklist                                 */
/* ----------------------------------------------------------------------- */

function storeDiscovered(d) { settings.set('ad.discovered', d); return d; }

function patchStatus(patch) {
  const cur = settings.get('ad.status', null) || {};
  const next = Object.assign({}, cur, patch);
  settings.set('ad.status', next);
  return next;
}

function transportLabel(info) {
  if (info.plain) return 'plain LDAP, passwords cross the wire unencrypted';
  const cfg = getConfig();
  const tls = cfg.tlsVerify ? 'certificate verified' : 'certificate not verified';
  return `${info.startTls ? 'StartTLS on 389' : 'LDAPS on 636'}, ${tls}`;
}

/** Background discovery (servers, base DN, working url). Never throws. Stores ad.discovered. */
async function runDiscovery() {
  const cfg = getConfig();
  const d = { servers: [], base_dn: '', url: '', at: time.nowIso(), error: null };
  try {
    if (!cfg.domain) throw coded('NOT_CONFIGURED', 'The domain is not set.');
    d.servers = cfg.servers.length ? cfg.servers : (await discoverServersDetailed(cfg.domain)).servers;
    d.base_dn = cfg.baseDn || domainToBaseDn(cfg.domain);
    if (!d.servers.length) throw coded('NO_SERVERS', `No domain controllers found for ${cfg.domain}. Add DNS SRV records or list servers explicitly.`);
    if (cfg.bindUser && cfg.hasPassword) {
      await withServiceClient(async (client, ctx) => {
        d.url = ctx.url;
        d.base_dn = ctx.baseDn;
      });
    }
  } catch (err) {
    d.error = err.message;
  }
  return storeDiscovered(d);
}

/** The checklist. Always resolves; a step that fails ends the run and the rest are marked skipped. */
async function testChecklist() {
  const t0 = Date.now();
  const cfg = getConfig();
  const steps = [];
  const names = [['dns', 'Find domain controllers'], ['connect', 'Connect'], ['bind', 'Sign in with the service account'],
    ['base_dn', 'Base DN'], ['users', 'Read users'], ['groups', 'Read groups'], ['ous', 'Read organizational units']];
  const labelOf = Object.fromEntries(names);
  const step = (key, ok, detail) => { steps.push({ key, ok, label: labelOf[key], detail }); return ok; };
  const disc = { servers: [], base_dn: '', url: '', at: time.nowIso(), error: null };
  const finish = () => {
    const done = new Set(steps.map((s) => s.key));
    for (const [key, label] of names) if (!done.has(key)) steps.push({ key, ok: false, label, detail: 'Skipped because an earlier step failed.', skipped: true });
    const result = { ok: steps.every((s) => s.ok), duration_ms: Date.now() - t0, steps };
    storeDiscovered(disc);
    patchStatus({ last_test_at: time.nowIso(), last_test_ok: result.ok, last_test: result });
    return result;
  };
  const fail = (key, err) => { disc.error = err.message; step(key, false, err.message); return finish(); };

  // dns
  if (!cfg.domain) return fail('dns', coded('NOT_CONFIGURED', 'The domain is not set.'));
  let servers = cfg.servers;
  let dnsDetail;
  if (servers.length) {
    dnsDetail = `Using the servers listed in settings: ${servers.join(', ')}`;
  } else {
    const found = await discoverServersDetailed(cfg.domain);
    servers = found.servers;
    if (!servers.length) return fail('dns', coded('NO_SERVERS', `No domain controllers found for ${cfg.domain}. Add DNS SRV records or list servers explicitly.`));
    dnsDetail = `${servers.length} domain controller(s) from ${found.record}: ${servers.join(', ')}`;
  }
  disc.servers = servers;
  step('dns', true, dnsDetail);

  if (!cfg.bindUser) return fail('connect', coded('NOT_CONFIGURED', 'The service account is not set.'));
  const password = settings.getSecret('ad.bind_password');
  if (!password) return fail('connect', coded('NOT_CONFIGURED', 'The service account password is not set.'));

  // connect + bind
  const upn = toUpn(cfg.bindUser, cfg.domain);
  let conn;
  try {
    conn = await connect(cfg, upn, password);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') {
      step('connect', true, `Connected to ${err.url} (${transportLabel(err)})`);
      return fail('bind', err);
    }
    return fail('connect', err);
  }
  try {
    disc.url = conn.url;
    step('connect', true, `Connected to ${conn.url} (${transportLabel(conn)})`);
    step('bind', true, `Bound as ${upn}`);
    const client = conn.client;
    let baseDn = cfg.baseDn;
    let baseDetail;
    const root = await readDefaultNamingContext(client);
    if (cfg.baseDn) baseDetail = `Configured: ${cfg.baseDn}`;
    else if (root) { baseDn = root; baseDetail = `Confirmed by the RootDSE: ${root}`; }
    else { baseDn = domainToBaseDn(cfg.domain); baseDetail = `Derived from the domain: ${baseDn} (the RootDSE did not answer)`; }
    disc.base_dn = baseDn;
    step('base_dn', true, baseDetail);
    // Returns null on success, else the finished (failed) result.
    const count = async (key, filter, noun) => {
      try {
        const n = (await searchAll(client, baseDn, filter, ['distinguishedName'])).length;
        step(key, true, `${n} ${noun} found under ${baseDn}`);
        return null;
      } catch (err) {
        return fail(key, err);
      }
    };
    const bad = (await count('users', USERS_FILTER, 'user(s)'))
      || (await count('groups', '(objectClass=group)', 'group(s)'))
      || (await count('ous', '(objectClass=organizationalUnit)', 'organizational unit(s)'));
    if (bad) return bad;
  } finally {
    try { await conn.client.unbind(); } catch (e) { /* ignore */ }
  }
  return finish();
}

module.exports = {
  getConfig, isReady, isEnabled, runDiscovery, testChecklist, search, lookupUser, lookupUsers, authenticate,
  discoverServers, discoverServersDetailed, patchStatus, connect, attemptsFor, describeError,
  isStrongAuthRequired, isInvalidCredentials,
  domainToBaseDn, toUpn, toSam, isDomainQualified, guidToString, sidToString, escapeFilter, splitDn, dnOu, ouPath,
  setClientFactory, setSrvResolver,
};
