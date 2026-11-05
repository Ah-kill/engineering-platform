import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ApplicationRow, type ClientRow } from '../api';
import { useAction, useResource } from '../hooks';
import { Members } from '../components/Members';

export function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const client = useResource<ClientRow>(`/clients/${id}`);
  const apps = useResource<ApplicationRow[]>(`/clients/${id}/applications`);
  const [creating, setCreating] = useState(false);
  const perms = client.data?.permissions ?? [];

  const archive = useAction(async () => {
    const verb = client.data?.archivedAt ? 'unarchive' : 'archive';
    await api('POST', `/clients/${id}/${verb}`);
    await client.reload();
  });

  if (client.error) return <p className="error">{client.error.status === 404 ? 'Client not found.' : client.error.message}</p>;
  if (!client.data) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/clients">Clients</Link> /</div>
          <h1>
            {client.data.name} {client.data.archivedAt && <span className="badge">archived</span>}
          </h1>
          {client.data.description && <div className="muted">{client.data.description}</div>}
        </div>
        <div className="form-row">
          {perms.includes('application.create') && !client.data.archivedAt && !creating && (
            <button className="primary" onClick={() => setCreating(true)}>New application</button>
          )}
          {perms.includes('client.archive') && (
            <button onClick={() => void archive.run()} disabled={archive.pending}>
              {client.data.archivedAt ? 'Unarchive' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {creating && <CreateApplication clientId={id!} onClose={() => setCreating(false)} />}

      <div className="card table-wrap">
        <h2>Applications</h2>
        {apps.data?.length === 0 && <p className="muted" style={{ margin: 0 }}>No applications.</p>}
        {apps.data && apps.data.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Origin</th><th>Description</th></tr></thead>
            <tbody>
              {apps.data.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/applications/${a.id}`}>{a.name}</Link></td>
                  <td className="mono muted">{a.slug}</td>
                  <td><span className="badge">{a.origin === 'new' ? 'new build' : 'existing repo'}</span></td>
                  <td className="muted">{a.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {perms.includes('client.view') && (
        <Members scopeType="client" scopeId={id!} canManage={perms.includes('grant.manage')} allowCreatorRole />
      )}
    </div>
  );
}

function CreateApplication({ clientId, onClose }: { clientId: string; onClose(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState<'existing' | 'new'>('existing');
  const [defaults, setDefaults] = useState(true);
  const action = useAction(async () => {
    const created = await api<ApplicationRow>('POST', `/clients/${clientId}/applications`, {
      name, description, origin, createDefaultEnvironments: defaults,
    });
    navigate(`/applications/${created.id}`);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>New application</h2>
      <div className="form-row">
        <label>Name<input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Payment Service" /></label>
        <label>
          Starting point
          <select value={origin} onChange={(e) => setOrigin(e.target.value as 'existing' | 'new')}>
            <option value="existing">Existing repository</option>
            <option value="new">Build a new app from scratch</option>
          </select>
        </label>
      </div>
      <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="checkbox">
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.target.checked)} />
        Create development, staging and production environments (production is protected)
      </label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={action.pending}>Create application</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
