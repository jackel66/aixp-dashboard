'use strict';
const express = require('express');
const reports = require('../services/reports');
const { toCsv, flatten, flattenReport } = require('../services/csvExport');
const runner = require('../services/reportRunner');
const scopeMod = require('../services/scope');
const { notFound, badRequest } = require('../errors');

const router = express.Router();

router.get('/report/:file', (req, res) => {
  const m = /^([a-z_]+).csv$/.exec(req.params.file);
  if (!m) throw notFound('Report');
  const rep = runner.run(m[1], req.query, req.auth.scope, scopeMod.optsFor(req));
  const { columns, rows } = flattenReport(rep);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="aixp-report-${m[1]}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send(toCsv(columns, rows));
});

router.get('/:file', (req, res) => {
  const m = /^([a-z]+)\.csv$/.exec(req.params.file);
  if (!m) throw notFound('Export');
  const report = m[1];
  const q = req.query;
  const sc = req.auth.scope;
  const so = scopeMod.optsFor(req);
  let data;
  if (report === 'summary') data = reports.summary(q, sc, so);
  else if (report === 'trend') data = reports.trend(q, sc, so);
  else if (report === 'platform') {
    const id = Array.isArray(q.platform) ? q.platform[0] : q.platform;
    if (!id) throw badRequest('platform is required for the platform export');
    data = reports.platformReport(id, q, sc, so);
  } else if (report === 'organization') data = reports.organization(q, sc, so);
  else if (report === 'models') data = reports.models(q, sc, so);
  else if (report === 'users') data = reports.users(Object.assign({}, q, { page: 1, pageSize: 100000 }), sc, { maxPageSize: 100000 });
  else throw notFound('Export');
  const { columns, rows } = flatten(report, data);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="aixp-${report}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send(toCsv(columns, rows));
});

module.exports = router;
