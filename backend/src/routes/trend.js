'use strict';
const express = require('express');
const reports = require('../services/reports');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.trend(req.query)));

module.exports = router;
