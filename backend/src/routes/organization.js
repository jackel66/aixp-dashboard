'use strict';
const express = require('express');
const reports = require('../services/reports');
const scope = require('../services/scope');

const router = express.Router();
router.get('/cell', (req, res) => res.json(reports.orgCell(req.query, req.auth.scope, scope.optsFor(req))));
router.get('/', (req, res) => res.json(reports.organization(req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
