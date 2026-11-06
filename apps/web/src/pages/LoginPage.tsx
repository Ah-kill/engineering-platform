import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { useAction } from '../hooks';

export function LoginPage() {
  const { login, loginWithCode } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** Set when the password was right and two-step login needs a code. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>();

  const action = useAction(async () => {
    setNotice(undefined);
    const result = await login(email, password);
    if (!result.done) {
      setPassword('');
      setChallenge(result.challenge);
    }
  });

  const restart = (message?: string) => {
    setChallenge(null);
    setNotice(message);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };

  if (challenge) {
    return (
      <CodeStep
        onSubmit={async (code) => {
          try {
            await loginWithCode(challenge, code);
          } catch (err) {
            // Too many attempts or too slow: the password step has to be done again.
            if (err instanceof ApiError && err.code === 'mfa_expired') restart(err.message);
            else throw err;
          }
        }}
        onBack={() => restart()}
      />
    );
  }

  return (
    <div className="center">
      <div className="login">
        <form className="card form" onSubmit={submit}>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ margin: 0 }}>Engineering Platform</p>
          </div>
          {notice && <div className="error" role="alert">{notice}</div>}
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

/** Second step: a code from the authenticator app, or a recovery code. */
function CodeStep({ onSubmit, onBack }: { onSubmit(code: string): Promise<void>; onBack(): void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const action = useAction(onSubmit);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(code.trim());
  };
  const toggle = () => {
    setUseRecovery(!useRecovery);
    setCode('');
    action.clearError();
  };

  return (
    <div className="center">
      <div className="login">
        <form className="card form" onSubmit={submit}>
          <div>
            <h1>Two-step login</h1>
            <p className="muted" style={{ margin: 0 }}>
              {useRecovery
                ? 'Enter one of the recovery codes you saved. Each code works once.'
                : 'Enter the 6-digit code from your authenticator app.'}
            </p>
          </div>
          {useRecovery ? (
            <label>
              Recovery code
              <input
                key="recovery" required autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false}
                className="mono" placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={64}
                value={code} onChange={(e) => setCode(e.target.value)}
              />
            </label>
          ) : (
            <label>
              Authentication code
              <input
                key="totp" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}"
                className="mfa-code-input" placeholder="123456" maxLength={7}
                value={code} onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}
          {action.error && <div className="error" role="alert">{action.error}</div>}
          <button className="primary" disabled={action.pending}>{action.pending ? 'Checking…' : 'Verify'}</button>
          <div className="mfa-links">
            <button type="button" className="mfa-link" onClick={toggle}>
              {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code'}
            </button>
            <button type="button" className="mfa-link" onClick={onBack}>Back to sign in</button>
          </div>
        </form>
      </div>
    </div>
  );
}
