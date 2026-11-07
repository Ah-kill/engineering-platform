import { useState, type FormEvent, type ReactNode } from 'react';
import { api, type BranchList, type CommitDetail, type CommitSummary, type Comparison, type GitStatus } from '../../api';
import { useAction, useResource } from '../../hooks';
import { DiffReview } from './DiffReview';
import { PullRequests } from './PullRequests';

const LABEL: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

/** What the review overlay shows: one commit or a branch comparison. */
type Review =
  | { kind: 'commit'; detail: CommitDetail }
  | { kind: 'compare'; detail: Comparison };

export function ChangesPanel({ wsId, status, onOpenDiff, onChanged, log, busy, readOnly = false, compact = false }: {
  wsId: string;
  status?: GitStatus;
  onOpenDiff(path: string): void;
  onChanged(): Promise<void>;
  log(line: string): void;
  busy: boolean;
  /** View-only access (a viewer of a shared workspace): no commits, pushes or other changes. */
  readOnly?: boolean;
  compact?: boolean;
}) {
  const [message, setMessage] = useState('');
  const [pr, setPr] = useState<{ title: string; body: string } | null>(null);
  const [prUrl, setPrUrl] = useState<string>();
  const [review, setReview] = useState<Review>();

  const act = useAction(async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}…`);
    const out = await fn();
    log(`${label}: done${typeof out === 'string' ? ` ${out}` : ''}`);
    await onChanged();
  });

  const openCommit = useAction(async (sha: string) => {
    setReview({ kind: 'commit', detail: await api<CommitDetail>('GET', `/workspaces/${wsId}/git/commit/${sha}`) });
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
        {readOnly && <> · <span className="badge">view only</span></>}
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
              {!readOnly && (
                <button className="small danger" disabled={busy || act.pending} title="Discard this change"
                  onClick={() => { if (confirm(`Discard changes to ${f.path}?`)) void act.run(`Discard ${f.path}`, () => api('POST', `/workspaces/${wsId}/git/discard`, { path: f.path })); }}>
                  ↺
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && status.files.length > 0 && (
        <form className="form" onSubmit={commit}>
          <textarea required rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
          <button className="primary" disabled={busy || act.pending || !message.trim()}>Commit all changes</button>
        </form>
      )}

      {!readOnly && (
        <>
          <div className="form-row">
            <button disabled={busy || act.pending || protectedBranch} title={protectedBranch ? 'Create a feature branch first' : ''}
              onClick={() => void act.run('Push', () => api('POST', `/workspaces/${wsId}/git/push`))}>
              Push
            </button>
            <button disabled={busy || act.pending} onClick={() => void act.run('Pull', () => api('POST', `/workspaces/${wsId}/git/pull`))}>Pull</button>
            <button disabled={busy || act.pending || protectedBranch} onClick={() => setPr({ title: '', body: '' })}>Pull request</button>
          </div>
          {protectedBranch && <div className="muted" style={{ fontSize: 12.5 }}>You are on the default branch. Create a branch to push.</div>}
        </>
      )}

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

      <Section title="History">
        <History wsId={wsId} branch={status.branch} onOpen={(sha) => void openCommit.run(sha)} pending={openCommit.pending} />
        {openCommit.error && <div className="error">{openCommit.error}</div>}
      </Section>

      <Section title="Compare branches">
        <Compare wsId={wsId} current={status.branch} base={status.baseBranch} onResult={(detail) => setReview({ kind: 'compare', detail })} />
      </Section>

      <Section title="Pull requests">
        <PullRequests wsId={wsId} log={log} />
      </Section>

      <Branches wsId={wsId} current={status.branch} defaultBranch={status.defaultBranch} baseBranch={status.baseBranch} onChanged={onChanged} disabled={busy} readOnly={readOnly} log={log} />

      {!readOnly && (
        <Section title="Reset workspace">
          <Reset wsId={wsId} branch={status.branch} disabled={busy} log={log} onChanged={onChanged} />
        </Section>
      )}

      {review?.kind === 'commit' && (
        <DiffReview
          compact={compact}
          title={review.detail.subject || review.detail.sha.slice(0, 7)}
          subtitle={<><code>{review.detail.sha.slice(0, 10)}</code> · {review.detail.author} · {new Date(review.detail.date).toLocaleString()}{review.detail.body && <div className="review-body-text">{review.detail.body}</div>}</>}
          files={review.detail.files}
          truncated={review.detail.truncated}
          onClose={() => setReview(undefined)}
        />
      )}
      {review?.kind === 'compare' && (
        <DiffReview
          compact={compact}
          title={`${review.detail.head} compared with ${review.detail.base}`}
          subtitle={review.detail.mergeBase ? <>Changes since the branches forked at <code>{review.detail.mergeBase.slice(0, 7)}</code></> : 'The branches share no history'}
          files={review.detail.files}
          truncated={review.detail.truncated}
          commits={review.detail.commits}
          onOpenCommit={(sha) => void openCommit.run(sha)}
          onClose={() => setReview(undefined)}
        />
      )}
    </div>
  );
}

/** A collapsible section whose content mounts (and loads) only while open. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="branches" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{title}</summary>
      {open && <div className="stack" style={{ gap: 8, marginTop: 8 }}>{children}</div>}
    </details>
  );
}

function History({ wsId, branch, onOpen, pending }: { wsId: string; branch: string; onOpen(sha: string): void; pending: boolean }) {
  // Reload when the branch changes (the key in the path is ignored by the API).
  const log = useResource<CommitSummary[]>(`/workspaces/${wsId}/git/log?b=${encodeURIComponent(branch)}`);
  if (log.error) return <div className="error">{log.error.message}</div>;
  if (!log.data) return <div className="muted">Loading history…</div>;
  if (!log.data.length) return <div className="muted">No commits yet.</div>;
  return (
    <>
      <ul className="change-list history-list">
        {log.data.map((c) => (
          <li key={c.sha}>
            <button className="change-row history-row" disabled={pending} onClick={() => onOpen(c.sha)} title={`${c.author}, ${new Date(c.date).toLocaleString()}`}>
              <code className="muted">{c.sha.slice(0, 7)}</code>
              <span className="tree-name">{c.subject}</span>
              <span className="muted history-meta">{c.author}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="small" onClick={() => void log.reload()} disabled={log.loading}>Reload history</button>
    </>
  );
}

function Compare({ wsId, current, base, onResult }: { wsId: string; current: string; base: string; onResult(c: Comparison): void }) {
  const branches = useResource<BranchList>(`/workspaces/${wsId}/git/branches`);
  const all = branches.data ? [...branches.data.local, ...branches.data.remote.map((r) => `origin/${r}`)] : [];
  const [from, setFrom] = useState(base);
  const [to, setTo] = useState(current);
  const run = useAction(async () => {
    const q = new URLSearchParams({ base: from, head: to });
    onResult(await api<Comparison>('GET', `/workspaces/${wsId}/git/compare?${q}`));
  });
  const options = (selected: string) => {
    const list = all.includes(selected) || !selected ? all : [selected, ...all];
    return list.map((b) => <option key={b} value={b}>{b}</option>);
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void run.run(); }}>
      <div className="form-row">
        <label>Base<select value={from} onChange={(e) => setFrom(e.target.value)}>{options(from)}</select></label>
        <label>Compare<select value={to} onChange={(e) => setTo(e.target.value)}>{options(to)}</select></label>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>Shows what <code>{to}</code> changes since it branched off <code>{from}</code>. Fetch to see the latest remote branches.</div>
      <div><button className="small" disabled={run.pending || !from || !to || from === to}>{run.pending ? 'Comparing…' : 'Compare'}</button></div>
      {(run.error || branches.error) && <div className="error">{run.error ?? branches.error?.message}</div>}
    </form>
  );
}

function Reset({ wsId, branch, disabled, log, onChanged }: { wsId: string; branch: string; disabled: boolean; log(l: string): void; onChanged(): Promise<void> }) {
  const reset = useAction(async (to: 'head' | 'remote') => {
    log(`Reset ${to === 'head' ? 'to the last commit' : `to GitHub's ${branch}`}…`);
    await api('POST', `/workspaces/${wsId}/git/reset`, { to });
    log('Reset: done');
    await onChanged();
  });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Throws work away. Ignored files such as <code>node_modules</code> and <code>.env</code> are kept.
      </div>
      <div className="form-row">
        <button className="danger" disabled={disabled || reset.pending}
          onClick={() => { if (confirm('Discard ALL uncommitted changes, including new files? This cannot be undone.')) void reset.run('head'); }}>
          Discard all changes
        </button>
        <button className="danger" disabled={disabled || reset.pending}
          onClick={() => { if (confirm(`Reset ${branch} to GitHub's copy? Local commits that were not pushed and all uncommitted changes are lost.`)) void reset.run('remote'); }}>
          Reset to GitHub
        </button>
      </div>
      {reset.error && <div className="error">{reset.error}</div>}
    </div>
  );
}

