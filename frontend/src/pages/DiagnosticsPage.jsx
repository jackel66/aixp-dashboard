import React, { useEffect, useState } from 'react';
import { clearErrors, environmentReport, getErrors, onErrors } from '../lib/errlog.js';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';

// Everything needed to report a page problem: environment, server build, captured errors.
export default function DiagnosticsPage() {
  const [errors, setErrors] = useState(getErrors());
  const [server, setServer] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => onErrors(setErrors), []);
  useEffect(() => { api.get('/health').then(setServer).catch((e) => setServer({ error: e.message })); }, []);

  const env = environmentReport();
  const report = [
    'AIxP dashboard diagnostics',
    'page build: ' + env.build,
    'server build: ' + (server && server.buildId ? server.buildId : (server && server.error) || 'loading'),
    'user agent: ' + env.userAgent,
    'viewport: ' + env.viewport + ' at ' + env.devicePixelRatio + 'x, reduced motion ' + env.reducedMotion,
    'url: ' + env.url,
    'time: ' + env.time,
    '',
    'captured errors (' + errors.length + '):',
    ...errors.map((e) => '- ' + e.at + ' [' + e.kind + '] ' + e.message + (e.extra && e.extra.file ? ' (' + e.extra.file + ':' + e.extra.line + ')' : '') + (e.stack ? '\n    ' + e.stack.split('\n').slice(0, 4).join('\n    ') : ''))
  ].join('\n');

  async function copy() {
    try { await navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHeader title="Diagnostics" description="If a chart or page misbehaves, open this page in the same tab, press Copy, and paste the text into chat." />
      <div className="flex gap-2 mb-3">
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button variant="secondary" onClick={() => clearErrors()}>Clear errors</Button>
      </div>
      <pre className="card t-small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{report}</pre>
    </div>
  );
}
