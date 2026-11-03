'use strict';
// Server-sent events hub. Every mutation calls broadcast() after commit.
const { nowIso } = require('./time');

const clients = new Set();
let timer = null;

function startHeartbeat() {
  if (timer) return;
  timer = setInterval(() => send({ type: 'ping' }), 25000);
  timer.unref();
}

function send(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch (e) {
      clients.delete(res);
    }
  }
}

function broadcast(type, extra) {
  send(Object.assign({ type, id: null, at: nowIso() }, extra || {}));
}

function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', id: null, at: nowIso(), buildId: require('./buildId').current() })}\n\n`);
  clients.add(res);
  startHeartbeat();
  req.on('close', () => clients.delete(res));
}

function clientCount() {
  return clients.size;
}

module.exports = { broadcast, addClient, clientCount };
