'use strict';
const express = require('express');
const reports = require('../services/reports');

const router = express.Router();
router.get('/', (req, res) => res.json(reports.users(req.query)));
router.get('/:personKey', (req, res) => res.json(reports.userDetail(req.params.personKey, req.query)));

module.exports = router;