const PROTECTED = new Set(['main', 'master', 'production', 'prod', 'release']);

function Branches({ wsId, current, defaultBranch, baseBranch, onChanged, disabled, readOnly, log }: {
  wsId: string; current: string; defaultBranch: string; baseBranch: string; onChanged(): Promise<void>; disabled: boolean; readOnly: boolean; log(l: string): void;
}) {
  const branches = useResource<BranchList>(`/workspaces/${wsId}/git/branches`);
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
  const remove = useAction(async (branch: string) => {
    const path = `/workspaces/${wsId}/git/branches/${branch.split('/').map(encodeURIComponent).join('/')}`;
    try {
      await api('DELETE', path);
    } catch (err) {
      // Unmerged work: ask again before throwing those commits away.
      if ((err as { status?: number }).status !== 409 || !confirm(`${(err as Error).message}\n\nDelete ${branch} anyway?`)) throw err;
      await api('DELETE', `${path}?force=true`);
    }
    log(`Deleted local branch ${branch}`);
    await branches.reload();
  });
  const all = branches.data ? Array.from(new Set([...branches.data.local, ...branches.data.remote])).sort() : [];
  const deletable = (b: string) =>
    !!branches.data?.local.includes(b) && b !== current && b !== defaultBranch && b !== baseBranch && !PROTECTED.has(b);

  return (
    <details className="branches">
      <summary>Branches</summary>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        {!readOnly && (
          <form className="form-row" onSubmit={(e) => { e.preventDefault(); void act.run(name.trim(), true); }}>
            <label>New branch from here<input value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/new-authentication" /></label>
            <button disabled={disabled || !name.trim() || act.pending}>Create</button>
          </form>
        )}
        <ul className="change-list">
          {all.map((b) => (
            <li key={b}>
              <button className="change-row" disabled={readOnly || b === current || disabled || act.pending} onClick={() => void act.run(b, false)}>
                <span className="tree-name">{b}</span>
                {b === current && <span className="badge ok">current</span>}
                {branches.data && !branches.data.local.includes(b) && <span className="badge">remote</span>}
              </button>
              {!readOnly && deletable(b) && (
                <button className="small danger" title={`Delete the local branch ${b} (GitHub keeps its copy)`} disabled={disabled || remove.pending}
                  onClick={() => { if (confirm(`Delete the local branch ${b}? The copy on GitHub, if any, is kept.`)) void remove.run(b); }}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        {!readOnly && <button className="small" disabled={fetchAll.pending} onClick={() => void fetchAll.run()}>Fetch from GitHub</button>}
        {(act.error || fetchAll.error || remove.error) && <div className="error">{act.error ?? fetchAll.error ?? remove.error}</div>}
      </div>
    </details>
  );
}
