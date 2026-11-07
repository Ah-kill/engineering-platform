import { useState, type FormEvent } from 'react';
import { api, type GithubTokenInfo } from '../api';
import { useAction } from '../hooks';

/**
 * GitHub tokens, one per GitHub owner (organization or user). Fine-grained tokens are scoped
 * to one owner, so a developer working for several clients saves one per client organization.
 * The default token (no owner) is used for every owner without its own.
 */
export function GithubTokens({ tokens, onChange }: { tokens: GithubTokenInfo[]; onChange(): Promise<void> }) {
  const [adding, setAdding] = useState(tokens.length === 0);
  const [replacing, setReplacing] = useState<string | null | undefined>(undefined);

  const remove = useAction(async (owner: string | null) => {
    await api('DELETE', `/me/credentials/github_token${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`);
    await onChange();
  });

  return (
    <div className="stack" style={{ gap: 10 }}>
      {tokens.length > 0 && (
        <ul className="gh-token-list">
          {tokens.map((t) => (
            <li key={t.owner ?? ''} className="gh-token">
              <div className="gh-token-main">
                <b>{t.owner ?? 'Default'}</b>
                <span className="muted gh-token-scope">{t.owner ? `repositories owned by ${t.owner}` : 'any owner without its own token'}</span>
              </div>
              <span className="badge ok">Token {t.hint}</span>
              <span className="gh-token-actions">
                <button className="small" onClick={() => setReplacing(t.owner)}>Replace</button>
                <button className="small danger" disabled={remove.pending}
                  onClick={() => { if (confirm(`Remove the GitHub token for ${t.owner ?? 'the default owner'}?`)) void remove.run(t.owner); }}>
                  Remove
                </button>
              </span>
              {replacing === t.owner && (
                <TokenForm fixedOwner={t.owner} onDone={async () => { setReplacing(undefined); await onChange(); }} onCancel={() => setReplacing(undefined)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.error && <div className="error">{remove.error}</div>}
      {adding ? (
        <TokenForm
          onDone={async () => { setAdding(false); await onChange(); }}
          onCancel={tokens.length ? () => setAdding(false) : undefined}
        />
      ) : (
        <div><button className="small" onClick={() => setAdding(true)}>Add a GitHub token</button></div>
      )}
    </div>
  );
}

function TokenForm({ fixedOwner, onDone, onCancel }: { fixedOwner?: string | null; onDone(): Promise<void>; onCancel?: () => void }) {
  const [owner, setOwner] = useState('');
  const [value, setValue] = useState('');
  const save = useAction(async () => {
    const o = fixedOwner === undefined ? owner.trim() : fixedOwner;
    await api('PUT', '/me/credentials/github_token', { value, ...(o ? { owner: o } : {}) });
    setValue('');
    setOwner('');
    await onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run();
  };
  return (
    <form className="form gh-token-form" onSubmit={submit}>
      <div className="form-row">
        {fixedOwner === undefined && (
          <label>
            GitHub organization or user
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Leave empty for the default token" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <label style={{ flex: '2 1 220px' }}>
          GitHub personal access token
          <input type="password" autoComplete="off" spellCheck={false} required value={value} placeholder="github_pat_…" onChange={(e) => setValue(e.target.value)} />
        </label>
      </div>
      {save.error && <div className="error">{save.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={save.pending}>Save token</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
