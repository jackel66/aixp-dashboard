'use strict';
// Active Directory: pure helpers, discovery order, every error mapping, the test checklist, search,
// sync, and the login outcomes of CONTRACT 14.3 end to end, all against an in-process fake AD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, startApp } = require('./helpers');

const ctx = setup();
const directory = require('../src/services/directory');
const directorySync = require('../src/services/directorySync');
const authService = require('../src/services/authService');
const settings = require('../src/services/settings');
let app;
let admin;

const BASE = 'DC=corp,DC=example,DC=com';
const DOMAIN_SID = 'S-1-5-21-1-2-3';
const SVC = { upn: 'svc-ldap@corp.example.com', pw: 'svc-secret-pass-1' };
const PW = 'a-long-password-1';

/* ----------------------------- the fake AD ------------------------------ */

class InvalidCredentialsError extends Error {}
class StrongAuthRequiredError extends Error {}

function sockError(code, text) { const e = new Error(`${text || 'socket'} ${code}`); e.code = code; return e; }

let world;
function freshWorld() {
  const u = (sam, cn, ou, extra) => Object.assign({
    sam, cn, dn: `CN=${cn},${ou}`, upn: `${sam}@corp.example.com`, mail: `${sam}@example.com`, pw: `${sam}-Pass-123`, disabled: false,
    guid: `guid-${sam}`, sid: `${DOMAIN_SID}-1100`, pg: 513,
  }, extra);
  const eng = `OU=Engineering,OU=Staff,${BASE}`;
  const w = {
    users: [
      u('jdoe', 'Jane Doe', eng, { sid: `${DOMAIN_SID}-1105`, department: 'Platform', company: 'Example Inc', title: 'Engineer', physicalDeliveryOfficeName: 'Phoenix', employeeID: 'E100', co: 'US', manager: `CN=Boss,OU=Staff,${BASE}`, division: 'Tech' }),
      u('sdis', 'Sam Disabled', eng, { sid: `${DOMAIN_SID}-1106`, disabled: true }),
      u('zed', 'Zed Outside', `OU=XStaff,${BASE}`, { sid: `${DOMAIN_SID}-1107` }),
      u('pwtest', 'Pat Wtest', eng, { sid: `${DOMAIN_SID}-1108` }),
      u('lfirst', 'Lee First', eng, { sid: `${DOMAIN_SID}-1109`, pw: 'AdPass-1234-xy' }),
      u('gone', 'Gina One', eng, { sid: `${DOMAIN_SID}-1110` }),
    ],
    groups: [
      { dn: `CN=Devs,OU=Groups,${BASE}`, sam: 'Devs', sid: `${DOMAIN_SID}-2001`, members: [`CN=Jane Doe,${eng}`, `CN=Lee First,${eng}`, `CN=Gina One,${eng}`] },
      { dn: `CN=Eng-All,OU=Groups,${BASE}`, sam: 'Eng-All', sid: `${DOMAIN_SID}-2002`, members: [`CN=Devs,OU=Groups,${BASE}`] },
      { dn: `CN=Domain Users,CN=Users,${BASE}`, sam: 'Domain Users', sid: `${DOMAIN_SID}-513`, members: [] },
      { dn: `CN=Staff-All,OU=Groups,${BASE}`, sam: 'Staff-All', sid: `${DOMAIN_SID}-2003`, members: [`CN=Domain Users,CN=Users,${BASE}`] },
    ],
    ous: [`OU=Staff,${BASE}`, eng, `OU=XStaff,${BASE}`, `OU=Groups,${BASE}`],
    created: [],
    srv: { 'dc._msdcs': [{ name: 'dc2.corp.example.com.', priority: 20, weight: 10, port: 389 }, { name: 'dc1.corp.example.com.', priority: 10, weight: 10, port: 389 }], plain: [] },
    srvCalls: [],
    requireSigning: false,
    ldapsError: null, startTlsError: null, down: null, svcBroken: false, disabledBindsOk: false,
  };
  return w;
}

