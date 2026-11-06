import { useState, type FormEvent } from 'react';
import { api, type GitStatus } from '../../api';
import { useAction, useResource } from '../../hooks';

const LABEL: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

export function ChangesPanel({ wsId, status, onOpenDiff, onChanged, log, busy }: {
  wsId: string;
  status?: GitStatus;
  onOpenDiff(path: string): void;
  onChanged(): Promise<void>;
  log(line: string): void;
  busy: boolean;
}) {
  const [message, setMessage] = useState('');
  const [pr, setPr] = useState<{ title: string; body: string } | null>(null);
  const [prUrl, setPrUrl] = useState<string>();

  const act = useAction(async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}…`);
    const out = await fn();
    log(`${label}: done${typeof out === 'string' ? ` ${out}` : ''}`);
    await onChanged();
  });

  const commit = (e: FormEvent) => {
    e.preventDefault();
    void act.run('Commit', async () => {
      const r = await api<{ sha: string }>('POST', `/workspaces/${wsId}/git/commit`, { message });
      setMessage('');
      return r.sha.slice(0, 7);
    });
  };

  const openPr = (e: FormEvent) => {
    e.preventDefault();
    void act.run('Open pull request', async () => {
      const r = await api<{ url: string; number: number }>('POST', `/workspaces/${wsId}/pull-request`, pr);
      setPrUrl(r.url);
      setPr(null);
      return `#${r.number}`;
    });
  };

  if (!status) return <div className="panel-pad muted">Loading…</div>;
  const protectedBranch = status.branch === status.defaultBranch;

  return (
    <div className="panel-pad stack" style={{ gap: 12 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        On <code>{status.branch}</code>
        {status.ahead > 0 && <> · {status.ahead} to push</>}
        {status.behind > 0 && <> · {status.behind} behind</>}
      </div>

      {status.files.length === 0 ? (
        <div className="muted">No changes.</div>
      ) : (
        <ul className="change-list">
          {status.files.map((f) => (
            <li key={f.path}>
              <button className={`change-row st-${f.status}`} onClick={() => onOpenDiff(f.path)} title="Show changes">
                <span className="tree-status">{LABEL[f.status]}</span>
                <span className="tree-name">{f.path}</span>
              </button>
              <button className="small danger" disabled={busy || act.pending} title="Discard this change"
                onClick={() => { if (confirm(`Discard changes to ${f.path}?`)) void act.run(`Discard ${f.path}`, () => api('POST', `/workspaces/${wsId}/git/discard`, { path: f.path })); }}>
                ↺
              </button>
            </li>
          ))}
        </ul>
      )}

      {status.files.length > 0 && (
        <form className="form" onSubmit={commit}>
          <textarea required rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
          <button className="primary" disabled={busy || act.pending || !message.trim()}>Commit all changes</button>
        </form>
      )}

      <div className="form-row">
        <button disabled={busy || act.pending || protectedBranch} title={protectedBranch ? 'Create a feature branch first' : ''}
          onClick={() => void act.run('Push', () => api('POST', `/workspaces/${wsId}/git/push`))}>
          Push
        </button>
        <button disabled={busy || act.pending} onClick={() => void act.run('Pull', () => api('POST', `/workspaces/${wsId}/git/pull`))}>Pull</button>
        <button disabled={busy || act.pending || protectedBranch} onClick={() => setPr({ title: '', body: '' })}>Pull request</button>
      </div>
      {protectedBranch && <div className="muted" style={{ fontSize: 12.5 }}>You are on the default branch. Create a branch to push.</div>}

      {pr && (
        <form className="form card" onSubmit={openPr}>
          <div className="muted" style={{ fontSize: 13 }}>From <code>{status.branch}</code> into <code>{status.baseBranch}</code>. Push first.</div>
          <input required placeholder="Title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
          <textarea rows={4} placeholder="Description" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
          <div className="form-row">
            <button className="primary" disabled={act.pending}>Open pull request</button>
            <button type="button" onClick={() => setPr(null)}>Cancel</button>
          </div>
        </form>
      )}
      {prUrl && <a href={prUrl} target="_blank" rel="noreferrer">View pull request ↗</a>}
      {act.error && <div className="error">{act.error}</div>}

      <Branches wsId={wsId} current={status.branch} onChanged={onChanged} disabled={busy} log={log} />
    </div>
  );
}

function Branches({ wsId, current, onChanged, disabled, log }: { wsId: string; current: string; onChanged(): Promise<void>; disabled: boolean; log(l: string): void }) {
  const branches = useResource<{ current: string; local: string[]; remote: string[] }>(`/workspaces/${wsId}/git/branches`);
  const [name, setName] = useState('');
  const act = useAction(async (branch: string, create: boolean) => {
    log(`${create ? 'Create' : 'Switch to'} branch ${branch}…`);
    await api('POST', `/workspaces/${wsId}/git/checkout`, { branch, create });
    log(`On branch ${branch}`);
    setName('');
    await branches.reload();
    await onChanged();
  });
  const fetchAll = useAction(async () => {
    await api('POST', `/workspaces/${wsId}/git/fetch`);
    await branches.reload();
  });
  const all = branches.data ? Array.from(new Set([...branches.data.local, ...branches.data.remote])).sort() : [];

  return (
    <details className="branches">
      <summary>Branches</summary>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); void act.run(name.trim(), true); }}>
          <label>New branch from here<input value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/new-authentication" /></label>
          <button disabled={disabled || !name.trim() || act.pending}>Create</button>
        </form>
        <ul className="change-list">
          {all.map((b) => (
            <li key={b}>
              <button className="change-row" disabled={b === current || disabled || act.pending} onClick={() => void act.run(b, false)}>
                <span className="tree-name">{b}</span>
                {b === current && <span className="badge ok">current</span>}
                {branches.data && !branches.data.local.includes(b) && <span className="badge">remote</span>}
              </button>
            </li>
          ))}
        </ul>
        <button className="small" disabled={fetchAll.pending} onClick={() => void fetchAll.run()}>Fetch from GitHub</button>
        {(act.error || fetchAll.error) && <div className="error">{act.error ?? fetchAll.error}</div>}
      </div>
    </details>
  );
}
