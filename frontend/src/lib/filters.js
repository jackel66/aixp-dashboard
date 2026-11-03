// useUrlFilters(defaults) over useSearchParams. Defaults are never written to the URL.
// user, model and check push history entries so Back closes the drawer; everything else replaces.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export const FILTER_KEYS = ['from', 'to', 'bucket', 'platform', 'basis', 'rows', 'measure', 'q', 'sort', 'page', 'user', 'model', 'check'];
const PUSH_KEYS = new Set(['user', 'model', 'check']);
const LIST_KEYS = new Set(['platform']);

export function useUrlFilters(defaults = {}) {
  const [sp, setSp] = useSearchParams();
  const defKey = JSON.stringify(defaults);

  const values = useMemo(() => {
    const out = {};
    FILTER_KEYS.forEach((k) => {
      if (LIST_KEYS.has(k)) {
        const all = sp.getAll(k).filter(Boolean);
        out[k] = all.length ? all : (defaults[k] || []);
      } else {
        const v = sp.get(k);
        out[k] = v !== null && v !== '' ? v : (defaults[k] !== undefined ? defaults[k] : '');
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, defKey]);

  const set = useCallback((patch, options = {}) => {
    const next = new URLSearchParams(sp);
    let push = !!options.push;
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (PUSH_KEYS.has(k) && v) push = true;
      next.delete(k);
      const def = defaults[k];
      if (Array.isArray(v)) {
        const same = Array.isArray(def) && def.length === v.length && def.every((x, i) => x === v[i]);
        if (!same) v.forEach((x) => next.append(k, x));
      } else if (v !== undefined && v !== null && v !== '' && String(v) !== String(def === undefined ? '' : def)) {
        next.set(k, String(v));
      }
    });
    if (!patch.page && !('page' in patch) && Object.keys(patch).some((k) => !PUSH_KEYS.has(k) && k !== 'page')) next.delete('page');
    setSp(next, { replace: !push });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, setSp, defKey]);

  const reset = useCallback(() => setSp(new URLSearchParams(), { replace: true }), [setSp]);
  return { values, set, reset };
}

// Pick the filters an endpoint understands and drop empties.
export function apiParams(values, keys) {
  const out = {};
  keys.forEach((k) => {
    const v = values[k];
    if (Array.isArray(v)) { if (v.length) out[k] = v; } else if (v !== '' && v !== undefined && v !== null) out[k] = v;
  });
  return out;
}
