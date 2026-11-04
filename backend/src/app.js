'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const events = require('./services/events');
const auth = require('./auth');
const { HttpError } = require('./errors');
const pkg = require('../package.json');

// Builder B mounts the routes in mountRoutes(). Everything else here is the shared shell.
function mountRoutes(api) {
  api.use('/summary', require('./routes/summary'));
  api.use('/trend', require('./routes/trend'));
  api.use('/platforms', require('./routes/platforms'));
  api.use('/organization', require('./routes/organization'));
  api.use('/models', require('./routes/models'));
  api.use('/users', require('./routes/users'));
  api.use('/verification', require('./routes/verification'));
  api.use('/datasets', require('./routes/datasets'));
  api.use('/fixtures', require('./routes/fixtures'));
  api.use('/settings', require('./routes/settings'));
  api.use('/export', require('./routes/export'));
  api.use('/reports', require('./routes/reports'));
  api.use('/powerbi', require('./routes/powerbi'));
  api.use('/access', require('./routes/access'));
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  const api = express.Router();
  api.use(auth.gate);

  api.get('/health', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' });
    let extra = {};
    try { extra = require('./services/datasets').healthSummary(); } catch (e) { extra = { datasets: 'unavailable' }; }
    res.json(Object.assign({ ok: true, version: pkg.version, buildId: require('./services/buildId').current() }, extra));
  });
  auth.routes(api);
  api.get('/events', (req, res) => events.addClient(req, res));

  mountRoutes(api);

  api.use((req, res, next) => next(new HttpError(404, `No such API route: ${req.method} /api${req.path}`)));
  app.use('/api', api);

  const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    // Hashed assets can be cached for a year; the HTML shell must always be revalidated so a
    // new build shows up on a plain reload (and through Cloudflare).
    const noStore = {
      'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0',
      'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store'
    };
    app.use(express.static(dist, {
      index: false,
      setHeaders(res, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.set(noStore);
      }
    }));
    app.get(/^\/(?!api(\/|$)).*/, (req, res) => res.set(noStore).sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.type('text/plain').send('Frontend is not built. Run npm run build in frontend/.'));
  }

  // Four arguments make this the error middleware.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(400).json({ error: 'Request body is too large' });
    const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(`[error] ${req.method} ${req.originalUrl}: ${err && err.stack ? err.stack : err}`);
    return res.status(status).json({ error: (err && err.message) || 'Internal error' });
  });
  return app;
}

module.exports = { createApp };
