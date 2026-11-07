import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ApplicationDetail, type EnvironmentRow, type GithubRepoSummary, type Repository, type SettingsWithGithub, type SharedWorkspace } from '../api';
import { useAction, useResource } from '../hooks';

export function RepositoryCard({ appId, canEdit, onChange }: { appId: string; canEdit: boolean; onChange(r: Repository | null): void }) {
  const repo = useResource<Repository | null>(`/applications/${appId}/repository`);
  const app = useResource<ApplicationDetail>(`/applications/${appId}`);
  const settings = useResource<SettingsWithGithub>(canEdit ? '/me/settings' : null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');

  useEffect(() => {
    if (repo.data !== undefined) onChange(repo.data);
  }, [repo.data, onChange]);

  const save = useAction(async () => {
    await api('PUT', `/applications/${appId}/repository`, { url, defaultBranch: branch || undefined });
    setEditing(false);
    await repo.reload();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run();
  };

  const tokens = settings.data?.githubTokens ?? [];
  const isNewApp = app.data?.origin === 'new';

  return (
    <div className="card stack">
      <div className="page-head" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Repository</h2>
        {canEdit && !editing && !creating && (
          <div className="form-row" style={{ gap: 6 }}>
            {repo.data === null && (
              <button className={`small${isNewApp ? ' primary' : ''}`} onClick={() => setCreating(true)}>Create a new GitHub repository</button>
            )}
            <button className="small" onClick={() => { setUrl(repo.data?.url ?? ''); setBranch(repo.data?.defaultBranch ?? ''); setEditing(true); }}>
              {repo.data ? 'Change' : 'Connect GitHub repository'}
            </button>
          </div>
        )}
      </div>
      {repo.data && !editing && (
        <div>
          <a href={repo.data.url} target="_blank" rel="noreferrer" className="mono">{repo.data.owner}/{repo.data.name}</a>
          <span className="muted"> · default branch </span><code>{repo.data.defaultBranch}</code>
        </div>
      )}
      {repo.data === null && !editing && !creating && (
        <p className="muted" style={{ margin: 0 }}>
          No repository connected yet.
          {canEdit && isNewApp && ' This app is built from scratch: create a new repository for it, or connect an existing one.'}
          {!canEdit && ' Ask an app admin to connect one.'}
        </p>
      )}
      {creating && (
        <CreateRepository
          appId={appId}
          defaultName={app.data?.slug ?? ''}
          defaultDescription={app.data?.description ?? ''}
          owners={tokens.map((t) => t.owner).filter((o): o is string => !!o)}
          hasToken={tokens.length > 0}
          onDone={async () => { setCreating(false); await repo.reload(); }}
          onCancel={() => setCreating(false)}
        />
      )}
      {editing && (
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label style={{ flex: '3 1 260px' }}>GitHub URL<input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/client/payment-service" /></label>
            <label>Default branch<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="auto-detect" /></label>
          </div>
          {settings.data && <RepoPicker
            tokens={tokens.map((t) => t.owner)}
            onPick={(r) => { setUrl(`https://github.com/${r.fullName}`); setBranch(r.defaultBranch); }}
          />}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>With a GitHub token for the repository's owner saved in Settings, access and the default branch are checked automatically.</p>
          {save.error && <div className="error">{save.error}</div>}
          <div className="form-row">
            <button className="primary" disabled={save.pending}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Searchable list of the repositories the caller's GitHub tokens can reach. Typing a URL above still works. */
function RepoPicker({ tokens, onPick }: { tokens: (string | null)[]; onPick(r: GithubRepoSummary): void }) {
  const owners = tokens.filter((o): o is string => !!o);
  const hasDefault = tokens.includes(null);
  // With only owner tokens, start on the first owner; the default token can list everything.
  const [owner, setOwner] = useState<string>(hasDefault || !owners[0] ? '' : owners[0]);
  const [filter, setFilter] = useState('');
  const path = tokens.length ? `/me/github/repos${owner ? `?owner=${encodeURIComponent(owner)}` : ''}` : null;
  const repos = useResource<{ repos: GithubRepoSummary[]; truncated: boolean }>(path);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = repos.data?.repos ?? [];
    return (f ? list.filter((r) => r.fullName.toLowerCase().includes(f) || r.description.toLowerCase().includes(f)) : list).slice(0, 100);
  }, [repos.data, filter]);

  if (!tokens.length) {
    return <p className="muted" style={{ margin: 0, fontSize: 13 }}>Save a GitHub token in Settings to pick from your repositories.</p>;
  }
  return (
    <div className="repo-picker">
      <div className="form-row">
        {(owners.length > 0) && (
          <label style={{ flex: '1 1 140px' }}>
            Owner
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {hasDefault && <option value="">All my repositories</option>}
              {owners.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        )}
        <label style={{ flex: '2 1 200px' }}>
          Find a repository
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter" autoComplete="off" />
        </label>
      </div>
      {repos.loading && !repos.data && <p className="muted" style={{ margin: 0 }}>Loading repositories from GitHub…</p>}
      {repos.error && <div className="error">{repos.error.message}</div>}
      {repos.data && (
        <ul className="repo-list" aria-label="Your GitHub repositories">
          {shown.map((r) => (
            <li key={r.fullName}>
              <button type="button" className="repo-row" onClick={() => onPick(r)}>
                <span className="mono repo-name">{r.fullName}</span>
                {r.private && <span className="badge">private</span>}
                {r.description && <span className="muted repo-desc">{r.description}</span>}
              </button>
            </li>
          ))}
          {!shown.length && <li className="muted" style={{ padding: 8 }}>No matching repositories.</li>}
        </ul>
      )}
      {repos.data?.truncated && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Showing the 300 most recently updated repositories. Type the URL above if yours is missing.</p>}
    </div>
  );
}

function CreateRepository(props: {
  appId: string;
  defaultName: string;
  defaultDescription: string;
  owners: string[];
  hasToken: boolean;
  onDone(): Promise<void>;
  onCancel(): void;
}) {
  const [owner, setOwner] = useState(props.owners[0] ?? '');
  const [name, setName] = useState(props.defaultName);
  const [description, setDescription] = useState(props.defaultDescription);
  const [isPrivate, setPrivate] = useState(true);
  const create = useAction(async () => {
    await api('POST', `/applications/${props.appId}/repository/create`, { owner: owner.trim(), name: name.trim(), description, private: isPrivate });
    await props.onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run();
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="form-row">
        <label>
          Organization or user
          <input required list="repo-owners" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="client-org" autoComplete="off" spellCheck={false} />
          <datalist id="repo-owners">{props.owners.map((o) => <option key={o} value={o} />)}</datalist>
        </label>
        <label>
          Repository name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="payment-service" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></label>
      <label className="checkbox"><input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private repository</label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Created on GitHub with a README so the default branch exists, using your token for that owner
        (it needs <b>Administration: read and write</b>), then connected to this application.
        {!props.hasToken && <> You have no GitHub token yet: add one in <Link to="/settings">Settings</Link>.</>}
      </p>
      {create.error && <div className="error">{create.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={create.pending}>{create.pending ? 'Creating…' : 'Create repository'}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function WorkspacesCard({ appId, repo, environments }: { appId: string; repo: Repository | null; environments: EnvironmentRow[] }) {
  const navigate = useNavigate();
  const workspaces = useResource<SharedWorkspace[]>(`/applications/${appId}/workspaces`);
  const usable = environments.filter((e) => e.permissions.includes('environment.use'));
  const [creating, setCreating] = useState(false);
  const [envId, setEnvId] = useState('');
  const [branch, setBranch] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [base, setBase] = useState('');

  useEffect(() => {
    if (!envId && usable[0]) setEnvId(usable[0].id);
  }, [usable, envId]);

  const remove = useAction(async (w: SharedWorkspace) => {
    await api('DELETE', `/workspaces/${w.id}`);
    await workspaces.reload();
  });

  const create = useAction(async () => {
    const r = await api<{ id: string }>('POST', `/applications/${appId}/workspaces`, {
      environmentId: envId, branch, createBranch: mode === 'new', baseBranch: base || undefined,
    });
    navigate(`/workspaces/${r.id}`);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run();
  };

  return (
    <div className="card stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>My workspaces</h2>
        {repo && usable.length > 0 && !creating && <button className="primary small" onClick={() => setCreating(true)}>New workspace</button>}
      </div>
      {!repo && <p className="muted" style={{ margin: 0 }}>Connect a repository first.</p>}
      {repo && usable.length === 0 && <p className="muted" style={{ margin: 0 }}>You don't have working access to any environment of this application.</p>}

      {creating && (
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Environment
              <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                {usable.map((e) => <option key={e.id} value={e.id}>{e.name}{e.protected ? ' (protected)' : ''}</option>)}
              </select>
            </label>
            <label>
              Branch
              <select value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'existing')}>
                <option value="new">Create a new branch</option>
                <option value="existing">Use an existing branch</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>{mode === 'new' ? 'New branch name' : 'Existing branch name'}
              <input required value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/payment-retry" />
            </label>
            {mode === 'new' && (
              <label>From<input value={base} onChange={(e) => setBase(e.target.value)} placeholder={repo?.defaultBranch} /></label>
            )}
          </div>
          {create.error && <div className="error">{create.error}</div>}
          <div className="form-row">
            <button className="primary" disabled={create.pending}>Create and open</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      {remove.error && <div className="error">{remove.error}</div>}
      {workspaces.data && workspaces.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Environment</th><th>State</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {workspaces.data.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link to={`/workspaces/${w.id}`} className="mono">{w.branch}</Link>
                    {w.access && w.access !== 'owner' && (
                      <div className="muted" style={{ fontSize: 12 }}>Shared by {w.ownerName} · {w.access === 'viewer' ? 'can view' : 'can edit'}</div>
                    )}
                  </td>
                  <td>{w.environmentName}</td>
                  <td>{w.state === 'ready' ? <span className="badge ok">ready</span> : <span className={`badge${w.state === 'failed' ? ' warn' : ''}`}>{w.state}</span>}</td>
                  <td className="muted">{new Date(w.lastActiveAt).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(!w.access || w.access === 'owner') && (
                      <button className="small danger" aria-label={`Delete workspace ${w.branch}`} disabled={remove.pending}
                        onClick={() => { if (confirm(`Delete workspace ${w.branch}? Unpushed work is lost.`)) void remove.run(w); }}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
