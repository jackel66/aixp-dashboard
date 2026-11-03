'use strict';
// Platform registry. The frontend mirrors this in src/lib/platforms.js.

const CAVEAT =
  'This dashboard provides a directional view of AI spend. It may not reconcile to actual ' +
  'invoices or Finance-reported expense and should not be used for budget reconciliation.';

const PLATFORMS = [
  { id: 'anthropic', name: 'Anthropic', unit: 'tokens', models: true, aliases: ['anthropic', 'claude'] },
  { id: 'openai', name: 'OpenAI', unit: 'tokens', models: true, aliases: ['openai', 'chatgpt'] },
  { id: 'github', name: 'GitHub Copilot', unit: 'credits', models: false, aliases: ['github', 'github copilot', 'copilot'] },
  { id: 'cowork', name: 'Copilot Cowork', unit: 'credits', models: false, aliases: ['cowork', 'copilot cowork'] },
];

const IDS = PLATFORMS.map((p) => p.id);
const BY_ID = {};
const BY_ALIAS = {};
for (const p of PLATFORMS) {
  BY_ID[p.id] = p;
  BY_ALIAS[p.name.toLowerCase()] = p.id;
  for (const a of p.aliases) BY_ALIAS[a] = p.id;
}

function byId(id) {
  return BY_ID[id] || null;
}

// Display name, id or alias (any case) -> platform id, or null.
function idFor(name) {
  if (name == null) return null;
  const s = String(name).replace(/\u00a0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  return BY_ALIAS[s] || null;
}

function isTokenPlatform(id) {
  return !!BY_ID[id] && BY_ID[id].unit === 'tokens';
}

module.exports = { CAVEAT, PLATFORMS, IDS, byId, idFor, isTokenPlatform };