function entryOfUser(x) {
  const e = {
    dn: x.dn, sAMAccountName: x.sam, userPrincipalName: x.upn, displayName: x.cn, cn: x.cn, mail: x.mail,
    objectGUID: x.guid, objectSid: x.sid, userAccountControl: x.disabled ? '514' : '512', primaryGroupID: String(x.pg),
  };
  for (const k of ['department', 'company', 'division', 'title', 'physicalDeliveryOfficeName', 'manager', 'employeeID', 'co']) if (x[k]) e[k] = x[k];
  return e;
}
const entryOfGroup = (g) => ({ dn: g.dn, sAMAccountName: g.sam, cn: g.sam, objectSid: g.sid, objectGUID: `guid-${g.sam}`, description: `${g.sam} group` });
const unesc = (s) => s.replace(/\\([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));

function transitiveGroups(w, dn) {
  const out = [];
  const walk = (d) => {
    for (const g of w.groups) if (g.members.some((m) => m.toLowerCase() === d.toLowerCase()) && !out.includes(g)) { out.push(g); walk(g.dn); }
  };
  walk(dn);
  return out;
}

class FakeClient {
  constructor(url, tls) { this.url = url; this.tls = false; this.tlsOpts = tls; this.bound = null; }
  async startTLS() {
    if (world.down) throw world.down(this.url);
    if (world.startTlsError) throw world.startTlsError;
    this.tls = true;
  }
  async bind(dn, pw) {
    if (world.down) throw world.down(this.url);
    if (this.url.startsWith('ldaps://') && world.ldapsError) throw world.ldapsError;
    if (this.url.startsWith('ldap://') && !this.tls && world.requireSigning) {
      const e = new StrongAuthRequiredError('00002028: LDAP: strongerAuthRequired'); e.code = 8; throw e;
    }
    const key = String(dn).toLowerCase();
    if (key === SVC.upn) {
      if (world.svcBroken || pw !== SVC.pw) throw new InvalidCredentialsError('80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563');
      this.bound = 'svc';
      return;
    }
    const x = world.users.find((c) => c.upn.toLowerCase() === key || c.sam === key);
    if (!x || x.pw !== pw) throw new InvalidCredentialsError('80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563');
    if (x.disabled && !world.disabledBindsOk) throw new InvalidCredentialsError('80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 533, v4563');
    this.bound = x.sam;
  }
  async unbind() { /* nothing to close */ }
  async search(base, opts) {
    if (this.bound !== 'svc' && base !== '') throw new Error('search before a service bind');
    const f = String(opts.filter);
    if (base === '') return { searchEntries: [{ dn: '', defaultNamingContext: BASE }] };
    if (opts.scope === 'base') {
      const x = world.users.find((c) => c.dn.toLowerCase() === base.toLowerCase());
      if (/objectClass=user/.test(f)) return { searchEntries: x ? [entryOfUser(x)] : [] };
      return { searchEntries: [] };
    }
    if (f.includes('member:1.2.840.113556.1.4.1941:=')) {
      const dn = unesc(/:=(.*)\)\)$/.exec(f)[1]);
      return { searchEntries: transitiveGroups(world, dn).map(entryOfGroup) };
    }
    if (f.includes('objectSid=')) {
      const sid = /objectSid=([^)]+)\)/.exec(f)[1];
      return { searchEntries: world.groups.filter((g) => g.sid === sid).map(entryOfGroup) };
    }
    if (f.includes('objectClass=organizationalUnit')) {
      const m = /\(ou=\*([^*]*)\*\)/.exec(f);
      const q = m ? m[1].toLowerCase() : '';
      return { searchEntries: world.ous.filter((o) => o.split(',')[0].slice(3).toLowerCase().includes(q)).map((dn) => ({ dn, ou: dn.split(',')[0].slice(3) })) };
    }
    if (f.includes('objectClass=group')) {
      const m = /\(cn=\*([^*]*)\*\)/.exec(f);
      const q = m ? m[1].toLowerCase() : '';
      return { searchEntries: world.groups.filter((g) => g.sam.toLowerCase().includes(q)).map(entryOfGroup) };
    }
    if (f.includes('objectCategory=person')) {
      const pairs = [...f.matchAll(/\((sAMAccountName|userPrincipalName|displayName|cn)=([^)]*)\)/g)].map((p) => [p[1], unesc(p[2])]);
      const field = { sAMAccountName: 'sam', userPrincipalName: 'upn', displayName: 'cn', cn: 'cn' };
      const hit = (x) => pairs.some(([k, v]) => {
        const val = String(x[field[k]]).toLowerCase();
        const q = v.toLowerCase();
        return q.startsWith('*') ? val.includes(q.replace(/\*/g, '')) : val === q;
      });
      return { searchEntries: world.users.filter((x) => !pairs.length || hit(x)).map(entryOfUser) };
    }
    return { searchEntries: [] };
  }
}

function install() {
  world = freshWorld();
  directory.setClientFactory((url, tls) => { world.created.push({ url, tls }); return new FakeClient(url, tls); });
  directory.setSrvResolver(async (name) => {
    world.srvCalls.push(name);
    if (name.startsWith('_ldap._tcp.dc._msdcs.')) return world.srv['dc._msdcs'];
    return world.srv.plain;
  });
  authService.resetLockState();
}

function configure(patch) {
  settings.updateAd(Object.assign({
    'ad.enabled': true, 'ad.domain': 'corp.example.com', 'ad.bind_user': 'CORP\\svc-ldap', 'ad.bind_password': SVC.pw,
    'ad.servers': '', 'ad.base_dn': '', 'ad.tls_mode': 'auto', 'ad.deactivate_removed': true,
  }, patch || {}));
}

