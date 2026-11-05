import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ClientRow } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';

export function ClientsPage() {
  const { me } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const clients = useResource<ClientRow[]>(`/clients?archived=${showArchived}`);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Clients</h1>
        {me?.user.isOrgAdmin && !creating && <button className="primary" onClick={() => setCreating(true)}>New client</button>}
      </div>

      {creating && <CreateClient onClose={() => setCreating(false)} />}

      <div className="card table-wrap">
        {clients.error && <div className="error">{clients.error.message}</div>}
        {clients.data && clients.data.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {showArchived
              ? 'No archived clients.'
              : me?.user.isOrgAdmin
                ? 'No clients yet. Create the first one.'
                : 'You have not been given access to any client yet. Ask an admin.'}
          </p>
        )}
        {clients.data && clients.data.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Description</th></tr></thead>
            <tbody>
              {clients.data.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/clients/${c.id}`}>{c.name}</Link></td>
                  <td className="mono muted">{c.slug}</td>
                  <td className="muted">{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <label className="checkbox muted">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>
    </div>
  );
}

function CreateClient({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const action = useAction(async () => {
    const created = await api<ClientRow>('POST', '/clients', { name, description });
    navigate(`/clients/${created.id}`);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>New client</h2>
      <label>Name<input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ABC Technologies" /></label>
      <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={action.pending}>Create client</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
