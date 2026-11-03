'use strict';
// Entry point. Builder B owns the first-boot fixture seed (docs/CONTRACT.md section 5).
const { open } = require('./db');
const { createApp } = require('./app');

async function main() {
  open();
  const port = parseInt(process.env.PORT, 10) || 3090;
  const app = createApp();
  const server = app.listen(port, () => console.log(`[server] listening on http://localhost:${port}`));
  server.on('error', (e) => { console.error('[server] failed to start:', e.message); process.exit(1); });
}

main().catch((e) => { console.error('[server] fatal:', e.stack || e); process.exit(1); });
