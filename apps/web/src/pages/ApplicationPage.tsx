import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ApplicationDetail, type EnvironmentRow } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';
import { Members } from '../components/Members';
import { RepositoryCard, WorkspacesCard } from '../components/RepoAndWorkspaces';
import { NetworkCard, VariablesCard } from '../components/VariablesAndNetwork';
import type { Repository } from '../api';

export function ApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const app = useResource<ApplicationDetail>(`/applications/${id}`);
  const [addingEnv, setAddingEnv] = useState(false);
  const [repo, setRepo] = useState<Repository | null>(null);

  const archive = useAction(async () => {
    await api('POST', `/applications/${id}/${app.data?.archivedAt ? 'unarchive' : 'archive'}`);
    await app.reload();
  });

  if (app.error) return <p className="error">{app.error.status === 404 ? 'Application not found.' : app.error.message}</p>;
  if (!app.data) return <p className="muted">Loading…</p>;
  const a = app.data;
  const perms = a.permissions;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link to="/clients">Clients</Link> / <Link to={`/clients/${a.clientId}`}>{a.clientName}</Link> /
          </div>
          <h1>
            {a.name}{' '}
            <span className="badge">{a.origin === 'new' ? 'new build' : 'existing repo'}</span>{' '}
            {a.archivedAt && <span className="badge">archived</span>}
          </h1>
          {a.description && <div className="muted">{a.description}</div>}
        </div>
        {perms.includes('application.archive') && (
          <button onClick={() => void archive.run()} disabled={archive.pending}>{a.archivedAt ? 'Unarchive' : 'Archive'}</button>
        )}
      </div>

      <div className="card table-wrap">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Environments</h2>
          {perms.includes('environment.manage') && !addingEnv && (
            <button className="small" onClick={() => setAddingEnv(true)}>Add environment</button>
          )}
        </div>
        {addingEnv && <AddEnvironment appId={a.id} onDone={async () => { setAddingEnv(false); await app.reload(); }} />}
        {a.environments.length === 0 && <p className="muted" style={{ margin: 0 }}>No environments you can see.</p>}
        {a.environments.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>AWS region</th><th>Your access</th><th /></tr></thead>
            <tbody>
              {a.environments.map((env) => (
                <EnvironmentRowView key={env.id} env={env} isOrgAdmin={!!me?.user.isOrgAdmin} onChanged={app.reload} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RepositoryCard appId={a.id} canEdit={perms.includes('application.update')} onChange={setRepo} />
      <WorkspacesCard appId={a.id} repo={repo} environments={a.environments} />
      <VariablesCard environments={a.environments} isOrgAdmin={!!me?.user.isOrgAdmin} />
      <NetworkCard appId={a.id} canEdit={perms.includes('application.update')} />

      {perms.includes('application.view') && (
        <Members
          scopeType="application"
          scopeId={a.id}
          canManage={perms.includes('grant.manage')}
          environments={a.environments}
          isOrgAdmin={me?.user.isOrgAdmin}
        />
      )}
    </div>
  );
}

function EnvironmentRowView({ env, isOrgAdmin, onChanged }: { env: EnvironmentRow; isOrgAdmin: boolean; onChanged(): Promise<void> }) {
  const toggle = useAction(async () => {
    await api('PATCH', `/environments/${env.id}`, { protected: !env.protected });
    await onChanged();
  });
  const canUse = env.permissions.includes('environment.use');
  return (
    <tr>
      <td className="mono">{env.name}</td>
      <td>{env.kind} {env.protected && <span className="badge warn">protected</span>}</td>
      <td className="mono muted">{env.awsRegion ?? '—'}</td>
      <td>{canUse ? <span className="badge ok">can work here</span> : <span className="badge">view only</span>}</td>
      <td style={{ textAlign: 'right' }}>
        {isOrgAdmin && (
          <button className="small" disabled={toggle.pending} onClick={() => void toggle.run()}>
            {env.protected ? 'Unprotect' : 'Protect'}
          </button>
        )}
        {toggle.error && <div className="error">{toggle.error}</div>}
      </td>
    </tr>
  );
}

function AddEnvironment({ appId, onDone }: { appId: string; onDone(): Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EnvironmentRow['kind']>('development');
  const [awsRegion, setAwsRegion] = useState('');
  const action = useAction(async () => {
    await api('POST', `/applications/${appId}/environments`, { name, kind, awsRegion: awsRegion || null });
    await onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  return (
    <form className="form" onSubmit={submit} style={{ marginBottom: 12 }}>
      <div className="form-row">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="qa" /></label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as EnvironmentRow['kind'])}>
            <option value="development">development</option>
            <option value="staging">staging</option>
            <option value="production">production (protected)</option>
          </select>
        </label>
        <label>AWS region<input value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="ap-south-1" /></label>
        <button className="primary" disabled={action.pending}>Add</button>
        <button type="button" onClick={() => void onDone()}>Cancel</button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
    </form>
  );
}
