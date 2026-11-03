'use strict';
const express = require('express');
const reports = require('../services/reports');

const router = express.Router();
router.get('/:id', (req, res) => res.json(reports.platformReport(req.params.id, req.query)));

module.exports = router;
