// Mirror of the backend PLATFORMS registry. Platform ids are stable; colours come from CSS tokens.
export const PLATFORMS = [
  { id: 'anthropic', name: 'Anthropic', unit: 'tokens', models: true },
  { id: 'openai', name: 'OpenAI', unit: 'tokens', models: true },
  { id: 'github', name: 'GitHub Copilot', unit: 'credits', models: false },
  { id: 'cowork', name: 'Copilot Cowork', unit: 'credits', models: false },
  { id: 'bedrock', name: 'AWS Bedrock', unit: 'tokens', models: true }
];
export const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
export const BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));
export const getPlatform = (id) => BY_ID[id] || null;
export const platformName = (id) => (BY_ID[id] ? BY_ID[id].name : id);
export const platformVar = (id) => 'var(--p-' + id + ')';
export const platformSoftVar = (id) => 'var(--p-' + id + '-soft)';

export const CAVEAT = 'This dashboard provides a directional view of AI spend. It may not reconcile to actual invoices or Finance-reported expense and should not be used for budget reconciliation.';

export const BASES = [
  { value: 'consumption', label: 'Consumption' },
  { value: 'seat', label: 'Seat' },
  { value: 'total', label: 'Total' }
];
export const BASIS_LABEL = { consumption: 'Consumption', seat: 'Seat', total: 'Total' };
