'use strict';
// Integration help (CONTRACT section 17). Static catalogue; any signed-in user may read it.
const express = require('express');
const help = require('../services/integrationHelp');
const { wrap, notFound } = require('../errors');

const router = express.Router();

router.get('/integrations', (req, res) => {
  res.json({ rows: help.list() });
});

router.get('/integrations/:id', wrap((req, res) => {
  const row = help.get(String(req.params.id));
  if (!row) throw notFound(`Unknown integration "${req.params.id}"`);
  res.json(row);
}));

module.exports = router;
