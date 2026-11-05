'use strict';
const express = require('express');
const reports = require('../services/reports');
const scope = require('../services/scope');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.models(req.query, req.auth.scope, scope.optsFor(req))));
router.get('/:platform/:model', (req, res) => res.json(reports.modelDetail(req.params.platform, req.params.model, req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
