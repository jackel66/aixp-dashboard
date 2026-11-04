// Shared bits for the Access sections: event names, the password rule and small formatters.
export const ACCESS_EVENTS = ['access.changed', 'settings.changed'];
export const PASSWORD_RULE = 'Use 10 to 128 characters.';
export const passwordOk = (p) => typeof p === 'string' && p.length >= 10 && p.length <= 128;

export function whenText(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function isLocked(u) {
  return !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now());
}
