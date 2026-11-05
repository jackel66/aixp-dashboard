'use strict';
const express = require('express');
const reports = require('../services/reports');
const scope = require('../services/scope');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.summary(req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
