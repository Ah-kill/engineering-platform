import { useState, type FormEvent } from 'react';
import { api, type UserRow } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';

export function UsersPage() {
  const { me } = useAuth();
  const users = useResource<UserRow[]>(me?.user.isOrgAdmin ? '/users' : null);
  const [creating, setCreating] = useState(false);

  const update = useAction(async (id: string, patch: Partial<Pick<UserRow, 'status' | 'isOrgAdmin'>>) => {
    await api('PATCH', `/users/${id}`, patch);
    await users.reload();
  });

  if (!me?.user.isOrgAdmin) return <p className="muted">Only org admins can manage developers.</p>;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Developers</h1>
        {!creating && <button className="primary" onClick={() => setCreating(true)}>Add developer</button>}
      </div>
      {creating && <CreateUser onDone={async () => { setCreating(false); await users.reload(); }} />}
      <div className="card table-wrap">
        {users.error && <div className="error">{users.error.message}</div>}
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td className="muted">{u.email}</td>
                <td>{u.isOrgAdmin ? <span className="badge warn">org admin</span> : 'developer'}</td>
                <td>{u.status === 'active' ? <span className="badge ok">active</span> : <span className="badge">disabled</span>}</td>
                <td className="muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {u.id !== me.user.id && (
                    <>
                      <button className="small" disabled={update.pending} onClick={() => void update.run(u.id, { isOrgAdmin: !u.isOrgAdmin })}>
                        {u.isOrgAdmin ? 'Remove admin' : 'Make admin'}
                      </button>{' '}
                      <button className="small danger" disabled={update.pending}
                        onClick={() => void update.run(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}>
                        {u.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {update.error && <div className="error">{update.error}</div>}
      </div>
      <p className="muted">
        New developers start with no access. Grant them access on a client or application page.
      </p>
    </div>
  );
}

function CreateUser({ onDone }: { onDone(): Promise<void> }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isOrgAdmin, setIsOrgAdmin] = useState(false);
  const action = useAction(async () => {
    await api('POST', '/users', { email, displayName, password, isOrgAdmin });
    await onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>Add developer</h2>
      <div className="form-row">
        <label>Name<input required autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>
          Initial password
          <input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={isOrgAdmin} onChange={(e) => setIsOrgAdmin(e.target.checked)} />
        Org admin (manages clients, developers and access; no automatic access to environments)
      </label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={action.pending}>Add developer</button>
        <button type="button" onClick={() => void onDone()}>Cancel</button>
      </div>
    </form>
  );
}
