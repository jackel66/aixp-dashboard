'use strict';
// Data scopes (CONTRACT section 15). A scope is {all, lob_cg: [values]}. scope.all sees every line
// of business; otherwise only the granted LOB-CG values (the literal 'Unassigned' means the people
// whose lob_cg is blank, 'unassigned' or 'unknown'). Everything here is pure SQL-fragment building.
const { HttpError } = require('../errors');

const UNASSIGNED_VALUES = new Set(['', 'unassigned', 'unknown']);
const isUnassignedValue = (v) => v === null || v === undefined || UNASSIGNED_VALUES.has(String(v).trim().toLowerCase());

const isEmpty = (scope) => !scope.all && (!scope.lob_cg || scope.lob_cg.length === 0);

const grantsUnassigned = (scope) => !scope.all && (scope.lob_cg || []).some((v) => isUnassignedValue(v));

/**
 * {sql, params} to AND into a WHERE. all: ''. Scoped: a parenthesised predicate over <alias>.lob_cg.
 * opts.guard (default true) adds "<alias>.person_key IS NOT NULL" so a LEFT JOIN row with no people
 * match can never satisfy the Unassigned branch; pass false for rollup_org_month, which has no person_key.
 */
function peopleWhere(scope, alias = 'p', opts = {}) {
  if (scope.all) return { sql: '', params: [] };
  const guard = opts.guard === false ? '' : `${alias}.person_key IS NOT NULL AND `;
  const named = (scope.lob_cg || []).filter((v) => !isUnassignedValue(v));
  const parts = [];
  const params = [];
  if (named.length) {
    parts.push(`${alias}.lob_cg IN (${named.map(() => '?').join(', ')})`);
    params.push(...named);
  }
  if (grantsUnassigned(scope)) {
    parts.push(`(${alias}.lob_cg IS NULL OR lower(trim(${alias}.lob_cg)) IN ('', 'unassigned', 'unknown'))`);
  }
  if (!parts.length) return { sql: `(${guard}0)`, params: [] };
  return { sql: `(${guard}(${parts.join(' OR ')}))`, params };
}

/** True when a LOB-CG value (null for none) is inside the scope. */
function lobVisible(scope, value) {
  if (scope.all) return true;
  if (isUnassignedValue(value)) return grantsUnassigned(scope);
  return (scope.lob_cg || []).includes(value);
}

/** Throws 403 no_scope for a scoped caller with no values. */
function assertNotEmpty(scope) {
  if (isEmpty(scope)) {
    throw new HttpError(403, 'No data scope is assigned to your account. Ask an administrator to grant a line of business.', 'no_scope');
  }
}

/** Extra arguments the routes hand to the report functions: people.view decides whether names are returned. */
function optsFor(req) {
  return { people: req.auth.permissions.includes('people.view') };
}

module.exports = { UNASSIGNED_VALUES, isUnassignedValue, isEmpty, grantsUnassigned, peopleWhere, lobVisible, assertNotEmpty, optsFor };
