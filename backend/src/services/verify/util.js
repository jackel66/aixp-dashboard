'use strict';
// Shared helpers for the verification checks.
const { PLATFORMS } = require('../../platforms');

const EVIDENCE_CAP = 50;

function evidence(columns, rows, total) {
  const list = rows || [];
  return { columns, rows: list.slice(0, EVIDENCE_CAP), total: total === undefined ? list.length : total };
}

function result(status, platform, message, metrics, ev, affected) {
  return {
    status,
    platform: platform || null,
    message,
    metrics: metrics || {},
    evidence: ev || evidence([], []),
    affected: affected || 0,
  };
}

function pass(platform, message, metrics, ev) {
  return result('pass', platform, message, metrics, ev, 0);
}
function fail(platform, message, metrics, ev, affected) {
  return result('fail', platform, message, metrics, ev, affected);
}
function skip(platform, message) {
  return result('skip', platform, message, {}, evidence([], []), 0);
}

function platformName(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  return p ? p.name : id;
}

// Make non-breaking spaces visible and keep the output ASCII.
function vis(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\u00a0/g, '<nbsp>');
}

const money = (v) => `$${(Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = { evidence, result, pass, fail, skip, platformName, vis, money, EVIDENCE_CAP, PLATFORMS };
