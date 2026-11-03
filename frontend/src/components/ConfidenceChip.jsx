import React from 'react';
import { Link } from 'react-router-dom';
import HoverCard from './ui/HoverCard.jsx';
import StatusChip from './ui/StatusChip.jsx';
import { dateLong } from '../lib/format.js';

const WORD = { pass: 'Checks passed', warn: 'Checks need review', fail: 'Checks failed' };

// Data confidence rollup. Links to the Data quality page; the hover card repeats the counts and
// names the first failing check, but the link itself carries the same label.
export default function ConfidenceChip({ confidence }) {
  if (!confidence) return null;
  const v = confidence.verdict || 'pass';
  return (
    <HoverCard width={300} trigger={(
      <Link to="/data-quality" className="no-underline" aria-label={WORD[v] + '. Open data quality.'}>
        <StatusChip status={v}>{WORD[v]}</StatusChip>
      </Link>
    )}>
      <div className="t-h3" style={{ marginBottom: 6 }}>Data verification</div>
      <p className="m-0 text-muted">Last run {confidence.ran_at ? dateLong(confidence.ran_at) : 'not yet'}.</p>
      <ul className="list-none p-0 mt-2 mb-0 flex flex-col gap-1">
        <li className="flex justify-between"><span>Failed</span><span className="num">{confidence.fail}</span></li>
        <li className="flex justify-between"><span>Warnings</span><span className="num">{confidence.warn}</span></li>
        <li className="flex justify-between"><span>Passed</span><span className="num">{confidence.pass}</span></li>
        <li className="flex justify-between"><span>Info</span><span className="num">{confidence.info}</span></li>
      </ul>
      {confidence.first_failing && <p className="m-0 mt-2">First to review: {confidence.first_failing.title}</p>}
    </HoverCard>
  );
}