const roleId = (n) => ctx.db.getDb().prepare('SELECT id FROM roles WHERE name = ?').get(n).id;
async function assign(roleName, type, dn, sid, name) {
  const r = await admin.call('POST', `/api/access/roles/${roleId(roleName)}/assignments`, { subject_type: type, ad_dn: dn, ad_sid: sid, ad_name: name });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function adLogin(username, password) {
  const r = await app.call('POST', '/api/auth/login', { username, password });
  return r;
}
const adUser = (sam) => ctx.db.getDb().prepare("SELECT * FROM users WHERE source = 'ad' AND username = ?").get(sam);

test.before(async () => {
  install();
  app = await startApp();
  admin = await app.admin();
});
test.after(async () => {
  directory.setClientFactory(null);
  directory.setSrvResolver(null);
  if (app) await app.close();
  teardown(ctx);
});

/* --------------------------- pure helpers ------------------------------- */

test('UPN forms, sam names, domain qualification and base DN', () => {
  assert.equal(directory.toUpn('jdoe', 'corp.example.com'), 'jdoe@corp.example.com');
  assert.equal(directory.toUpn('CORP\\jdoe', 'corp.example.com'), 'jdoe@corp.example.com');
  assert.equal(directory.toUpn('jdoe@other.test', 'corp.example.com'), 'jdoe@other.test');
  assert.equal(directory.toUpn('CN=svc,OU=x,DC=a', 'corp.example.com'), 'CN=svc,OU=x,DC=a');
  assert.equal(directory.toUpn('', 'corp.example.com'), '');
  assert.equal(directory.toSam('CORP\\jdoe'), 'jdoe');
  assert.equal(directory.toSam('jdoe@corp.example.com'), 'jdoe');
  assert.equal(directory.isDomainQualified('jdoe'), false);
  assert.equal(directory.isDomainQualified('CORP\\jdoe'), true);
  assert.equal(directory.isDomainQualified('jdoe@corp.example.com'), true);
  assert.equal(directory.domainToBaseDn('Corp.Example.com'), 'dc=corp,dc=example,dc=com');
});

test('guid and sid decoding, filter escaping, OU of a DN and OU path', () => {
  const guid = Buffer.from('33221100554477668899aabbccddeeff', 'hex');
  assert.equal(directory.guidToString(guid), '00112233-4455-6677-8899-aabbccddeeff');
  const sid = Buffer.from([1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0x51, 0x04, 0, 0]);
  assert.equal(directory.sidToString(sid), 'S-1-5-21-1-2-3-1105');
  assert.equal(directory.sidToString('S-1-5-21-9'), 'S-1-5-21-9');
  assert.equal(directory.escapeFilter('a*(b)\\c'), 'a\\2a\\28b\\29\\5cc');
  assert.equal(directory.dnOu(`CN=Jane Doe,OU=Engineering,OU=Staff,${BASE}`), `OU=Engineering,OU=Staff,${BASE}`);
  assert.equal(directory.dnOu('CN=Doe\\, Jane,OU=Eng,DC=x'), 'OU=Eng,DC=x');
  assert.equal(directory.ouPath(`OU=Engineering,OU=Staff,${BASE}`), 'Staff / Engineering');
  assert.equal(directory.ouPath('OU=Sales\\, East,DC=x'), 'Sales, East');
});

test('attemptsFor: LDAPS then StartTLS, pinned modes, pinned schemes, explicit ports', () => {
  const cfg = (tlsMode) => ({ tlsMode });
  assert.deepEqual(directory.attemptsFor(cfg('auto'), 'dc1.x').map((a) => [a.url, a.startTls]), [['ldaps://dc1.x:636', false], ['ldap://dc1.x:389', true]]);
  assert.deepEqual(directory.attemptsFor(cfg('ldaps'), 'dc1.x').map((a) => a.url), ['ldaps://dc1.x:636']);
  assert.deepEqual(directory.attemptsFor(cfg('starttls'), 'dc1.x').map((a) => [a.url, a.startTls]), [['ldap://dc1.x:389', true]]);
  assert.deepEqual(directory.attemptsFor(cfg('auto'), 'dc1.x:3269').map((a) => a.url), ['ldaps://dc1.x:3269', 'ldap://dc1.x:3269']);
  assert.deepEqual(directory.attemptsFor(cfg('auto'), 'ldaps://dc1.x').map((a) => a.url), ['ldaps://dc1.x:636']);
  assert.deepEqual(directory.attemptsFor(cfg('auto'), 'starttls://dc1.x').map((a) => [a.url, a.startTls]), [['ldap://dc1.x:389', true]]);
  const plain = directory.attemptsFor(cfg('auto'), 'ldap://dc1.x');
  assert.deepEqual(plain.map((a) => [a.url, a.startTls, a.plain]), [['ldap://dc1.x:389', false, true]]);
});

/* ------------------------ discovery and checklist ----------------------- */

test('saving the connection runs discovery in the background (SRV order, sorted by priority then weight)', async () => {
  const put = await admin.call('PUT', '/api/access/directory', { patch: {
    'ad.enabled': true, 'ad.domain': 'Corp.Example.com', 'ad.bind_user': 'CORP\\svc-ldap', 'ad.bind_password': SVC.pw,
  } });
  assert.equal(put.status, 200);
  assert.equal(put.json.config['ad.domain'], 'corp.example.com');
  assert.deepEqual(put.json.config['ad.bind_password'], { set: true });
  assert.equal(JSON.stringify(put.json).includes(SVC.pw), false);
  let d;
  for (let i = 0; i < 50; i++) {
    d = (await admin.call('GET', '/api/access/directory')).json.discovered;
    if (d && d.at && d.url) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.deepEqual(d.servers, ['dc1.corp.example.com', 'dc2.corp.example.com']);
  assert.equal(d.url, 'ldaps://dc1.corp.example.com:636');
  assert.equal(d.base_dn, BASE);
  assert.equal(d.error, null);
  assert.equal(world.srvCalls[0], '_ldap._tcp.dc._msdcs.corp.example.com');
  const raw = ctx.db.getDb().prepare("SELECT value FROM settings WHERE key = 'ad.bind_password'").get().value;
  assert.match(JSON.parse(raw), /^enc:v1:/, 'bind password is encrypted at rest');
  const ev = (await admin.call('GET', '/api/access/events?kind=ad_config')).json.rows[0];
  assert.doesNotMatch(ev.detail, new RegExp(SVC.pw));
  assert.match(ev.detail, /ad\.bind_password/);
});

test('the SRV fallback record is used when the _msdcs one is empty; ad.servers skips DNS entirely', async () => {
  world.srv['dc._msdcs'] = [];
  world.srv.plain = [{ name: 'dcx.corp.example.com', priority: 1, weight: 1, port: 389 }];
  world.srvCalls = [];
  const found = await directory.discoverServersDetailed('corp.example.com');
  assert.deepEqual(found.servers, ['dcx.corp.example.com']);
  assert.equal(found.record, '_ldap._tcp.corp.example.com');
  assert.deepEqual(world.srvCalls, ['_ldap._tcp.dc._msdcs.corp.example.com', '_ldap._tcp.corp.example.com']);
  world.srvCalls = [];
  configure({ 'ad.servers': 'ldaps://dcy.corp.example.com, dcz.corp.example.com' });
  const t = await directory.testChecklist();
  assert.equal(t.ok, true);
  assert.deepEqual(world.srvCalls, []);
  assert.match(t.steps[0].detail, /Using the servers listed in settings: ldaps:\/\/dcy/);
  install();
  configure();
});

test('checklist: dns, connect, bind, base_dn, users, groups, ous all pass and are stored', async () => {
  const r = await admin.call('POST', '/api/access/directory/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.steps.map((s) => s.key), ['dns', 'connect', 'bind', 'base_dn', 'users', 'groups', 'ous']);
  assert.ok(r.json.steps.every((s) => s.ok && s.label && s.detail));
  assert.ok(typeof r.json.duration_ms === 'number');
  assert.match(r.json.steps[0].detail, /2 domain controller\(s\) from _ldap\._tcp\.dc\._msdcs\.corp\.example\.com: dc1\.corp\.example\.com, dc2/);
  assert.match(r.json.steps[1].detail, /ldaps:\/\/dc1\.corp\.example\.com:636 \(LDAPS on 636, certificate verified\)/);
  assert.equal(r.json.steps[2].detail, 'Bound as svc-ldap@corp.example.com');
  assert.match(r.json.steps[3].detail, /Confirmed by the RootDSE: DC=corp,DC=example,DC=com/);
  assert.match(r.json.steps[4].detail, /^6 user\(s\)/);
  assert.match(r.json.steps[5].detail, /^4 group\(s\)/);
  assert.match(r.json.steps[6].detail, /^4 organizational unit\(s\)/);
  const d = (await admin.call('GET', '/api/access/directory')).json;
  assert.equal(d.status.last_test_ok, true);
  assert.ok(d.status.last_test_at);
  assert.equal(d.status.last_test.steps.length, 7);
});

test('plain ldap:// is labelled and gets no tlsOptions; TLS options go only on ldaps clients', async () => {
  world.created = [];
  configure({ 'ad.servers': 'ldap://dc1.corp.example.com' });
  const t = await directory.testChecklist();
  assert.equal(t.ok, true);
  assert.match(t.steps[1].detail, /plain LDAP, passwords cross the wire unencrypted/);
  assert.ok(world.created.length >= 1);
  assert.ok(world.created.every((c) => c.tls === undefined), 'plain client got tlsOptions');
  world.created = [];
  configure({ 'ad.servers': '', 'ad.tls_verify': false, 'ad.ca_cert': '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' });
  await directory.testChecklist();
  const ldaps = world.created.find((c) => c.url.startsWith('ldaps://'));
  assert.equal(ldaps.tls.rejectUnauthorized, false);
  assert.equal(ldaps.tls.servername, 'dc1.corp.example.com');
  assert.match(ldaps.tls.ca, /BEGIN CERTIFICATE/);
  configure({ 'ad.tls_verify': true, 'ad.ca_cert': '' });
});

test('LDAPS falls back to StartTLS on 389 when 636 resets', async () => {
  world.ldapsError = sockError('ECONNRESET', 'read');
  world.created = [];
  const conn = await directory.connect(directory.getConfig(), SVC.upn, SVC.pw);
  assert.equal(conn.url, 'ldap://dc1.corp.example.com:389');
  assert.equal(conn.startTls, true);
  assert.deepEqual(world.created.map((c) => c.url), ['ldaps://dc1.corp.example.com:636', 'ldap://dc1.corp.example.com:389']);
  world.ldapsError = null;
});

async function connectError(cfgPatch) {
  const cfg = Object.assign(directory.getConfig(), cfgPatch || {});
  try { await directory.connect(cfg, SVC.upn, SVC.pw); } catch (e) { return e; }
  throw new Error('connect should have failed');
}

test('error mapping: no domain controllers (NO_SERVERS)', async () => {
  world.srv['dc._msdcs'] = [];
  world.srv.plain = [];
  const e = await connectError();
  assert.equal(e.code, 'NO_SERVERS');
  assert.equal(e.message, 'No domain controllers found for corp.example.com. Add DNS SRV records or list servers explicitly.');
  const t = await directory.testChecklist();
  assert.equal(t.ok, false);
  assert.equal(t.steps[0].key, 'dns');
  assert.equal(t.steps[0].ok, false);
  assert.equal(t.steps[0].detail, e.message);
  assert.ok(t.steps.slice(1).every((s) => s.skipped && !s.ok));
  assert.equal(t.steps.length, 7);
  install();
});

test('error mapping: LDAP signing required (error 8) on both transports stops with TLS_REQUIRED', async () => {
  world.requireSigning = true;
  world.ldapsError = (() => { const e = new StrongAuthRequiredError('strongerAuthRequired'); e.code = 8; return e; })();
  world.startTlsError = sockError('ECONNRESET');
  const e = await connectError();
  assert.equal(e.code, 'TLS_REQUIRED');
  assert.match(e.message, /^dc1\.corp\.example\.com requires LDAP signing: authenticated binds must use LDAPS or StartTLS, and neither could be established \(/);
  assert.match(e.message, /Install a server certificate on the domain controller\.$/);
  assert.equal(e.attempts.length, 1);
  install();
});

test('error mapping: invalid credentials stop at the first DC (the account is not locked out)', async () => {
  world.created = [];
  const e = await directory.connect(directory.getConfig(), SVC.upn, 'wrong').then(() => null, (x) => x);
  assert.equal(e.code, 'INVALID_CREDENTIALS');
  assert.equal(e.message, 'Invalid credentials.');
  assert.equal(world.created.length, 1, 'only one DC and one transport were tried');
  configure({ 'ad.bind_password': 'wrong' });
  const t = await directory.testChecklist();
  assert.equal(t.ok, false);
  assert.equal(t.steps.find((s) => s.key === 'connect').ok, true);
  const bind = t.steps.find((s) => s.key === 'bind');
  assert.equal(bind.ok, false);
  assert.equal(bind.detail, 'Invalid credentials.');
  configure({ 'ad.bind_password': SVC.pw });
});

test('error mapping: TLS handshake, StartTLS refused, refused, timeout, no resolve', async () => {
  const cases = [
    [{ ldapsError: sockError('ECONNRESET', 'read'), startTlsError: sockError('ECONNRESET', 'read') },
      ['TLS handshake failed (the domain controller offered no certificate on 636?)', 'StartTLS failed (the domain controller offered no certificate?)']],
    [{ ldapsError: sockError('ECONNRESET', 'read'), startTlsError: new Error('Error initializing SSL/TLS, Code: 0x34') },
      ['TLS handshake failed (the domain controller offered no certificate on 636?)', 'StartTLS refused: the domain controller has no server certificate (LDAP error 52)']],
    [{ down: () => sockError('ECONNREFUSED', 'connect') }, ['connection refused']],
    [{ down: () => sockError('ETIMEDOUT', 'connect') }, ['connection timed out']],
    [{ down: () => sockError('ENOTFOUND', 'getaddrinfo') }, ['hostname did not resolve']],
  ];
  for (const [patch, expected] of cases) {
    install();
    Object.assign(world, patch);
    const e = await connectError();
    assert.equal(e.code, 'UNREACHABLE');
    assert.match(e.message, /^Could not connect to any domain controller: /);
    for (const text of expected) assert.ok(e.message.includes(text), `${text} in ${e.message}`);
    assert.equal(e.attempts.length, 4, 'two servers times two transports');
  }
  install();
});

test('the checklist never throws on missing configuration', async () => {
  settings.updateAd({ 'ad.domain': '', 'ad.bind_user': '' });
  let t = await directory.testChecklist();
  assert.equal(t.steps[0].ok, false);
  assert.match(t.steps[0].detail, /domain is not set/);
  configure({ 'ad.bind_user': '' });
  t = await directory.testChecklist();
  assert.equal(t.steps.find((s) => s.key === 'connect').ok, false);
  assert.match(t.steps.find((s) => s.key === 'connect').detail, /service account is not set/);
  configure({ 'ad.bind_password': null });
  settings.updateAd({ 'ad.bind_user': 'CORP\\svc-ldap' });
  t = await directory.testChecklist();
  assert.match(t.steps.find((s) => s.key === 'connect').detail, /password is not set/);
  configure();
});

/* ------------------------------ search ---------------------------------- */

test('search: users, groups and OUs with the documented shapes; failures map to 503', async () => {
  const u = await admin.call('GET', '/api/access/directory/search?type=user&q=doe');
  assert.equal(u.status, 200);
  assert.equal(u.json.rows.length, 1);
  assert.deepEqual(u.json.rows[0], {
    type: 'user', dn: `CN=Jane Doe,OU=Engineering,OU=Staff,${BASE}`, sam: 'jdoe', upn: 'jdoe@corp.example.com', display_name: 'Jane Doe',
    email: 'jdoe@example.com', disabled: false, ou: `OU=Engineering,OU=Staff,${BASE}`,
  });
  const dis = await admin.call('GET', '/api/access/directory/search?type=user&q=sdis');
  assert.equal(dis.json.rows[0].disabled, true);
  const g = await admin.call('GET', '/api/access/directory/search?type=group&q=dev');
  assert.deepEqual(g.json.rows, [{ type: 'group', dn: `CN=Devs,OU=Groups,${BASE}`, name: 'Devs', sid: `${DOMAIN_SID}-2001`, description: 'Devs group' }]);
  const o = await admin.call('GET', '/api/access/directory/search?type=ou&q=eng');
  assert.deepEqual(o.json.rows, [{ type: 'ou', dn: `OU=Engineering,OU=Staff,${BASE}`, name: 'Engineering', path: 'Staff / Engineering' }]);
  const all = await admin.call('GET', '/api/access/directory/search?type=user,group,ou&q=staff');
  assert.deepEqual([...new Set(all.json.rows.map((r) => r.type))].sort(), ['group', 'ou']);
  assert.equal((await admin.call('GET', '/api/access/directory/search?type=printer')).status, 400);
  world.down = () => sockError('ECONNREFUSED', 'connect');
  const down = await admin.call('GET', '/api/access/directory/search?type=user&q=a');
  assert.equal(down.status, 503);
  assert.equal(down.json.code, 'ad_unreachable');
  assert.match(down.json.error, /^Could not connect to any domain controller: .*connection refused/);
  assert.ok(Array.isArray(down.json.detail) && down.json.detail.length === 4);
  world.down = null;
});

/* ------------------------------ sign-in --------------------------------- */

test('AD sign-in: a valid domain user with no role reaches no_role and is remembered', async () => {
  const r = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, {
    error: 'Your domain account signed in but no AIxP role is assigned to you, your groups or your organizational unit. Ask an administrator.',
    code: 'no_role',
  });
  const row = adUser('jdoe');
  assert.ok(row, 'the AD user row was created at first sign-in');
  assert.equal(row.source, 'ad');
  assert.equal(row.password_hash, null);
  assert.equal(row.ad_dn, `CN=Jane Doe,OU=Engineering,OU=Staff,${BASE}`);
  assert.equal(row.ad_upn, 'jdoe@corp.example.com');
  assert.equal(row.ad_guid, 'guid-jdoe');
  assert.equal(row.ad_sid, `${DOMAIN_SID}-1105`);
  assert.equal(row.ad_ou, `OU=Engineering,OU=Staff,${BASE}`);
  assert.equal(row.display_name, 'Jane Doe');
  assert.equal(row.email, 'jdoe@example.com');
  assert.deepEqual(JSON.parse(row.ad_attrs_json), {
    department: 'Platform', company: 'Example Inc', division: 'Tech', title: 'Engineer', office: 'Phoenix',
    manager: `CN=Boss,OU=Staff,${BASE}`, employee_id: 'E100', country: 'US',
  });
  const groups = JSON.parse(row.ad_groups_json);
  for (const want of [`CN=Devs,OU=Groups,${BASE}`, `CN=Eng-All,OU=Groups,${BASE}`, `CN=Domain Users,CN=Users,${BASE}`, `CN=Staff-All,OU=Groups,${BASE}`, `${DOMAIN_SID}-2001`, `${DOMAIN_SID}-513`]) {
    assert.ok(groups.includes(want), `groups include ${want}`);
  }
});

test('AD sign-in: a role assigned to a group DN, then a nested group, then the primary group, then an OU', async () => {
  const users = (await admin.call('GET', '/api/access/users')).json.rows;
  assert.equal(users.find((x) => x.username === 'jdoe').roles.length, 0);

  // direct group
  const a1 = await assign('Viewer', 'ad_group', `CN=Devs,OU=Groups,${BASE}`, `${DOMAIN_SID}-2001`, 'Devs');
  let ok = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.permissions, ['dashboard.view']);
  assert.equal(ok.json.user.username, 'jdoe');
  assert.equal(ok.json.user.source, 'ad');
  assert.equal(ok.json.user.ad_ou, `OU=Engineering,OU=Staff,${BASE}`);
  assert.equal(ok.json.user.ad_attrs.department, 'Platform');
  assert.match(ok.headers.get('set-cookie'), /^aixp_session=/);
  await admin.call('DELETE', `/api/access/roles/${roleId('Viewer')}/assignments/${a1.id}`);
  assert.equal((await adLogin('jdoe', 'jdoe-Pass-123')).status, 403);

  // nested group (user is in Devs, Devs is in Eng-All)
  const a2 = await assign('Analyst', 'ad_group', `CN=Eng-All,OU=Groups,${BASE}`, null, 'Eng-All');
  ok = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.roles.map((r) => r.name), ['Analyst']);
  await admin.call('DELETE', `/api/access/roles/${roleId('Analyst')}/assignments/${a2.id}`);

  // group matched by SID only, and the primary group (Domain Users, RID 513) reached by RID
  const a3 = await assign('Viewer', 'ad_group', `CN=Other,OU=Groups,${BASE}`, `${DOMAIN_SID}-513`, 'Domain Users');
  ok = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(ok.status, 200, 'primary group matched by SID');
  await admin.call('DELETE', `/api/access/roles/${roleId('Viewer')}/assignments/${a3.id}`);

  // a parent of the primary group (Staff-All contains Domain Users)
  const a4 = await assign('Executive', 'ad_group', `CN=Staff-All,OU=Groups,${BASE}`, null, 'Staff-All');
  ok = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(ok.status, 200, 'parent of the primary group');
  assert.deepEqual(ok.json.permissions, ['dashboard.view', 'export.csv']);
  await admin.call('DELETE', `/api/access/roles/${roleId('Executive')}/assignments/${a4.id}`);

  // OU suffix, with a comma boundary: OU=Staff matches Engineering under Staff, not XStaff
  const a5 = await assign('Viewer', 'ad_ou', `OU=Staff,${BASE}`, null, 'Staff');
  ok = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(ok.status, 200, 'OU suffix match');
  const zed = await adLogin('zed', 'zed-Pass-123');
  assert.equal(zed.status, 403, 'XStaff must not match OU=Staff');
  assert.equal(zed.json.code, 'no_role');
  const list = (await admin.call('GET', '/api/access/users')).json.rows.find((x) => x.username === 'jdoe');
  assert.deepEqual(list.roles, [{ id: roleId('Viewer'), name: 'Viewer', via: 'ou:Staff' }]);
  await admin.call('DELETE', `/api/access/roles/${roleId('Viewer')}/assignments/${a5.id}`);
});

test('AD sign-in: DOMAIN\\name and name@domain reach the same user row', async () => {
  const a = await assign('Viewer', 'ad_ou', `OU=Staff,${BASE}`, null, 'Staff');
  const before = ctx.db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE source = 'ad'").get().n;
  for (const name of ['CORP\\jdoe', 'jdoe@corp.example.com', 'JDOE', ' Jdoe ']) {
    const r = await adLogin(name, 'jdoe-Pass-123');
    assert.equal(r.status, 200, name);
    assert.equal(r.json.user.username, 'jdoe');
  }
  assert.equal(ctx.db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE source = 'ad'").get().n, before);
  const ev = (await admin.call('GET', '/api/access/events?kind=login_ok&limit=5')).json.rows;
  assert.ok(ev.some((e) => e.source === 'ad' && e.username === 'jdoe'));
  void a;
});

test('AD sign-in: wrong password is 401 bad_credentials; three failures pause that name for 10 minutes', async () => {
  const bad = await adLogin('pwtest', 'nope');
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: 'Wrong username or password', code: 'bad_credentials' });
  assert.equal((await adLogin('pwtest', 'nope')).status, 401);
  assert.equal((await adLogin('pwtest', 'nope')).status, 401);
  world.created = [];
  const paused = await adLogin('pwtest', 'pwtest-Pass-123');
  assert.equal(paused.status, 423);
  assert.equal(paused.json.code, 'locked');
  assert.match(paused.json.error, /^Too many failed sign-ins\. Try again in \d+ minutes\.$/);
  assert.equal(world.created.length, 0, 'no bind attempt reaches the domain while paused');
  assert.equal((await adLogin('jdoe', 'jdoe-Pass-123')).status, 200, 'other names are unaffected');
  authService.resetLockState();
  assert.equal((await adLogin('pwtest', 'pwtest-Pass-123')).status, 200, 'unpaused: the Staff OU assignment from the earlier test reaches pwtest');
});

