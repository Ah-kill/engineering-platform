import { useState, type FormEvent } from 'react';
import { api, type AgentSettings, type CredentialKind, type ModelOption, type SettingsWithGithub } from '../api';
import { GithubTokens } from '../components/GithubTokens';
import { useAction, useResource } from '../hooks';

interface ModelsResponse { models: ModelOption[]; fetchedAt: string; errors: string[] }
interface Versions { sdk: string; claudeCode: string; latestSdk: string | null; updateAvailable: boolean }

export function SettingsPage() {
  const settings = useResource<SettingsWithGithub>('/me/settings');
  const versions = useResource<Versions>('/system/claude-code');

  if (settings.error) return <p className="error">{settings.error.message}</p>;
  if (!settings.data) return <p className="muted">Loading…</p>;
  const s = settings.data;

  const save = async (patch: Partial<Pick<AgentSettings, 'authMode' | 'defaultModel'>>) => {
    await api('PUT', '/me/settings', patch);
    await settings.reload();
  };

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="page-head"><h1>Settings</h1></div>

      <section className="card stack">
        <div>
          <h2 style={{ marginBottom: 4 }}>How Claude signs in</h2>
          <p className="muted" style={{ margin: 0 }}>Your credentials are encrypted and used only for your own workspaces. They are never shown again after saving.</p>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Sign-in method">
          <button role="radio" aria-checked={s.authMode === 'api_key'} className={s.authMode === 'api_key' ? 'on' : ''} onClick={() => void save({ authMode: 'api_key' })}>
            API key
          </button>
          <button role="radio" aria-checked={s.authMode === 'subscription'} className={s.authMode === 'subscription' ? 'on' : ''} onClick={() => void save({ authMode: 'subscription' })}>
            Claude subscription
          </button>
        </div>

        {s.authMode === 'api_key' ? (
          <CredentialField
            kind="anthropic_api_key"
            label="Anthropic API key"
            placeholder="sk-ant-api03-…"
            state={s.credentials.anthropic_api_key}
            onChange={settings.reload}
            help={<>Create one at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">platform.claude.com → API keys</a>. Billed per use to that account.</>}
          />
        ) : (
          <CredentialField
            kind="claude_oauth_token"
            label="Claude subscription token"
            placeholder="sk-ant-oat01-…"
            state={s.credentials.claude_oauth_token}
            onChange={settings.reload}
            help={
              <div className="stack" style={{ gap: 6 }}>
                <span>Uses your Pro, Max, Team or Enterprise plan. On your own computer, in a terminal:</span>
                <pre className="code-block">claude setup-token</pre>
                <span>
                  It opens the same Claude sign-in page as <code>/login</code>. Approve it, copy the token it prints (valid for one year) and paste it here.
                </span>
                <span className="badge warn" style={{ justifySelf: 'start' }}>
                  Check with Anthropic that using your subscription through this internal tool is allowed for you.
                </span>
              </div>
            }
          />
        )}
      </section>

      <ModelPicker current={s.defaultModel} onSave={(m) => save({ defaultModel: m })} authMode={s.authMode} />

      <section className="card stack">
        <div>
          <h2 style={{ marginBottom: 4 }}>GitHub</h2>
          <p className="muted" style={{ margin: 0 }}>Used to clone, push, list repositories and open or merge pull requests as you.</p>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained token</a> for each client organization you work in
          (fine-grained tokens belong to one owner), with <b>Contents: read and write</b> and <b>Pull requests: read and write</b>, and an expiry date.
          To create repositories from the platform, the token also needs <b>Administration: read and write</b>.
          The platform picks the token for the repository's owner and falls back to your default token.
        </p>
        <GithubTokens tokens={s.githubTokens ?? []} onChange={settings.reload} />
      </section>

      {versions.data && (
        <section className="card">
          <h2>Claude Code</h2>
          <div className="muted">
            Version {versions.data.claudeCode} (SDK {versions.data.sdk}).{' '}
            {versions.data.updateAvailable ? (
              <span className="badge warn">Update available: SDK {versions.data.latestSdk}. Run <code>npm run update:claude</code> on the server.</span>
            ) : versions.data.latestSdk ? (
              <span className="badge ok">Up to date</span>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

function CredentialField(props: {
  kind: CredentialKind;
  label: string;
  placeholder: string;
  state: { saved: boolean; hint?: string; updatedAt?: string };
  help: React.ReactNode;
  onChange(): Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!props.state.saved);
  const save = useAction(async () => {
    await api('PUT', `/me/credentials/${props.kind}`, { value });
    setValue('');
    setEditing(false);
    await props.onChange();
  });
  const remove = useAction(async () => {
    await api('DELETE', `/me/credentials/${props.kind}`);
    setEditing(true);
    await props.onChange();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run();
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="muted" style={{ fontSize: 13 }}>{props.help}</div>
      {props.state.saved && !editing ? (
        <div className="form-row" style={{ alignItems: 'center' }}>
          <span className="badge ok">Saved {props.state.hint}</span>
          <button className="small" onClick={() => setEditing(true)}>Replace</button>
          <button className="small danger" disabled={remove.pending} onClick={() => void remove.run()}>Remove</button>
        </div>
      ) : (
        <form className="form-row" onSubmit={submit}>
          <label>
            {props.label}
            <input type="password" autoComplete="off" spellCheck={false} required value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} />
          </label>
          <button className="primary" disabled={save.pending}>Save</button>
          {props.state.saved && <button type="button" onClick={() => setEditing(false)}>Cancel</button>}
        </form>
      )}
      {(save.error || remove.error) && <div className="error">{save.error ?? remove.error}</div>}
    </div>
  );
}

function ModelPicker({ current, onSave, authMode }: { current: string; onSave(m: string): Promise<void>; authMode: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const models = useResource<ModelsResponse>(`/models?refresh=${refreshKey > 0}&k=${refreshKey}&m=${authMode}`);
  const [custom, setCustom] = useState('');
  const known = models.data?.models ?? [];
  const isKnown = known.some((m) => m.id === current);

  return (
    <section className="card stack">
      <div>
        <h2 style={{ marginBottom: 4 }}>Default model</h2>
        <p className="muted" style={{ margin: 0 }}>
          Fetched live from Claude Code and your account, so new models appear automatically. Aliases like “Default”, “Opus” and “Sonnet” always use the newest version. You can also switch model per message in the workspace.
        </p>
      </div>
      {models.loading && !models.data && <p className="muted">Asking Claude Code which models you can use…</p>}
      {models.data && (
        <div className="model-list">
          {known.map((m) => (
            <label key={m.id} className={`model-option${m.id === current ? ' on' : ''}`}>
              <input type="radio" name="model" checked={m.id === current} onChange={() => void onSave(m.id)} />
              <span>
                <b>{m.label}</b> <code className="muted">{m.id}</code>
                {m.resolvedModel && m.resolvedModel !== m.id && <span className="muted"> → {m.resolvedModel}</span>}
                {m.description && <div className="muted" style={{ fontSize: 12.5 }}>{m.description}</div>}
              </span>
            </label>
          ))}
          {!isKnown && <div className="badge">Current: <code>{current}</code></div>}
        </div>
      )}
      {models.data?.errors.map((e) => <div key={e} className="error">{e}</div>)}
      <div className="form-row">
        <label>
          Or enter a model id
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. claude-opus-5-5" />
        </label>
        <button disabled={!custom.trim()} onClick={() => void onSave(custom.trim()).then(() => setCustom(''))}>Use</button>
        <button onClick={() => setRefreshKey((k) => k + 1)} disabled={models.loading}>Refresh list</button>
      </div>
    </section>
  );
}
