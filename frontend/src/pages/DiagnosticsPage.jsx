import React, { useEffect, useState } from 'react';
import { clearErrors, environmentReport, getErrors, onErrors } from '../lib/errlog.js';
import { api } from '../lib/api.js';

// Everything needed to report a page problem: environment, server build, captured errors.
export default function DiagnosticsPage() {
  const [errors, setErrors] = useState(getErrors());
  const [server, setServer] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => onErrors(setErrors), []);
  useEffect(() => { api.get('/health').then(setServer).catch((e) => setServer({ error: e.message })); }, []);

  const env = environmentReport();
  const report = [
    'CG Deal Tracker diagnostics',
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
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-extrabold text-t3-navy m-0">Diagnostics</h1>
      <p className="text-sm text-t3-grey mt-1 mb-4">If a chart or page misbehaves, open this page in the same tab, press Copy, and paste the text into chat.</p>
      <div className="flex gap-2 mb-3">
        <button type="button" onClick={copy} className="rounded-full bg-t3-sky hover:bg-t3-steel text-white text-sm font-semibold px-4 py-1.5 border-0 cursor-pointer">{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" onClick={() => { clearErrors(); }} className="rounded-full bg-white text-t3-navy text-sm font-semibold px-4 py-1.5 border border-t3-smoke cursor-pointer">Clear errors</button>
      </div>
      <pre className="bg-[#f5f5f5] border border-t3-smoke rounded-lg p-4 text-xs whitespace-pre-wrap break-words">{report}</pre>
    </div>
  );
}
