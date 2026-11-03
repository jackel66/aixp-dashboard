'use strict';
const express = require('express');
const reports = require('../services/reports');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.models(req.query)));
router.get('/:platform/:model', (req, res) => res.json(reports.modelDetail(req.params.platform, req.params.model, req.query)));

module.exports = router;