test('AD sign-in: a disabled domain account is ad_disabled (bind error 533, or disabled flag after a bind)', async () => {
  const r = await adLogin('sdis', 'sdis-Pass-123');
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'This domain account is disabled.', code: 'ad_disabled' });
  world.disabledBindsOk = true;
  const r2 = await adLogin('sdis', 'sdis-Pass-123');
  assert.equal(r2.status, 401);
  assert.equal(r2.json.code, 'ad_disabled');
  world.disabledBindsOk = false;
  assert.equal((await adLogin('sdis', 'wrong')).json.code, 'bad_credentials');
});

test('sign-in order: an active local user wins a bare name; DOMAIN\\name reaches the domain', async () => {
  const mk = await admin.call('POST', '/api/access/users', { username: 'lfirst', password: PW, role_ids: [roleId('Viewer')] });
  assert.equal(mk.status, 201);
  await assign('Viewer', 'ad_group', `CN=Devs,OU=Groups,${BASE}`, null, 'Devs');
  const bare = await adLogin('lfirst', 'AdPass-1234-xy');
  assert.equal(bare.status, 401, 'the bare name is local first; the domain password does not work there');
  assert.equal((await adLogin('lfirst', PW)).status, 200);
  const qualified = await adLogin('CORP\\lfirst', 'AdPass-1234-xy');
  assert.equal(qualified.status, 200);
  assert.equal(qualified.json.user.source, 'ad');
  assert.equal(qualified.json.user.username, 'corp\\lfirst', 'username is made unique beside the local lfirst');
  // a disabled local user lets the bare name fall through to the domain
  const local = ctx.db.getDb().prepare("SELECT id FROM users WHERE username = 'lfirst' AND source = 'local'").get();
  await admin.call('PUT', `/api/access/users/${local.id}`, { active: false });
  const fall = await adLogin('lfirst', 'AdPass-1234-xy');
  assert.equal(fall.status, 200);
  assert.equal(fall.json.user.source, 'ad');
});

