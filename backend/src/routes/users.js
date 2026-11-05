'use strict';
const express = require('express');
const reports = require('../services/reports');
const scope = require('../services/scope');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.users(req.query, req.auth.scope)));
router.get('/:personKey', (req, res) => res.json(reports.userDetail(req.params.personKey, req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
