import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';

// ---- API shapes (GET /api/org, GET /api/org/budgets) --------------------------

interface OrgSettings { id: string; name: string; slug: string; monthlyBudgetUsd: number | null; canManage: boolean }

interface BudgetRow {
  userId: string; email: string; displayName: string; status: 'active' | 'disabled';
  overrideUsd: number | null; limitUsd: number | null; spentUsd: number; allowed: boolean;
}
interface Budgets { month: string; defaultUsd: number | null; users: BudgetRow[] }

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : usd.format(n));
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** '' means "no value"; otherwise a non-negative amount with at most two decimals. */
function parseAmount(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return undefined;
  return Number(t);
}

export function OrgSettingsPage() {
  const { me, refresh } = useAuth();
  const isAdmin = !!me?.user.isOrgAdmin;
  const org = useResource<OrgSettings>(isAdmin ? '/org' : null);
  const budgets = useResource<Budgets>(isAdmin ? '/org/budgets' : null);

  if (!isAdmin) return <p className="muted">Only org admins can change organisation settings.</p>;

  return (
    <div className="stack org-settings">
      <div className="page-head">
        <div>
          <h1>Organisation</h1>
          <div className="muted">Name and monthly Claude budgets for each developer.</div>
        </div>
      </div>
      {org.error && <div className="error">{org.error.message}</div>}
      {org.data && (
        <OrgForm
          org={org.data}
          onSaved={async () => {
            await Promise.all([org.reload(), budgets.reload(), refresh()]);
          }}
        />
      )}
      <section className="card stack" aria-labelledby="budgets-title">
        <div>
          <h2 id="budgets-title" style={{ margin: 0 }}>Developer budgets{budgets.data && ` · ${monthName(budgets.data.month)}`}</h2>
          <p className="muted org-note">
            Spend is the cost of Claude conversations started this month (UTC). Leave a developer's limit empty to use the
            organisation default. Each single run is also capped by the server's per-run limit.
          </p>
        </div>
        {budgets.error && <div className="error">{budgets.error.message}</div>}
        {budgets.loading && !budgets.data && <div className="muted">Loading…</div>}
        {budgets.data && (
          <div className="table-wrap">
            <table className="org-budgets">
              <thead>
                <tr><th>Developer</th><th className="num">Spent</th><th className="num">Limit</th><th>Own limit (USD)</th></tr>
              </thead>
              <tbody>
                {budgets.data.users.map((u) => (
                  <BudgetRowView key={u.userId} row={u} defaultUsd={budgets.data!.defaultUsd} onSaved={() => budgets.reload()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function OrgForm({ org, onSaved }: { org: OrgSettings; onSaved(): Promise<void> }) {
  const [name, setName] = useState(org.name);
  const [budget, setBudget] = useState(org.monthlyBudgetUsd === null ? '' : String(org.monthlyBudgetUsd));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(org.name);
    setBudget(org.monthlyBudgetUsd === null ? '' : String(org.monthlyBudgetUsd));
  }, [org.name, org.monthlyBudgetUsd]);

  const save = useAction(async () => {
    const amount = parseAmount(budget);
    if (amount === undefined) throw new Error('Enter the default budget in dollars, e.g. 50 or 49.99, or leave it empty for no limit.');
    await api('PATCH', '/org', { name: name.trim(), monthlyBudgetUsd: amount });
    setSaved(true);
    await onSaved();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void save.run();
  };

  return (
    <form className="card form org-form" onSubmit={submit}>
      <h2 style={{ margin: 0 }}>Settings</h2>
      <div className="form-row">
        <label>Organisation name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          Default monthly budget per developer (USD)
          <input inputMode="decimal" placeholder="No limit" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby="org-budget-help" />
        </label>
      </div>
      <div id="org-budget-help" className="muted org-note">
        When a developer reaches their limit, new Claude runs are refused until the next month or until you raise it. Empty means no limit.
      </div>
      {save.error && <div className="error" role="alert">{save.error}</div>}
      {saved && <div className="badge ok mfa-notice" role="status">Saved.</div>}
      <div><button className="primary" disabled={save.pending}>Save</button></div>
    </form>
  );
}

function BudgetRowView({ row, defaultUsd, onSaved }: { row: BudgetRow; defaultUsd: number | null; onSaved(): Promise<void> }) {
  const [value, setValue] = useState(row.overrideUsd === null ? '' : String(row.overrideUsd));
  useEffect(() => setValue(row.overrideUsd === null ? '' : String(row.overrideUsd)), [row.overrideUsd]);
  const save = useAction(async () => {
    const amount = parseAmount(value);
    if (amount === undefined) throw new Error('Use a dollar amount such as 25 or 25.50');
    await api('PUT', `/org/budgets/${row.userId}`, { monthlyBudgetUsd: amount });
    await onSaved();
  });
  const dirty = value.trim() !== (row.overrideUsd === null ? '' : String(row.overrideUsd));
  const pct = row.limitUsd ? Math.min(100, (row.spentUsd / row.limitUsd) * 100) : 0;

  return (
    <tr className={row.status === 'disabled' ? 'muted' : undefined}>
      <td data-label="Developer">
        <div>{row.displayName}{row.status === 'disabled' && <span className="badge" style={{ marginLeft: 6 }}>disabled</span>}</div>
        <div className="muted org-email">{row.email}</div>
      </td>
      <td data-label="Spent" className="num">
        {money(row.spentUsd)}
        {row.limitUsd !== null && (
          <div className={`budget-meter${row.allowed ? '' : ' over'}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${Math.round(pct)}% of limit used`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </td>
      <td data-label="Limit" className="num">
        {row.limitUsd === null ? <span className="muted">No limit</span> : money(row.limitUsd)}
        {!row.allowed && <div><span className="badge warn">limit reached</span></div>}
        {row.overrideUsd === null && row.limitUsd !== null && <div className="muted org-note">default</div>}
      </td>
      <td data-label="Own limit">
        <form className="org-override" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <input
            inputMode="decimal"
            aria-label={`Monthly limit for ${row.displayName} in US dollars`}
            placeholder={defaultUsd === null ? 'No limit' : `Default (${money(defaultUsd)})`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="small" disabled={!dirty || save.pending}>Save</button>
        </form>
        {save.error && <div className="error">{save.error}</div>}
      </td>
    </tr>
  );
}