test('domain outage: sign-in answers 503 ad_unreachable with attempt lines while local sign-in keeps working', async () => {
  world.down = () => sockError('ECONNREFUSED', 'connect');
  const r = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'ad_unreachable');
  assert.match(r.json.error, /^Could not connect to any domain controller: /);
  assert.equal(r.json.detail.length, 4);
  assert.match(r.json.detail[0], /^ldaps:\/\/dc1\.corp\.example\.com:636: connection refused$/);
  assert.equal((await adLogin('admin', 'M0nkside')).status, 200, 'local sign-in is unaffected');
  world.down = null;
  // outage does not count against the name
  assert.equal((await adLogin('jdoe', 'jdoe-Pass-123')).status, 200);
});

test('service account rejected while the user password is fine: 503 naming the service account', async () => {
  world.svcBroken = true;
  const r = await adLogin('jdoe', 'jdoe-Pass-123');
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'ad_unreachable');
  assert.match(r.json.error, /service account was rejected/);
  world.svcBroken = false;
});

test('audit rows for domain sign-ins never hold a password', () => {
  const rows = ctx.db.getDb().prepare('SELECT detail FROM auth_events').all().map((r) => r.detail || '');
  for (const d of rows) assert.doesNotMatch(d, /jdoe-Pass-123|svc-secret-pass|AdPass-1234|nope/);
});

