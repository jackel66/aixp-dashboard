import React, { useState } from 'react';
import SegmentedControl from './SegmentedControl.jsx';
import Button from './Button.jsx';
import { SkeletonRows } from './Skeleton.jsx';

// Accessible data table. columns: [{ key, label, align: 'r', sortable, sortKey, render(row, i), title, width }].
// The first column of a clickable row renders as a button, so rows are reachable by keyboard.
// sort: { key, dir } and onSort(key) are controlled by the page. Header is sticky inside the
// scroll box when maxHeight is set.
const DENSITY = [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }];

function SortGlyph({ dir }) {
  const path = dir === 'asc' ? 'M2 8l4-5 4 5z' : dir === 'desc' ? 'M2 4l4 5 4-5z' : 'M3 4.5l3-3 3 3 M3 7.5l3 3 3-3';
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" fill={dir ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" style={{ opacity: dir ? 1 : 0.5 }}>
      <path d={path} />
    </svg>
  );
}

export default function DataTable({
  columns, rows, rowKey, onRowClick, sort, onSort, loading = false, error = null, onRetry,
  emptyTitle = 'Nothing to show', emptyBody, maxHeight, ariaLabel, toolbar, showDensity = true, defaultDensity = 'comfortable', rowProps
}) {
  const [density, setDensity] = useState(defaultDensity);
  const span = columns.length;
  const keyOf = (r, i) => (rowKey ? (typeof rowKey === 'function' ? rowKey(r) : r[rowKey]) : i);

  return (
    <div>
      {(toolbar || showDensity) && (
        <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginBottom: 8 }}>
          <div className="flex items-center gap-3 flex-wrap">{toolbar}</div>
          {showDensity && <SegmentedControl label="Row density" value={density} options={DENSITY} onChange={setDensity} />}
        </div>
      )}
      <div style={{ overflow: 'auto', maxHeight: maxHeight || undefined }}>
        <table className={'tbl' + (density === 'compact' ? ' compact' : '')} aria-label={ariaLabel} aria-busy={loading || undefined}>
          <thead>
            <tr>
              {columns.map((c) => {
                const sk = c.sortKey || c.key;
                const active = sort && sort.key === sk ? sort.dir : null;
                const sortable = c.sortable && onSort;
                return (
                  <th key={c.key} scope="col" className={c.align === 'r' ? 'r' : ''} title={c.title}
                    aria-sort={sortable ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                    style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-1)', width: c.width }}>
                    {sortable ? (
                      <button type="button" onClick={() => onSort(sk)}
                        className="inline-flex items-center gap-1 bg-transparent border-0 cursor-pointer text-muted hover:text-ink"
                        style={{ font: 'inherit', fontWeight: 600, padding: 0, color: active ? 'var(--ink)' : undefined }}>
                        {c.label}<SortGlyph dir={active} />
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error && !rows.length && (
              <tr><td colSpan={span}>
                <div className="flex items-center justify-between gap-3" role="alert">
                  <span className="text-muted">Could not load rows: {error.message || 'the request failed'}.</span>
                  {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>}
                </div>
              </td></tr>
            )}
            {loading && !rows.length && !error && (
              <tr><td colSpan={span}><SkeletonRows rows={6} /></td></tr>
            )}
            {!loading && !error && !rows.length && (
              <tr><td colSpan={span}>
                <div className="text-center" style={{ padding: '24px 0' }}>
                  <div className="t-h2">{emptyTitle}</div>
                  {emptyBody && <p className="text-muted" style={{ marginTop: 4 }}>{emptyBody}</p>}
                </div>
              </td></tr>
            )}
            {rows.map((r, i) => {
              const extra = rowProps ? rowProps(r) : {};
              return (
                <tr key={keyOf(r, i)} className={onRowClick ? 'row-btn' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={{ cursor: onRowClick ? 'pointer' : undefined, ...(extra.style || {}) }}>
                  {columns.map((c, ci) => {
                    const content = c.render ? c.render(r, i) : r[c.key];
                    return (
                      <td key={c.key} className={(c.align === 'r' ? 'r num' : '') + (c.className ? ' ' + c.className : '')}>
                        {onRowClick && ci === 0
                          ? <button type="button" className="row-button" onClick={(e) => { e.stopPropagation(); onRowClick(r); }}>{content}</button>
                          : content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
export { DataTable };
