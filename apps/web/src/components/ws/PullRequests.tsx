import { useState } from 'react';
import { api, type PullRequestDetail, type PullRequestSummary } from '../../api';
import { useAction, useResource } from '../../hooks';

const CHECKS_LABEL: Record<string, string> = { success: 'checks passed', pending: 'checks running', failure: 'checks failed', none: 'no checks' };

/** Pull requests of the workspace's repository on GitHub: list, detail and merge. */
export function PullRequests({ wsId, log }: { wsId: string; log(line: string): void }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [selected, setSelected] = useState<number>();
  const list = useResource<PullRequestSummary[]>(`/workspaces/${wsId}/pull-requests?state=${state}`);

  if (selected !== undefined) {
    return <PullRequestView wsId={wsId} number={selected} log={log} onBack={() => { setSelected(undefined); void list.reload(); }} />;
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="form-row" style={{ alignItems: 'center' }}>
        <div className="segmented small" role="radiogroup" aria-label="Pull request state">
          {(['open', 'closed', 'all'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={state === s} className={state === s ? 'on' : ''} onClick={() => setState(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button className="small" onClick={() => void list.reload()} disabled={list.loading}>Reload</button>
      </div>
      {list.loading && !list.data && <div className="muted">Loading pull requests…</div>}
      {list.error && <div className="error">{list.error.message}</div>}
      {list.data && list.data.length === 0 && <div className="muted">No {state === 'all' ? '' : `${state} `}pull requests.</div>}
      {list.data && list.data.length > 0 && (
        <ul className="change-list">
          {list.data.map((p) => (
            <li key={p.number}>
              <button className="change-row pr-row" onClick={() => setSelected(p.number)}>
                <span className={`badge pr-state pr-${p.state}`}>{p.draft && p.state === 'open' ? 'draft' : p.state}</span>
                <span className="tree-name">#{p.number} {p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PullRequestView({ wsId, number, log, onBack }: { wsId: string; number: number; log(line: string): void; onBack(): void }) {
  const pr = useResource<PullRequestDetail>(`/workspaces/${wsId}/pull-requests/${number}`);
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const [openPatch, setOpenPatch] = useState<string>();
  const merge = useAction(async () => {
    log(`Merge pull request #${number}…`);
    const r = await api<{ merged: boolean; sha: string }>('POST', `/workspaces/${wsId}/pull-requests/${number}/merge`, { method });
    log(`Merge pull request #${number}: ${r.merged ? `merged ${r.sha.slice(0, 7)}` : 'not merged'}`);
    await pr.reload();
  });

  const p = pr.data;
  const blocked = p && (p.mergeable === false || ['dirty', 'blocked'].includes(p.mergeableState));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div><button className="small" onClick={onBack}>‹ All pull requests</button></div>
      {pr.loading && !p && <div className="muted">Loading #{number}…</div>}
      {pr.error && <div className="error">{pr.error.message}</div>}
      {p && (
        <>
          <div>
            <div style={{ fontWeight: 600 }}>#{p.number} {p.title}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {p.author} wants to merge <code>{p.head}</code> into <code>{p.base}</code> · <a href={p.url} target="_blank" rel="noreferrer">GitHub ↗</a>
            </div>
          </div>
          <div className="form-row" style={{ gap: 6 }}>
            <span className={`badge pr-state pr-${p.state}`}>{p.draft && p.state === 'open' ? 'draft' : p.state}</span>
            {p.checks && <span className={`badge${p.checks.state === 'success' ? ' ok' : p.checks.state === 'failure' ? ' warn' : ''}`}>{CHECKS_LABEL[p.checks.state]}{p.checks.total ? ` (${p.checks.total})` : ''}</span>}
            {p.state === 'open' && (
              p.mergeable === null ? <span className="badge">GitHub is checking mergeability</span>
                : blocked ? <span className="badge warn">{p.mergeableState === 'blocked' ? 'blocked by rules' : 'has conflicts'}</span>
                : <span className="badge ok">can be merged</span>
            )}
          </div>
          {p.body && <div className="pr-body rich">{p.body}</div>}
          <div>
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>{p.files.length} file{p.files.length === 1 ? '' : 's'} changed{p.filesTruncated ? ' (first 100 shown)' : ''}</div>
            <ul className="change-list">
              {p.files.map((f) => (
                <li key={f.path} style={{ display: 'block' }}>
                  <button className="change-row" onClick={() => setOpenPatch(openPatch === f.path ? undefined : f.path)} aria-expanded={openPatch === f.path}>
                    <span className="tree-name">{f.path}</span>
                    <span className="pr-stat"><span className="pr-add">+{f.additions}</span> <span className="pr-del">−{f.deletions}</span></span>
                  </button>
                  {openPatch === f.path && <pre className="code-block pr-patch">{f.patch ?? 'No text diff (binary or too large).'}</pre>}
                </li>
              ))}
            </ul>
          </div>
          {p.state === 'open' && p.canMerge && (
            <div className="form-row">
              <label style={{ flex: '0 1 180px' }}>
                Merge method
                <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  <option value="squash">Squash and merge</option>
                  <option value="merge">Create a merge commit</option>
                  <option value="rebase">Rebase and merge</option>
                </select>
              </label>
              <button className="primary" disabled={merge.pending || !!blocked || p.mergeable === null || p.draft}
                onClick={() => { if (confirm(`Merge #${p.number} into ${p.base}?`)) void merge.run(); }}>
                {merge.pending ? 'Merging…' : 'Merge'}
              </button>
            </div>
          )}
          {p.state === 'open' && !p.canMerge && <div className="muted" style={{ fontSize: 12.5 }}>Merging needs the app admin role.</div>}
          {merge.error && <div className="error">{merge.error}</div>}
        </>
      )}
    </div>
  );
}
