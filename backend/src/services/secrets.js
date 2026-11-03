'use strict';
// Secret storage: AES-256-GCM. Key from env AIXP_SECRET_KEY (32 bytes as 64 hex chars or base64),
// else a generated key file beside the database (backend/data/.secret-key by default, mode 0600).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
let cached = null;
let cachedFor = null;

function parseKey(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length === 32) return b;
  throw new Error('AIXP_SECRET_KEY must be 32 bytes as 64 hex characters or base64');
}

function keyFilePath() {
  if (process.env.AIXP_SECRET_FILE) return process.env.AIXP_SECRET_FILE;
  const { dbPath } = require('../db');
  return path.join(path.dirname(dbPath()), '.secret-key');
}

function key() {
  const env = process.env.AIXP_SECRET_KEY;
  const sig = env ? `env:${env}` : `file:${keyFilePath()}`;
  if (cached && cachedFor === sig) return cached;
  let k;
  if (env) {
    k = parseKey(env);
  } else {
    const file = keyFilePath();
    if (fs.existsSync(file)) {
      k = parseKey(fs.readFileSync(file, 'utf8'));
    } else {
      k = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600 });
    }
  }
  cached = k;
  cachedFor = sig;
  return k;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function isEncrypted(s) {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

// Returns the plain text, or throws when the value was not written with this key.
function decrypt(blob) {
  if (!isEncrypted(blob)) throw new Error('Value is not an encrypted secret');
  const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
  if (raw.length < 29) throw new Error('Encrypted secret is truncated');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
