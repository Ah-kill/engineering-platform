import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction } from '../hooks';

export function AccountPage() {
  const { me } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [saved, setSaved] = useState(false);
  const action = useAction(async () => {
    await api('POST', '/auth/password', { currentPassword, newPassword });
    setCurrent('');
    setNew('');
    setSaved(true);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void action.run();
  };

  return (
    <div className="stack" style={{ maxWidth: 480 }}>
      <div className="page-head"><h1>Account</h1></div>
      <div className="card">
        <div>{me?.user.displayName}</div>
        <div className="muted">{me?.user.email}</div>
      </div>
      <form className="card form" onSubmit={submit}>
        <h2>Change password</h2>
        <label>Current password<input type="password" required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New password (12+ characters)<input type="password" required minLength={12} autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></label>
        {action.error && <div className="error">{action.error}</div>}
        {saved && <div className="badge ok">Password changed. Other devices were signed out.</div>}
        <button className="primary" disabled={action.pending}>Change password</button>
      </form>
    </div>
  );
}
