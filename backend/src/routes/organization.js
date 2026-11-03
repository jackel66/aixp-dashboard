'use strict';
const express = require('express');
const reports = require('../services/reports');

const router = express.Router();
router.get('/cell', (req, res) => res.json(reports.orgCell(req.query)));
router.get('/', (req, res) => res.json(reports.organization(req.query)));

module.exports = router;
