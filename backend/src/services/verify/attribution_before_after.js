'use strict';
const { evidence, pass, skip, platformName, PLATFORMS } = require('./util');

module.exports = {
  id: 'attribution_before_after',
  title: 'Rows and cost before and after normalization',
  severity: 'info',
  platformScoped: true,
  meaning:
    'Compares what was loaded with what survived normalization: rows and cost in stage versus usage, blank keys dropped ' +
    'and rows rejected. Cowork keeps one snapshot per person and month, so its row count falls by design.',
  run(ctx) {
    const ds = ctx.db.prepare('SELECT counts_json FROM datasets WHERE id = ?').get(ctx.datasetId);
    let counts = {};
    try { counts = JSON.parse((ds && ds.counts_json) || '{}'); } catch (e) { counts = {}; }
    const by = counts.byPlatform;
    if (!by) return PLATFORMS.map((p) => skip(p.id, 'Dataset has not been normalized yet.'));
    return PLATFORMS.map((p) => {
      const b = by[p.id];
      if (!b || !b.stageRows) return skip(p.id, `${p.name} has no rows in stage.`);
      const metrics = {
        stageRows: b.stageRows, usageRows: b.usageRows, stageCost: Math.round(b.stageCost * 100) / 100,
        usageCost: Math.round(b.usageCost * 100) / 100, droppedBlankKey: b.droppedBlankKey, rejected: b.rejected,
        coworkSnapshotsDropped: b.coworkSnapshotsDropped || 0,
      };
      const ev = evidence(['measure', 'stage', 'usage'],
        [['rows', b.stageRows, b.usageRows], ['cost_usd', metrics.stageCost, metrics.usageCost],
          ['blank keys dropped', b.droppedBlankKey, ''], ['rows rejected', b.rejected, ''],
          ['older cowork snapshots set aside', b.coworkSnapshotsDropped || 0, '']]);
      return pass(p.id,
        `${platformName(p.id)}: ${b.stageRows} rows in stage, ${b.usageRows} in usage; ${b.droppedBlankKey} blank keys dropped, ${b.rejected} rows rejected.`,
        metrics, ev);
    });
  },
};
