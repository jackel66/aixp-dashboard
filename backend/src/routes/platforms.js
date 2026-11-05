'use strict';
const express = require('express');
const reports = require('../services/reports');
const scope = require('../services/scope');

const router = express.Router();
router.get('/:id', (req, res) => res.json(reports.platformReport(req.params.id, req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
