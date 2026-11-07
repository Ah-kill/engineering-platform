import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';

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
      <TwoStepLogin />
      <SignedInDevices />
    </div>
  );
}

interface MfaStatus { enabled: boolean; recoveryCodesLeft: number }
interface MfaSetup { otpauthUrl: string; qrDataUrl: string; secret: string }

/** Authenticator-app sign-in: set up, recovery codes, turn off. */
function TwoStepLogin() {
  const status = useResource<MfaStatus>('/me/mfa');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  /** Shown once, right after they are created. */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | undefined>();

  const start = useAction(async () => {
    setNotice(undefined);
    setSetup(await api<MfaSetup>('POST', '/me/mfa/setup'));
  });

  if (status.loading && !status.data) return <div className="card muted">Loading two-step login…</div>;
  if (status.error) return <div className="card error">{status.error.message}</div>;
  const enabled = status.data?.enabled ?? false;
  const left = status.data?.recoveryCodesLeft ?? 0;

  return (
    <section className="card form">
      <div className="mfa-head">
        <h2>Two-step login</h2>
        {enabled ? <span className="badge ok">On</span> : <span className="badge">Off</span>}
      </div>

      {recoveryCodes && <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />}
      {notice && <div className="badge ok mfa-notice">{notice}</div>}

      {!enabled && !setup && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            After your password, sign-in also asks for a 6-digit code from an authenticator app on your phone
            (Google Authenticator, Microsoft Authenticator, 1Password and similar).
          </p>
          {start.error && <div className="error">{start.error}</div>}
          <div><button className="primary" disabled={start.pending} onClick={() => void start.run()}>Set up two-step login</button></div>
        </>
      )}

      {!enabled && setup && (
        <EnableForm
          setup={setup}
          onCancel={() => setSetup(null)}
          onEnabled={async (codes) => {
            setSetup(null);
            setRecoveryCodes(codes);
            setNotice('Two-step login is on. Other devices were signed out.');
            await status.reload();
          }}
        />
      )}

      {enabled && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {left} of 10 recovery codes left.{left <= 3 && ' Make new ones before you run out.'}
          </p>
          <RegenerateForm onDone={async (codes) => { setNotice(undefined); setRecoveryCodes(codes); await status.reload(); }} />
          <DisableForm onDone={async () => { setRecoveryCodes(null); setNotice('Two-step login is off.'); await status.reload(); }} />
        </>
      )}
    </section>
  );
}