/* ------------------------- pre-provision and sync ------------------------ */

test('pre-provisioning: add a domain user by DN, no password, then it signs in on first use', async () => {
  const dn = `CN=Gina One,OU=Engineering,OU=Staff,${BASE}`;
  const r = await admin.call('POST', '/api/access/users/ad', { dn });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.username, 'gone');
  assert.equal(r.json.source, 'ad');
  assert.equal(r.json.ad_ou, `OU=Engineering,OU=Staff,${BASE}`);
  assert.equal((await admin.call('POST', '/api/access/users/ad', { dn })).status, 409);
  assert.equal((await admin.call('POST', '/api/access/users/ad', { dn: `CN=Nobody,${BASE}` })).status, 404);
  assert.equal((await admin.call('POST', '/api/access/users/ad', {})).status, 400);
  assert.equal((await admin.call('PUT', `/api/access/users/${r.json.id}/password`, { password: 'whatever-long-1' })).status, 400);
  const before = ctx.db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'gone'").get().n;
  const login = await adLogin('gone', 'gone-Pass-123');
  assert.equal(login.status, 200, 'the Devs group assignment reaches the pre-provisioned user');
  assert.equal(ctx.db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'gone'").get().n, before, 'matched, not duplicated');
  const cp = await app.login('gone', 'gone-Pass-123').catch((e) => e);
  assert.ok(cp.call, 'cookie client works');
  const self = await cp.call('POST', '/api/auth/change-password', { current_password: 'x', new_password: 'another-long-pw-2' });
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'Domain passwords are changed in Active Directory, not here.');
});

