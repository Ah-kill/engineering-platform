import { useEffect, useState } from 'react';
import { api, type AuditRow } from '../api';
import { useAuth } from '../auth';

const PAGE = 50;

export function AuditPage() {
  const { me } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  const load = async (before?: string) => {
    try {
      const page = await api<AuditRow[]>('GET', `/audit?limit=${PAGE}${before ? `&before=${before}` : ''}`);
      setRows((prev) => (before ? [...prev, ...page] : page));
      setDone(page.length < PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  };

  useEffect(() => {
    if (me?.user.isOrgAdmin) void load();
  }, [me]);

  if (!me?.user.isOrgAdmin) return <p className="muted">Only org admins can read the audit log.</p>;

  return (
    <div className="stack">
      <div className="page-head"><h1>Audit log</h1></div>
      {error && <div className="error">{error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(r.occurredAt).toLocaleString()}</td>
                <td>{r.actorEmail ?? <span className="muted">system</span>}</td>
                <td className="mono">{r.action}</td>
                <td>{r.outcome === 'success' ? <span className="badge ok">success</span> : <span className="badge warn">{r.outcome}</span>}</td>
                <td className="mono muted" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {Object.keys(r.details).length ? JSON.stringify(r.details) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!done && rows.length > 0 && <button onClick={() => void load(rows[rows.length - 1]!.id)}>Load older</button>}
    </div>
  );
}
