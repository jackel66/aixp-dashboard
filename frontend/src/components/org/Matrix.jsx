import React from 'react';
import HoverCard from '../ui/HoverCard.jsx';
import Tooltip from '../ui/Tooltip.jsx';
import MatrixCellCard from './MatrixCellCard.jsx';
import { PLATFORMS } from '../../lib/platforms.js';
import { money, count, units } from '../../lib/format.js';

export const UNMATCHED_TIP = 'Usage whose identity did not resolve to a person. Shown so raw and attributed totals can be compared.';
const STRIPE = 'repeating-linear-gradient(135deg, var(--bg-2) 0, var(--bg-2) 6px, transparent 6px, transparent 12px)';

function figure(cell, measure) {
  if (!cell) return '-';
  if (measure === 'users') return count(cell.active_users);
  if (measure === 'units') return units(cell.consumption.value, cell.consumption.unit);
  return money(cell.usd);
}
function weight(cell, measure) {
  if (!cell) return 0;
  if (measure === 'users') return cell.active_users;
  if (measure === 'units') return cell.consumption.value;
  return cell.usd;
}

// Row total. Tokens and credits are never added together, so unit totals are listed per unit.
function RowTotal({ row, measure }) {
  if (measure === 'spend') return <>{money(row.total.usd)}</>;
  if (measure === 'users') return <>{count(row.total.active_users)}</>;
  const by = {};
  PLATFORMS.forEach((p) => {
    const c = row.cells && row.cells[p.id];
    if (c) by[c.consumption.unit] = (by[c.consumption.unit] || 0) + c.consumption.value;
  });
  const keys = Object.keys(by);
  if (!keys.length) return <>-</>;
  return <>{keys.map((u) => <div key={u}>{units(by[u], u)}</div>)}</>;
}

const FOOT = { padding: '8px 12px', borderTop: '2px solid var(--line)', fontWeight: 600 };

export default function Matrix({ data, measure, dim }) {
  const rows = data.rows;
  const unmatched = rows.filter((r) => r.key === '__unmatched__');
  const ordered = rows.filter((r) => r.key !== '__unmatched__').concat(unmatched);
  const max = {};
  PLATFORMS.forEach((p) => { max[p.id] = Math.max(1, ...rows.map((r) => weight(r.cells && r.cells[p.id], measure))); });

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl" aria-label={'Organization matrix by ' + dim}>
        <thead>
          <tr>
            <th scope="col">Group</th>
            {PLATFORMS.map((p) => (
              <th key={p.id} scope="col" className="r">
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--p-' + p.id + ')', display: 'inline-block' }} />
                  {p.name}
                </span>
              </th>
            ))}
            <th scope="col" className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => {
            const isUn = r.key === '__unmatched__';
            const canLink = !isUn && r.key !== '__unassigned__' && r.key !== 'unassigned';
            return (
              <tr key={r.key} style={isUn ? { background: STRIPE, color: 'var(--muted)' } : undefined}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: isUn ? 500 : 600, color: isUn ? 'var(--muted)' : 'var(--ink)', fontSize: 14, borderBottom: '1px solid var(--line)' }}>
                  {isUn ? (
                    <Tooltip text={UNMATCHED_TIP}><span tabIndex={0} style={{ cursor: 'help', borderBottom: '1px dotted var(--faint)' }}>{r.label}</span></Tooltip>
                  ) : r.label}
                </th>
                {PLATFORMS.map((p) => {
                  const cell = r.cells && r.cells[p.id];
                  const w = weight(cell, measure) / max[p.id];
                  const tint = !isUn && w > 0 ? { background: 'color-mix(in srgb, var(--p-' + p.id + ') ' + Math.round(w * 22) + '%, transparent)' } : {};
                  return (
                    <td key={p.id} className="r num" style={{ ...tint, padding: 0 }}>
                      {cell && !isUn ? (
                        <HoverCard width={320} placement="bottom" className="w-full"
                          trigger={(
                            <button type="button" className="w-full bg-transparent border-0 cursor-pointer text-ink"
                              style={{ font: 'inherit', textAlign: 'right', padding: '4px 12px', minHeight: 36 }}
                              aria-label={r.label + ', ' + p.name + ': ' + figure(cell, measure) + '. Show top contributors.'}>
                              {figure(cell, measure)}
                            </button>
                          )}>
                          <MatrixCellCard dim={dim} rowKey={r.key} rowLabel={r.label} platform={p.id} canLink={canLink} />
                        </HoverCard>
                      ) : <span style={{ display: 'block', padding: '4px 12px' }}>{figure(cell, measure)}</span>}
                    </td>
                  );
                })}
                <td className="r num" style={{ fontWeight: 600 }}><RowTotal row={r} measure={measure} /></td>
              </tr>
            );
          })}
        </tbody>
        {data.totals && (
          <tfoot>
            <tr>
              <th scope="row" style={{ textAlign: 'left', padding: '8px 12px', borderTop: '2px solid var(--line)' }}>All groups</th>
              {PLATFORMS.map((p) => (
                <td key={p.id} className="r num" style={FOOT}>{figure(data.totals.cells && data.totals.cells[p.id], measure)}</td>
              ))}
              <td className="r num" style={FOOT}>
                <RowTotal row={{ cells: data.totals.cells, total: data.totals.total }} measure={measure} />
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
