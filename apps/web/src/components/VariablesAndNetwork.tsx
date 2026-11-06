import { useEffect, useState, type FormEvent } from 'react';
import { api, type EnvironmentRow } from '../api';
import { useAction, useResource } from '../hooks';

interface Variable {
  id: string;
  name: string;
  isSecret: boolean;
  value: string | null;
  hint: string;
  description: string;
  updatedAt: string;
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Per-environment variables and secrets. Nothing here is specific to any service. */
export function VariablesCard({ environments, isOrgAdmin }: { environments: EnvironmentRow[]; isOrgAdmin: boolean }) {
  const [envId, setEnvId] = useState(environments[0]?.id ?? '');
  useEffect(() => {
    if (!environments.some((e) => e.id === envId) && environments[0]) setEnvId(environments[0].id);
  }, [environments, envId]);
  const env = environments.find((e) => e.id === envId);
  const vars = useResource<Variable[]>(envId ? `/environments/${envId}/variables` : null);
  const canEdit = !!env && env.permissions.includes('environment.manage') && (!env.protected || isOrgAdmin);
  const [editing, setEditing] = useState<{ name: string; value: string; isSecret: boolean; description: string; existing: boolean } | null>(null);
  const [importing, setImporting] = useState(false);

  const remove = useAction(async (name: string) => {
    await api('DELETE', `/environments/${envId}/variables/${name}`);
    await vars.reload();
  });

  if (!environments.length) return null;

  return (
    <div className="card stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h2 style={{ margin: 0 }}>Environment variables</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            API keys, URLs and settings for any service this app uses. Claude and the commands it runs get them in this environment's workspaces; they are never written into the code.
          </div>
        </div>
      </div>

      <div className="segmented" role="tablist" aria-label="Environment">
        {environments.map((e) => (
          <button key={e.id} role="tab" aria-selected={e.id === envId} className={e.id === envId ? 'on' : ''} onClick={() => { setEnvId(e.id); setEditing(null); setImporting(false); }}>
            {e.name}{e.protected ? ' 🔒' : ''}
          </button>
        ))}
      </div>

      {env?.protected && !isOrgAdmin && <div className="muted" style={{ fontSize: 13 }}>Only an org admin can change variables of a protected environment.</div>}

      {vars.data && vars.data.length === 0 && !editing && <p className="muted" style={{ margin: 0 }}>No variables in {env?.name} yet.</p>}
      {vars.data && vars.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Value</th><th>Description</th><th /></tr></thead>
            <tbody>
              {vars.data.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.name}</td>
                  <td className="mono var-value">
                    {v.isSecret ? <span className="badge warn" title="Encrypted; not shown again">secret {v.hint}</span> : v.value}
                  </td>
                  <td className="muted">{v.description}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button className="small" onClick={() => setEditing({ name: v.name, value: v.isSecret ? '' : v.value ?? '', isSecret: v.isSecret, description: v.description, existing: true })}>Edit</button>{' '}
                        <button className="small danger" aria-label={`Delete ${v.name}`} disabled={remove.pending}
                          onClick={() => { if (confirm(`Delete ${v.name} from ${env?.name}?`)) void remove.run(v.name); }}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove.error && <div className="error">{remove.error}</div>}

      {canEdit && !editing && !importing && (
        <div className="form-row">
          <button className="small primary" onClick={() => setEditing({ name: '', value: '', isSecret: true, description: '', existing: false })}>Add variable</button>
          <button className="small" onClick={() => setImporting(true)}>Import .env</button>
        </div>
      )}

      {editing && (
        <VariableForm envId={envId} initial={editing} onDone={async () => { setEditing(null); await vars.reload(); }} />
      )}
      {importing && <ImportForm envId={envId} onDone={async () => { setImporting(false); await vars.reload(); }} />}
    </div>
  );
}

function VariableForm({ envId, initial, onDone }: {
  envId: string;
  initial: { name: string; value: string; isSecret: boolean; description: string; existing: boolean };
  onDone(): Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState(initial.value);
  const [isSecret, setIsSecret] = useState(initial.isSecret);
  const [description, setDescription] = useState(initial.description);
  const save = useAction(async () => {
    await api('PUT', `/environments/${envId}/variables/${name}`, { value, isSecret, description });
    await onDone();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run();
  };
  const nameOk = NAME_RE.test(name);
  return (
    <form className="form card" onSubmit={submit}>
      <div className="form-row">
        <label>
          Name
          <input required value={name} readOnly={initial.existing} spellCheck={false} placeholder="PAYMENT_API_KEY"
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
        </label>
        <label style={{ flex: '2 1 240px' }}>
          {initial.existing && initial.isSecret ? 'New value' : 'Value'}
          {isSecret ? (
            <input type="password" required autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={initial.existing && initial.isSecret ? 'Enter the new value' : ''} />
          ) : (
            <input required spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </label>
      </div>
      <label>Description (optional)<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is for" /></label>
      <label className="checkbox">
        <input type="checkbox" checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} />
        Secret: encrypted, never shown again, hidden from anything Claude prints
      </label>
      {!nameOk && name && <div className="error">Use upper-case letters, digits and underscores.</div>}
      {save.error && <div className="error">{save.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={save.pending || !nameOk}>Save</button>
        <button type="button" onClick={() => void onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function ImportForm({ envId, onDone }: { envId: string; onDone(): Promise<void> }) {
  const [text, setText] = useState('');
  const [isSecret, setIsSecret] = useState(true);
  const save = useAction(async () => {
    await api('POST', `/environments/${envId}/variables/import`, { text, isSecret });
    await onDone();
  });
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <label>
        Paste the contents of a .env file
        <textarea required rows={6} spellCheck={false} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={'API_BASE_URL=https://api.example.com\nSERVICE_KEY=...'} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} />
        Store all of them as secrets
      </label>
      {save.error && <div className="error">{save.error}</div>}
      <div className="form-row">
        <button className="primary" disabled={save.pending}>Import</button>
        <button type="button" onClick={() => void onDone()}>Cancel</button>
      </div>
    </form>
  );
}

interface NetworkPolicy { mode: 'restricted' | 'open'; hosts: string[]; builtin: string[] }

export function NetworkCard({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const policy = useResource<NetworkPolicy>(`/applications/${appId}/network`);
  const [mode, setMode] = useState<'restricted' | 'open'>('restricted');
  const [hosts, setHosts] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (policy.data) {
      setMode(policy.data.mode);
      setHosts(policy.data.hosts.join('\n'));
    }
  }, [policy.data]);

  const save = useAction(async () => {
    await api('PUT', `/applications/${appId}/network`, { mode, hosts: hosts.split(/[\s,]+/).filter(Boolean) });
    setSaved(true);
    await policy.reload();
  });

  if (!policy.data) return null;

  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }}>
      <div>
        <h2 style={{ margin: 0 }}>Network access</h2>
        <div className="muted" style={{ fontSize: 13 }}>Which sites this application's workspaces may reach. Applies from the next Claude run.</div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <label className="checkbox">
          <input type="radio" name="egress" checked={mode === 'restricted'} disabled={!canEdit} onChange={() => setMode('restricted')} />
          <span><b>Only allowed sites</b> (recommended)</span>
        </label>
        <label className="checkbox">
          <input type="radio" name="egress" checked={mode === 'open'} disabled={!canEdit} onChange={() => setMode('open')} />
          <span><b>Unrestricted</b>: any site on the internet</span>
        </label>
      </div>
      {mode === 'restricted' && (
        <>
          <div className="muted" style={{ fontSize: 13 }}>
            Always allowed: {policy.data.builtin.map((h) => <code key={h} className="host-chip">{h}</code>)}
          </div>
          <label>
            Also allow (one per line: <code>api.example.com</code>, <code>*.example.com</code> or <code>host:port</code>)
            <textarea rows={4} spellCheck={false} className="mono" value={hosts} readOnly={!canEdit} onChange={(e) => setHosts(e.target.value)} placeholder={'api.example.com\n*.example.org'} />
          </label>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Web (HTTP/HTTPS) traffic only. Addresses on your own network are always blocked. If Claude reports a blocked host, add it here.
          </div>
        </>
      )}
      {save.error && <div className="error">{save.error}</div>}
      {saved && !save.error && <div className="badge ok" style={{ justifySelf: 'start' }}>Saved. Takes effect from the next Claude run.</div>}
      {canEdit && <div><button className="primary" disabled={save.pending}>Save network access</button></div>}
    </form>
  );
}
