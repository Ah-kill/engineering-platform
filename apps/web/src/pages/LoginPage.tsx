import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { useAction } from '../hooks';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction(login);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(email, password);
  };

  return (
    <div className="center">
      <div className="login">
        <form className="card form" onSubmit={submit}>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ margin: 0 }}>Engineering Platform</p>
          </div>
          <label>
            Email
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {action.error && <div className="error" role="alert">{action.error}</div>}
          <button className="primary" disabled={action.pending}>{action.pending ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}
