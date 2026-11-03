import React, { useEffect, useState } from 'react';
import DataState from '../DataState.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { SectionCard, Field, useSaver } from './shared.jsx';
import { useQuery } from '../../lib/query.js';
import { api } from '../../lib/api.js';

function Form({ s }) {
  const [rate, setRate] = useState(String(s['cowork.rate']));
  const [ok, setOk] = useState(!!s['cowork.rate_confirmed']);
  useEffect(() => { setRate(String(s['cowork.rate'])); setOk(!!s['cowork.rate_confirmed']); }, [s]);
  const { save, saving } = useSaver();
  const n = Number(rate);
  const valid = Number.isFinite(n) && n > 0;
  const dirty = n !== s['cowork.rate'] || ok !== !!s['cowork.rate_confirmed'];
  return (
    <SectionCard id="cowork" title="Copilot Cowork rate" caption="Cowork reports cumulative monthly credits used. Each credit is valued at this rate to estimate cost."
      dirty={dirty} saving={saving} disabled={!valid}
      onSave={() => save(() => api.put('/settings', { patch: { 'cowork.rate': n, 'cowork.rate_confirmed': ok } }))}
      extra={!s['cowork.rate_confirmed'] && <StatusChip status="warn">Reconfirm rate</StatusChip>}>
      <Field label="USD per credit" htmlFor="cowork-rate" hint="Changing the rate reprices every Cowork row, past and present.">
        <input id="cowork-rate" className="input num" type="number" min="0" step="0.001" value={rate} style={{ width: 140 }} onChange={(e) => setRate(e.target.value)} aria-invalid={!valid} />
      </Field>
      <label className="inline-flex items-center gap-2" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        I have confirmed this rate with Finance
      </label>
      {!valid && <p className="t-small m-0" role="alert" style={{ marginTop: 8, color: 'var(--fail)' }}>Enter a rate above zero.</p>}
    </SectionCard>
  );
}

export default function CoworkSection() {
  const q = useQuery('/settings', {});
  return <DataState q={q} skeleton={<SkeletonCard height={220} />}>{(s) => <Form s={s} />}</DataState>;
}
