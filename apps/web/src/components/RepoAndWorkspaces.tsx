import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type EnvironmentRow, type Repository, type Workspace } from '../api';
import { useAction, useResource } from '../hooks';

export function RepositoryCard({ appId, canEdit, onChange }: { appId: string; canEdit: boolean; onChange(r: Repository | null): void }) {
  const repo = useResource<Repository | null>(`/applications/${appId}/repository`);
  const [editing, setEditing] = useState(false);
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

  return (
    <div className="card stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>Repository</h2>
        {canEdit && !editing && (
          <button className="small" onClick={() => { setUrl(repo.data?.url ?? ''); setBranch(repo.data?.defaultBranch ?? ''); setEditing(true); }}>
            {repo.data ? 'Change' : 'Connect GitHub repository'}
          </button>
        )}
      </div>
      {repo.data && !editing && (
        <div>
          <a href={repo.data.url} target="_blank" rel="noreferrer" className="mono">{repo.data.owner}/{repo.data.name}</a>
          <span className="muted"> · default branch </span><code>{repo.data.defaultBranch}</code>
        </div>
      )}
      {repo.data === null && !editing && <p className="muted" style={{ margin: 0 }}>No repository connected yet.{!canEdit && ' Ask an app admin to connect one.'}</p>}
      {editing && (
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label style={{ flex: '3 1 260px' }}>GitHub URL<input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/client/payment-service" /></label>
            <label>Default branch<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="auto-detect" /></label>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>With your GitHub token saved in Settings, access and the default branch are checked automatically.</p>
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

export function WorkspacesCard({ appId, repo, environments }: { appId: string; repo: Repository | null; environments: EnvironmentRow[] }) {
  const navigate = useNavigate();
  const workspaces = useResource<Workspace[]>(`/applications/${appId}/workspaces`);
  const usable = environments.filter((e) => e.permissions.includes('environment.use'));
  const [creating, setCreating] = useState(false);
  const [envId, setEnvId] = useState('');
  const [branch, setBranch] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [base, setBase] = useState('');

  useEffect(() => {
    if (!envId && usable[0]) setEnvId(usable[0].id);
  }, [usable, envId]);

  const remove = useAction(async (w: Workspace) => {
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
                  <td><Link to={`/workspaces/${w.id}`} className="mono">{w.branch}</Link></td>
                  <td>{w.environmentName}</td>
                  <td>{w.state === 'ready' ? <span className="badge ok">ready</span> : <span className={`badge${w.state === 'failed' ? ' warn' : ''}`}>{w.state}</span>}</td>
                  <td className="muted">{new Date(w.lastActiveAt).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="small danger" aria-label={`Delete workspace ${w.branch}`} disabled={remove.pending}
                      onClick={() => { if (confirm(`Delete workspace ${w.branch}? Unpushed work is lost.`)) void remove.run(w); }}>
                      Delete
                    </button>
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
