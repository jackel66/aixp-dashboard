import React, { useEffect, useState } from 'react';
import DataState from '../DataState.jsx';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import { SkeletonCard } from '../ui/Skeleton.jsx';
import { useToast } from '../ui/Toast.jsx';
import Card from '../charts/Card.jsx';
import { Field } from './shared.jsx';
import { useQuery, clearQueryCache } from '../../lib/query.js';
import { api } from '../../lib/api.js';

const PROFILES = [
  { value: 'defective', label: 'Defective (every data problem switched on)' },
  { value: 'clean', label: 'Clean (no data problems)' }
];

function Form({ s }) {
  const opts = s['fixture.options'] || {};
  const [seed, setSeed] = useState(String(opts.seed));
  const [months, setMonths] = useState(String(opts.months));
  const [people, setPeople] = useState(String(opts.people));
  const [profile, setProfile] = useState(opts.profile || 'defective');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const o = s['fixture.options'] || {};
    setSeed(String(o.seed)); setMonths(String(o.months)); setPeople(String(o.people)); setProfile(o.profile || 'defective');
  }, [s]);
  const ok = [seed, months, people].every((v) => Number.isInteger(Number(v)) && Number(v) > 0) && Number(months) <= 36 && Number(people) <= 5000;
  const run = async () => {
    setBusy(true);
    try {
      await api.post('/fixtures/generate', { seed: Number(seed), months: Number(months), people: Number(people), profile, promote: true });
      toast.success('Fixture data regenerated and made current');
      setAsk(false);
      clearQueryCache();
    } catch (e) {
      toast.error(e.message || 'Could not regenerate');
    } finally { setBusy(false); }
  };
  return (
    <Card id="fixtures" title="Fixtures" caption="Version 1 runs on generated sample data. The same seed and options always give the same data.">
      <div className="grid gap-x-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Field label="Seed" htmlFor="fx-seed"><input id="fx-seed" className="input num" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: '100%' }} /></Field>
        <Field label="Months of history" htmlFor="fx-months" hint="1 to 36"><input id="fx-months" className="input num" type="number" min="1" max="36" value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: '100%' }} /></Field>
        <Field label="People" htmlFor="fx-people" hint="1 to 5,000"><input id="fx-people" className="input num" type="number" min="1" max="5000" value={people} onChange={(e) => setPeople(e.target.value)} style={{ width: '100%' }} /></Field>
        <Field label="Profile" htmlFor="fx-profile">
          <select id="fx-profile" className="input" value={profile} onChange={(e) => setProfile(e.target.value)} style={{ width: '100%' }}>
            {PROFILES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
      </div>
      <Button onClick={() => setAsk(true)} disabled={!ok}>Regenerate</Button>
      <Dialog open={ask} onClose={() => !busy && setAsk(false)} title="Regenerate fixture data?"
        footer={(<><Button variant="secondary" onClick={() => setAsk(false)} disabled={busy}>Cancel</Button><Button onClick={run} disabled={busy}>{busy ? 'Generating' : 'Regenerate and make current'}</Button></>)}>
        <p className="m-0">This builds a new dataset from seed {seed}, {months} months, {people} people and the {profile} profile, checks it, and makes it the current dataset. The dataset now in use is archived and can be restored from Data quality.</p>
      </Dialog>
    </Card>
  );
}

export default function FixturesSection() {
  const q = useQuery('/settings', {});
  return <DataState q={q} skeleton={<SkeletonCard height={260} />}>{(s) => <Form s={s} />}</DataState>;
}
