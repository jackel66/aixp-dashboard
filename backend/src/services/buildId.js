// Reads the frontend build id written by vite (frontend/dist/build.json) so the server can
// tell open pages which bundle it is serving. Re-read lazily, at most every 30 s, so a deploy
// that only swaps dist (no restart) is still noticed.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', '..', 'frontend', 'dist', 'build.json');
let cached = { id: null, at: 0 };

function current() {
  const now = Date.now();
  if (now - cached.at < 30000) return cached.id;
  let id = null;
  try { id = JSON.parse(fs.readFileSync(FILE, 'utf8')).buildId || null; } catch { id = null; }
  cached = { id, at: now };
  return id;
}

module.exports = { current };