function EnableForm({ setup, onCancel, onEnabled }: { setup: MfaSetup; onCancel(): void; onEnabled(codes: string[]): Promise<void> }) {
  const [code, setCode] = useState('');
  const action = useAction(async () => {
    const res = await api<{ recoveryCodes: string[] }>('POST', '/me/mfa/enable', { code: code.trim() });
    await onEnabled(res.recoveryCodes);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  return (
    <form className="form" onSubmit={submit}>
      <div>1. Scan this QR code with your authenticator app.</div>
      <img className="mfa-qr" src={setup.qrDataUrl} width={200} height={200} alt="QR code to add this account to an authenticator app" />
      <div className="muted mfa-manual">
        Can’t scan it? Add the account by hand with this key (time-based):
        <code className="mfa-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
      </div>
      <div>2. Enter the 6-digit code the app shows.</div>
      <label>
        Code from the app
        <input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7}
          className="mfa-code-input" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={action.pending}>Turn on</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mfa-recovery" role="region" aria-label="Recovery codes">
      <strong>Save your recovery codes</strong>
      <p className="muted" style={{ margin: 0 }}>
        If you lose your phone, each of these codes signs you in once. They are shown only now:
        keep them somewhere safe, such as a password manager.
      </p>
      <ul className="mfa-code-list">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="form-row">
        <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy codes'}</button>
        <button type="button" className="primary" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  );
}

function RegenerateForm({ onDone }: { onDone(codes: string[]): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const action = useAction(async () => {
    const res = await api<{ recoveryCodes: string[] }>('POST', '/me/mfa/recovery-codes', { code: code.trim() });
    setCode('');
    setOpen(false);
    await onDone(res.recoveryCodes);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  if (!open) return <div><button type="button" onClick={() => setOpen(true)}>Make new recovery codes</button></div>;
  return (
    <form className="form mfa-sub" onSubmit={submit}>
      <strong>New recovery codes</strong>
      <span className="muted">Your current recovery codes stop working.</span>
      <label>
        Code from your authenticator app
        <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={64}
          className="mfa-code-input" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={action.pending}>Make new codes</button>
        <button type="button" onClick={() => { setOpen(false); action.clearError(); }}>Cancel</button>
      </div>
    </form>
  );
}

function DisableForm({ onDone }: { onDone(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const action = useAction(async () => {
    await api('POST', '/me/mfa/disable', { password, code: code.trim() });
    setPassword('');
    setCode('');
    setOpen(false);
    await onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };
  if (!open) return <div><button type="button" className="danger" onClick={() => setOpen(true)}>Turn off two-step login</button></div>;
  return (
    <form className="form mfa-sub" onSubmit={submit}>
      <strong>Turn off two-step login</strong>
      <span className="muted">Sign-in will need only your password.</span>
      <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label>
        Code from your authenticator app, or a recovery code
        <input required autoComplete="one-time-code" maxLength={64} className="mfa-code-input"
          value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-row">
        <button className="danger" disabled={action.pending}>Turn off</button>
        <button type="button" onClick={() => { setOpen(false); action.clearError(); }}>Cancel</button>
      </div>
    </form>
  );
}

// ---- signed-in devices ----------------------------------------------------------

interface SignedInSession {
  id: string; createdAt: string; lastUsedAt: string; expiresAt: string;
  ip: string | null; userAgent: string | null; current: boolean;
}

/** "Chrome on Windows" from a user-agent string; good enough to recognise a device. */
function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|node|undici|lightMyRequest/i.test(ua) ? 'Script'
    : 'Browser';
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The user's own active sessions, with sign-out per device and everywhere else. */
function SignedInDevices() {
  const { refresh } = useAuth();
  const sessions = useResource<SignedInSession[]>('/me/sessions');
  const [notice, setNotice] = useState<string | undefined>();

  const revoke = useAction(async (s: SignedInSession) => {
    setNotice(undefined);
    const res = await api<{ signedOut: boolean }>('DELETE', `/me/sessions/${s.id}`);
    if (res.signedOut) {
      await refresh(); // this device is signed out: back to the sign-in page
      return;
    }
    setNotice(`Signed out ${deviceName(s.userAgent)}.`);
    await sessions.reload();
  });
  const revokeOthers = useAction(async () => {
    setNotice(undefined);
    const res = await api<{ revoked: number }>('POST', '/me/sessions/revoke-others');
    setNotice(res.revoked === 1 ? 'Signed out 1 other device.' : `Signed out ${res.revoked} other devices.`);
    await sessions.reload();
  });

  const list = sessions.data ?? [];
  const others = list.filter((s) => !s.current).length;
  const error = sessions.error?.message ?? revoke.error ?? revokeOthers.error;

  return (
    <section className="card form" aria-labelledby="devices-title">
      <h2 id="devices-title" style={{ margin: 0 }}>Signed-in devices</h2>
      <p className="muted" style={{ margin: 0 }}>
        Where your account is signed in now. Sign out anything you do not recognise, then change your password.
      </p>
      {notice && <div className="badge ok mfa-notice" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {sessions.loading && !sessions.data && <div className="muted">Loading…</div>}
      <ul className="device-list">
        {list.map((s) => (
          <li key={s.id} className="device">
            <div className="device-info">
              <div className="device-name">
                {deviceName(s.userAgent)}
                {s.current && <span className="badge ok">This device</span>}
              </div>
              <div className="muted device-meta">
                {s.ip ? `${s.ip} · ` : ''}signed in {new Date(s.createdAt).toLocaleString()}
                {s.lastUsedAt !== s.createdAt && <> · last used {new Date(s.lastUsedAt).toLocaleString()}</>}
              </div>
            </div>
            <button
              type="button"
              className={s.current ? 'small' : 'small danger'}
              disabled={revoke.pending}
              aria-label={s.current ? 'Sign out this device' : `Sign out ${deviceName(s.userAgent)}, signed in ${new Date(s.createdAt).toLocaleString()}`}
              onClick={() => void revoke.run(s)}
            >
              Sign out
            </button>
          </li>
        ))}
      </ul>
      {others > 0 && (
        <div>
          <button type="button" className="danger" disabled={revokeOthers.pending} onClick={() => void revokeOthers.run()}>
            Sign out all other devices
          </button>
        </div>
      )}
    </section>
  );
}
