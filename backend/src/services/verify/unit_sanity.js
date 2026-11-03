'use strict';
const { evidence, pass, fail, skip, platformName, PLATFORMS } = require('./util');

const LO = 1e-7;
const HI = 1e-3;

module.exports = {
  id: 'unit_sanity',
  title: 'Cost per token is plausible',
  severity: 'warn',
  platformScoped: true,
  meaning:
    'On token platforms the cost per token of each model should sit between 1e-7 and 1e-3 dollars. A rate far outside ' +
    'that range points to swapped units. Rows with cost and no tokens, or tokens and no cost, are counted but not failed.',
  run(ctx) {
    const out = [];
    for (const p of PLATFORMS) {
      if (p.unit !== 'tokens') { out.push(skip(p.id, `${p.name} bills in credits; the per-token rate test does not apply.`)); continue; }
      const total = ctx.db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ? AND platform = ?').get(ctx.datasetId, p.id).n;
      if (!total) { out.push(skip(p.id, `${p.name} has no usage rows in this dataset.`)); continue; }
      const models = ctx.db
        .prepare(
          `SELECT model, sum(cost_usd) AS cost, sum(tokens) AS tokens, count(*) AS n FROM usage
           WHERE dataset_id = ? AND platform = ? AND cost_usd > 0 AND tokens > 0 GROUP BY model ORDER BY model`
        )
        .all(ctx.datasetId, p.id);
      const costNoTokens = ctx.db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ? AND platform = ? AND cost_usd > 0 AND tokens <= 0').get(ctx.datasetId, p.id).n;
      const tokensNoCost = ctx.db.prepare('SELECT count(*) AS n FROM usage WHERE dataset_id = ? AND platform = ? AND tokens > 0 AND cost_usd <= 0').get(ctx.datasetId, p.id).n;
      const rows = models.map((m) => {
        const rate = m.cost / m.tokens;
        return { model: m.model, rate, n: m.n, bad: rate < LO || rate > HI };
      });
      const bad = rows.filter((r) => r.bad);
      const metrics = {
        models: rows.length, outOfRange: bad.length, costWithoutTokensRows: costNoTokens, tokensWithoutCostRows: tokensNoCost,
        lowerBound: LO, upperBound: HI,
      };
      const ev = evidence(['model', 'cost_per_token', 'rows', 'in_range'],
        rows.map((r) => [r.model || '(none)', Number(r.rate.toPrecision(4)), r.n, r.bad ? 'no' : 'yes']), rows.length);
      if (bad.length) {
        out.push(fail(p.id,
          `${platformName(p.id)}: ${bad.map((r) => `${r.model} at ${r.rate.toExponential(2)}`).join(', ')} per token is outside ${LO.toExponential(0)} to ${HI.toExponential(0)}. ` +
          `Check for swapped units. ${costNoTokens} rows have cost and no tokens; ${tokensNoCost} have tokens and no cost.`,
          metrics, ev, bad.reduce((a, r) => a + r.n, 0)));
      } else {
        out.push(pass(p.id,
          `${platformName(p.id)}: all ${rows.length} models price inside the expected range. ${costNoTokens} rows have cost and no tokens; ${tokensNoCost} have tokens and no cost.`,
          metrics, ev));
      }
    }
    return out;
  },
};