test('sync refreshes groups, OU and attributes, deactivates disabled and removed users, and drops sessions', async () => {
  const live = await app.login('jdoe', 'jdoe-Pass-123');
  assert.equal((await live.call('GET', '/api/datasets')).status, 200);
  // move Jane, change her department, remove Devs from her groups; disable Gina; delete Lee
  const jane = world.users.find((x) => x.sam === 'jdoe');
  jane.dn = `CN=Jane Doe,OU=Sales,OU=Staff,${BASE}`;
  jane.department = 'Revenue';
  world.groups.find((g) => g.sam === 'Devs').members = world.groups.find((g) => g.sam === 'Devs').members.filter((m) => !m.includes('Jane Doe'));
  world.ous.push(`OU=Sales,OU=Staff,${BASE}`);
  world.users.find((x) => x.sam === 'gone').disabled = true;
  world.users = world.users.filter((x) => x.sam !== 'lfirst');
  const r = await admin.call('POST', '/api/access/directory/sync', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.errors.length, 0);
  assert.ok(r.json.users >= 3);
  assert.ok(r.json.updated >= 2);
  assert.equal(r.json.deactivated, 2, 'gone (disabled) and lfirst (removed)');
  const row = adUser('jdoe');
  assert.equal(row.ad_ou, `OU=Sales,OU=Staff,${BASE}`);
  assert.equal(JSON.parse(row.ad_attrs_json).department, 'Revenue');
  assert.equal(JSON.parse(row.ad_groups_json).includes(`CN=Devs,OU=Groups,${BASE}`), false);
  assert.equal(adUser('gone').active, 0);
  assert.equal(ctx.db.getDb().prepare("SELECT active FROM users WHERE username = 'corp\\lfirst'").get().active, 0);
  const d = (await admin.call('GET', '/api/access/directory')).json;
  assert.ok(d.status.last_sync_at);
  assert.equal(d.status.last_sync.deactivated, 2);
  assert.ok(d.user_count >= 3);
  // Jane still reaches Viewer through the OU assignment; the live session keeps working
  assert.equal((await live.call('GET', '/api/datasets')).status, 200);
  assert.equal((await adLogin('gone', 'gone-Pass-123')).status, 401);
});

