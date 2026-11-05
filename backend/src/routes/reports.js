'use strict';
const express = require('express');
const catalog = require('../services/reportCatalog');
const runner = require('../services/reportRunner');
const scope = require('../services/scope');

const router = express.Router();
router.get('/', (req, res) => res.json(catalog.list()));
router.get('/:id', (req, res) => res.json(runner.run(req.params.id, req.query, req.auth.scope, scope.optsFor(req))));

module.exports = router;
