import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type AuditRow as BaseAuditRow, type UserRow } from '../api';
import { useAuth } from '../auth';
import { useResource } from '../hooks';

const PAGE = 50;

interface AuditRow extends BaseAuditRow {
  actorId: string | null;
  clientName: string | null;
  applicationName: string | null;
  environmentName: string | null;
}

/** Common action groups; the API filters by prefix. */
const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'All actions' },
  { value: 'auth.', label: 'Sign-in and sessions' },
  { value: 'mfa.', label: 'Two-step login' },
  { value: 'user.', label: 'Developers' },
  { value: 'grant.', label: 'Access grants' },
  { value: 'client.', label: 'Clients' },
  { value: 'application.', label: 'Applications' },
  { value: 'environment.', label: 'Environments' },
  { value: 'repository.', label: 'Repositories' },
  { value: 'workspace.', label: 'Workspaces' },
  { value: 'git.', label: 'Git (commit, push, PR)' },
  { value: 'agent.', label: 'Claude runs' },
  { value: 'terminal.', label: 'Terminal' },
  { value: 'variable.', label: 'Variables and secrets' },
  { value: 'network.', label: 'Network access' },
  { value: 'aws.', label: 'AWS' },
  { value: 'credential.', label: 'Claude and GitHub credentials' },
  { value: 'settings.', label: 'Personal settings' },
  { value: 'org.', label: 'Organisation settings' },
  { value: 'budget.', label: 'Budgets' },
  { value: 'audit.', label: 'Audit exports' },
];

const FILTER_KEYS = ['action', 'outcome', 'from', 'to', 'actorId'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

function toQuery(f: Filters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

const where = (r: AuditRow) => [r.clientName, r.applicationName, r.environmentName].filter(Boolean).join(' / ');

export function AuditPage() {
  const { me } = useAuth();
  const isAdmin = !!me?.user.isOrgAdmin;
  // Filters live in the URL, so a filtered view can be bookmarked or shared with another admin.
  const [params, setParams] = useSearchParams();
  const filters = useMemo<Filters>(
    () => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Filters,
    [params],
  );
  const query = toQuery(filters);
  const users = useResource<UserRow[]>(isAdmin ? '/users' : null);

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = async (before?: string) => {
    setLoading(true);
    try {
      const page = await api<AuditRow[]>('GET', `/audit?${toQuery(filters, { limit: PAGE, ...(before ? { before } : {}) })}`);
      setRows((prev) => (before ? [...prev, ...page] : page));
      setDone(page.length < PAGE);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, query]);

  if (!isAdmin) return <p className="muted">Only org admins can read the audit log.</p>;

  const set = (key: FilterKey, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const active = FILTER_KEYS.some((k) => filters[k]);
  const knownGroup = ACTION_GROUPS.some((g) => g.value === filters.action);

  return (
    <div className="stack audit">
      <div className="page-head audit-head">
        <div>
          <h1>Audit log</h1>
          <div className="muted">
            Sign-ins, access changes, git actions, Claude runs and terminal sessions. Times are in your time zone; the date filters use UTC days.
          </div>
        </div>
        <a className="btn" href={`/api/audit/export.csv${query ? `?${query}` : ''}`} download>Export CSV</a>
      </div>

      <form className="card audit-filters" role="search" aria-label="Filter the audit log" onSubmit={(e) => e.preventDefault()}>
        <label>
          Action
          <select value={filters.action} onChange={(e) => set('action', e.target.value)}>
            {ACTION_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            {!knownGroup && <option value={filters.action}>{filters.action}</option>}
          </select>
        </label>
        <label>
          Outcome
          <select value={filters.outcome} onChange={(e) => set('outcome', e.target.value)}>
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <label>
          Who
          <select value={filters.actorId} onChange={(e) => set('actorId', e.target.value)}>
            <option value="">Everyone</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}
          </select>
        </label>
        <label>
          From (UTC)
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          To (UTC)
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
        </label>
        <div className="audit-filter-actions">
          <button type="button" disabled={!active} onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</button>
        </div>
      </form>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="card table-wrap audit-card">
        <table className="audit-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Where</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const details = Object.keys(r.details).length ? JSON.stringify(r.details) : '';
              return (
                <tr key={r.id}>
                  <td data-label="When" className="muted audit-when">{new Date(r.occurredAt).toLocaleString()}</td>
                  <td data-label="Who" className="audit-who">{r.actorEmail ?? <span className="muted">system</span>}</td>
                  <td data-label="Action" className="mono">{r.action}</td>
                  <td data-label="Outcome">{r.outcome === 'success' ? <span className="badge ok">success</span> : <span className="badge warn">{r.outcome}</span>}</td>
                  <td data-label="Where" className="audit-where">{where(r) || <span className="muted">-</span>}</td>
                  <td data-label="Details" className="mono muted audit-details" title={details || undefined}>{details}</td>
                </tr>
              );
            })}
            {!rows.length && !loading && (
              <tr className="audit-empty"><td colSpan={6} className="muted">{active ? 'No events match these filters.' : 'No events yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {!done && rows.length > 0 && (
        <button className="audit-more" disabled={loading} onClick={() => void load(rows[rows.length - 1]!.id)}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}
