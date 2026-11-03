import React, { useEffect, useState } from 'react';
import SegmentedControl from '../ui/SegmentedControl.jsx';
import DataState from '../DataState.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { SectionCard, Field, useSaver } from './shared.jsx';
import { useQuery } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { BASES } from '../../lib/platforms.js';

const SEAT = [
  { value: 'licensed', label: 'Licensed seats' },
  { value: 'active', label: 'Active people (estimate)' }
];

function Form({ s }) {
  const [seat, setSeat] = useState(s['spend.seat_basis']);
  const [def, setDef] = useState(s['spend.default_basis']);
  useEffect(() => { setSeat(s['spend.seat_basis']); setDef(s['spend.default_basis']); }, [s]);
  const { save, saving } = useSaver();
  const dirty = seat !== s['spend.seat_basis'] || def !== s['spend.default_basis'];
  return (
    <SectionCard id="basis" title="Spend basis" caption="How spend is counted. Consumption spend comes from usage rows; seat spend is the monthly seat rate times seats."
      dirty={dirty} saving={saving}
      onSave={() => save(() => api.put('/settings', { patch: { 'spend.seat_basis': seat, 'spend.default_basis': def } }))}>
      <Field label="Default basis on pages" hint="Pages open on this basis. Anyone can switch it with the basis control.">
        <SegmentedControl label="Default basis" value={def} options={BASES} onChange={setDef} />
      </Field>
      <Field label="Seat count" hint="Licensed seats uses the seat table. Active people counts distinct people with usage in each month and is labelled an estimate wherever it appears.">
        <SegmentedControl label="Seat count" value={seat} options={SEAT} onChange={setSeat} />
      </Field>
    </SectionCard>
  );
}

export default function BasisSection() {
  const q = useQuery('/settings', {});
  return <DataState q={q} skeleton={<SkeletonCard height={220} />}>{(s) => <Form s={s} />}</DataState>;
}
