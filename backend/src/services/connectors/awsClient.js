'use strict';
// AWS client factory for the Bedrock connector (CONTRACT section 19.3). Builds the five SDK clients from the
// bedrock.* settings (static credentials, optional session token, optional AssumeRole through
// fromTemporaryCredentials, region, endpoint overrides) and wraps every call with one retry rule:
// ThrottlingException and 5xx retry three times with backoff, anything else stops with the AWS error name and
// message. Credentials are read at call time and never appear in logs, errors or test details.
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
const { CostExplorerClient } = require('@aws-sdk/client-cost-explorer');
const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
const { STSClient } = require('@aws-sdk/client-sts');
const { BedrockClient } = require('@aws-sdk/client-bedrock');
const { fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
const settings = require('../settings');
const { HttpError } = require('../../errors');

const RETRIES = 3;
const SESSION_NAME = 'aixp-dashboard';
const CE_REGION = 'us-east-1';
const stats = { calls: 0, retries: 0 };
let backoffMs = 1000;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

// Tests inject a short backoff and a recording sleep.
function setBackoff(ms) { backoffMs = ms === undefined || ms === null ? 1000 : ms; }
function setSleep(fn) { sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }
function resetStats() { stats.calls = 0; stats.retries = 0; }

const s = (key, dflt) => String(settings.get(key, dflt) === null ? '' : settings.get(key, dflt)).trim();

function readSecret(name) {
  try { return settings.getSecret(name); } catch (e) {
    throw new HttpError(500, `The stored ${name} cannot be read with the current secret key. Enter it again in Settings.`);
  }
}

const region = () => s('bedrock.region', 'us-east-1') || 'us-east-1';

function staticCredentials() {
  const accessKeyId = s('bedrock.access_key_id', '');
  const secretAccessKey = readSecret('bedrock.secret_access_key');
  const sessionToken = readSecret('bedrock.session_token');
  const c = { accessKeyId, secretAccessKey };
  if (sessionToken) c.sessionToken = sessionToken;
  return c;
}

function endpointOf(name) {
  const e = s(name, '').replace(/\/+$/, '');
  return e || undefined;
}

/**
 * The five clients plus the credential summary. One set per pull or test; the SDK caches the STS session
 * inside the credential provider for the life of the set.
 */
function build() {
  const base = staticCredentials();
  const roleArn = s('bedrock.role_arn', '');
  const stsEndpoint = endpointOf('bedrock.endpoint_sts');
  const rgn = region();
  let credentials = base;
  if (roleArn) {
    const clientConfig = { region: rgn, maxAttempts: 1 };
    if (stsEndpoint) clientConfig.endpoint = stsEndpoint;
    credentials = fromTemporaryCredentials({
      masterCredentials: base,
      params: { RoleArn: roleArn, RoleSessionName: SESSION_NAME },
      clientConfig,
    });
  }
  const common = (r, endpoint) => {
    const o = { region: r, credentials, maxAttempts: 1 };
    if (endpoint) o.endpoint = endpoint;
    return o;
  };
  return {
    region: rgn,
    assumed: !!roleArn,
    logs: new CloudWatchLogsClient(common(rgn, endpointOf('bedrock.endpoint_logs'))),
    ce: new CostExplorerClient(common(CE_REGION, endpointOf('bedrock.endpoint_ce'))),
    cloudwatch: new CloudWatchClient(common(rgn, endpointOf('bedrock.endpoint_cloudwatch'))),
    sts: new STSClient(common(rgn, stsEndpoint)),
    bedrock: new BedrockClient(common(rgn, endpointOf('bedrock.endpoint_bedrock'))),
  };
}

function isRetryable(e) {
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  if (e && (e.name === 'ThrottlingException' || e.name === 'Throttling' || e.name === 'TooManyRequestsException')) return true;
  return typeof status === 'number' && status >= 500;
}

// AWS error text: "Name: message". Never includes request headers or credentials.
function errorText(e) {
  const name = (e && e.name) || 'Error';
  const msg = String((e && e.message) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const code = e && e.code && !msg.includes(String(e.code)) && !name.includes(String(e.code)) ? ` (${e.code})` : '';
  return `${name}: ${msg || 'no message'}${code}`;
}

/** client.send(command) with the retry rule. Failures become 502 HttpErrors carrying awsName. */
async function send(client, command) {
  let attempt = 0;
  for (;;) {
    stats.calls += 1;
    try {
      return await client.send(command);
    } catch (e) {
      if (attempt < RETRIES && isRetryable(e)) {
        attempt += 1;
        stats.retries += 1;
        await sleepFn(backoffMs * attempt);
        continue;
      }
      const err = new HttpError(502, errorText(e));
      err.awsName = (e && e.name) || 'Error';
      err.upstreamStatus = (e && e.$metadata && e.$metadata.httpStatusCode) || null;
      throw err;
    }
  }
}

module.exports = { build, send, errorText, region, setBackoff, setSleep, resetStats, stats, RETRIES, CE_REGION, SESSION_NAME };