test('sync respects ad.deactivate_removed = false and reports directory errors', async () => {
  configure({ 'ad.deactivate_removed': false });
  world.users = world.users.filter((x) => x.sam !== 'jdoe');
  const r = await directorySync.runSync();
  assert.equal(r.deactivated, 0);
  assert.equal(adUser('jdoe').active, 1);
  world.down = () => sockError('ECONNREFUSED', 'connect');
  const bad = await admin.call('POST', '/api/access/directory/sync', {});
  assert.equal(bad.status, 200);
  assert.equal(bad.json.errors.length, 1);
  assert.match(bad.json.errors[0], /Could not connect/);
  world.down = null;
  configure({ 'ad.deactivate_removed': true });
  const gone = await directorySync.runSync();
  assert.equal(gone.deactivated >= 1, true);
  assert.equal(adUser('jdoe').active, 0);
});

test('the sync schedule only fires when AD is enabled and complete, and every ad.sync_minutes', () => {
  settings.updateAd({ 'ad.enabled': false });
  assert.equal(directorySync.dueNow(), false);
  configure({ 'ad.sync_minutes': 30 });
  settings.set('ad.status', { last_sync_at: new Date(Date.now() - 29 * 60000).toISOString() });
  assert.equal(directorySync.dueNow(), false);
  settings.set('ad.status', { last_sync_at: new Date(Date.now() - 31 * 60000).toISOString() });
  assert.equal(directorySync.dueNow(), true);
  configure({ 'ad.bind_password': null });
  assert.equal(directorySync.dueNow(), false, 'incomplete configuration never syncs');
  configure();
});

test('disabling an AD user here drops their sessions and refuses the next sign-in', async () => {
  settings.updateAd({ 'ad.enabled': true });
  await assign('Viewer', 'ad_group', `CN=Staff-All,OU=Groups,${BASE}`, null, 'Staff-All');
  const z = await adLogin('zed', 'zed-Pass-123');
  assert.equal(z.status, 200, 'Staff-All reaches zed through Domain Users');
  const row = adUser('zed');
  const cookie = z.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${app.base}/api/datasets`, { headers: { cookie } })).status, 200);
  assert.equal((await admin.call('PUT', `/api/access/users/${row.id}`, { active: false, display_name: 'ignored' })).status, 200);
  assert.equal(adUser('zed').display_name, 'Zed Outside', 'name edits are ignored for domain users');
  assert.equal((await fetch(`${app.base}/api/datasets`, { headers: { cookie } })).status, 401);
  assert.equal((await adLogin('zed', 'zed-Pass-123')).status, 401);
});
